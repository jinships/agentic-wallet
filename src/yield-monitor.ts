import type { Address } from "viem";
import type { ReadContractClient } from "./protocols/index.js";
import {
  type YieldProtocol,
  type ProtocolSnapshot,
  type YieldComparison,
  AaveProtocol,
  CompoundProtocol,
  MorphoProtocol,
  MoonwellProtocol,
} from "./protocols/index.js";
import { fetchDeFiLlamaRates } from "./protocols/defillama.js";
import { RateHistory, getRateHistory, type RateAnomaly } from "./rate-history.js";
import { Logger, createYieldMonitorLogger } from "./logger.js";
import { YIELD_CONFIG } from "./config.js";

export interface YieldMonitorConfig {
  /** Use TWAP instead of spot rates for comparison (default: true) */
  useTWAP: boolean;
  /** Hours of data to use for TWAP calculation (default: 1) */
  twapWindowHours: number;
  /** Enable anomaly detection (default: true) */
  enableAnomalyDetection: boolean;
  /** Use DeFiLlama as fallback when on-chain reads fail (default: true) */
  useDeFiLlamaFallback: boolean;
  /** Max age of rate data before considered stale (default: 2 hours) */
  rateStalenesMs: number;
}

const DEFAULT_CONFIG: YieldMonitorConfig = {
  useTWAP: true,
  twapWindowHours: 1,
  enableAnomalyDetection: true,
  useDeFiLlamaFallback: true,
  rateStalenesMs: YIELD_CONFIG.RATE_STALENESS_MS,
};

/**
 * Extended comparison result with protection metadata.
 */
export interface ProtectedYieldComparison extends YieldComparison {
  /** Whether TWAP was used for comparison */
  twapUsed: boolean;
  /** Anomalies detected during comparison */
  anomalies: Map<YieldProtocol["id"], RateAnomaly>;
  /** Reason rebalance was blocked (if any) */
  rejectReason?: string;
  /** Data source used */
  dataSource: "onchain" | "defillama" | "mixed";
}

/**
 * YieldMonitor polls all supported protocols and determines the optimal
 * yield strategy based on current APY rates.
 *
 * Enhanced with:
 * - DeFiLlama fallback for rate data
 * - TWAP-based comparisons to prevent rate manipulation
 * - Anomaly detection for suspicious rate changes
 * - Structured logging
 */
export class YieldMonitor {
  private readonly protocols: YieldProtocol[];
  private readonly config: YieldMonitorConfig;
  private readonly rateHistory: RateHistory;
  private readonly logger: Logger;
  private lastComparison: ProtectedYieldComparison | null = null;

  constructor(
    client: ReadContractClient,
    config?: Partial<YieldMonitorConfig>
  ) {
    this.protocols = [
      new AaveProtocol(client),
      new CompoundProtocol(client),
      new MorphoProtocol(client),
      new MoonwellProtocol(client),
    ];
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rateHistory = getRateHistory();
    this.logger = createYieldMonitorLogger();
  }

  /**
   * Get all supported protocols.
   */
  getProtocols(): readonly YieldProtocol[] {
    return this.protocols;
  }

  /**
   * Get a specific protocol by ID.
   */
  getProtocol(id: YieldProtocol["id"]): YieldProtocol | undefined {
    return this.protocols.find((p) => p.id === id);
  }

  /**
   * Take a snapshot of all protocols' current state.
   * Uses on-chain data with DeFiLlama fallback.
   */
  async getSnapshots(vault: Address): Promise<{
    snapshots: ProtocolSnapshot[];
    dataSource: "onchain" | "defillama" | "mixed";
  }> {
    const results: ProtocolSnapshot[] = [];
    let onchainCount = 0;
    let defillamaCount = 0;

    // Try on-chain reads first
    const onchainResults = await Promise.allSettled(
      this.protocols.map(async (protocol) => {
        const [apyPercent, balance] = await Promise.all([
          protocol.getAPY(),
          protocol.getBalance(vault),
        ]);
        return {
          protocolId: protocol.id,
          protocolName: protocol.name,
          address: protocol.address,
          apyPercent,
          balance,
          timestamp: Date.now(),
          source: "onchain" as const,
        };
      })
    );

    // Get DeFiLlama rates as potential fallback
    let defillamaRates: Map<YieldProtocol["id"], number> | null = null;
    if (this.config.useDeFiLlamaFallback) {
      try {
        const defillamaData = await fetchDeFiLlamaRates();
        defillamaRates = defillamaData.rates;
      } catch (error) {
        this.logger.logError(
          error instanceof Error ? error : new Error(String(error)),
          { context: "defillama_fetch" }
        );
      }
    }

    // Process results, using fallback where needed
    for (let i = 0; i < this.protocols.length; i++) {
      const protocol = this.protocols[i];
      const result = onchainResults[i];

      if (result.status === "fulfilled") {
        results.push(result.value);
        onchainCount++;

        // Record in history
        this.rateHistory.record({
          protocolId: protocol.id,
          apy: result.value.apyPercent,
          timestamp: result.value.timestamp,
          source: "onchain",
        });
      } else {
        // On-chain failed, try DeFiLlama fallback
        const defillamaApy = defillamaRates?.get(protocol.id);

        if (defillamaApy !== undefined) {
          // Use DeFiLlama rate, but we still need balance from chain
          // If balance read also failed, assume 0
          let balance = 0n;
          try {
            balance = await protocol.getBalance(vault);
          } catch {
            // Balance read failed, use 0
          }

          results.push({
            protocolId: protocol.id,
            protocolName: protocol.name,
            address: protocol.address,
            apyPercent: defillamaApy,
            balance,
            timestamp: Date.now(),
          });
          defillamaCount++;

          this.rateHistory.record({
            protocolId: protocol.id,
            apy: defillamaApy,
            timestamp: Date.now(),
            source: "defillama",
          });
        } else {
          // Both sources failed, use last known rate from history
          const lastRate = this.rateHistory.getLatestRate(protocol.id);

          this.logger.logError(
            `Failed to get rate for ${protocol.name}`,
            {
              protocolId: protocol.id,
              onchainError: result.reason,
              defillamaAvailable: !!defillamaRates,
              lastKnownRate: lastRate?.apy,
            }
          );

          results.push({
            protocolId: protocol.id,
            protocolName: protocol.name,
            address: protocol.address,
            apyPercent: lastRate?.apy ?? 0,
            balance: 0n,
            timestamp: Date.now(),
          });
        }
      }
    }

    const dataSource: "onchain" | "defillama" | "mixed" =
      defillamaCount === 0
        ? "onchain"
        : onchainCount === 0
          ? "defillama"
          : "mixed";

    return { snapshots: results, dataSource };
  }

  /**
   * Compare yields across all protocols with protection mechanisms.
   */
  async compareYields(vault: Address): Promise<ProtectedYieldComparison> {
    const { snapshots, dataSource } = await this.getSnapshots(vault);
    const timestamp = Date.now();
    const anomalies = new Map<YieldProtocol["id"], RateAnomaly>();

    // Check for anomalies if enabled
    if (this.config.enableAnomalyDetection) {
      for (const snapshot of snapshots) {
        const anomaly = this.rateHistory.detectAnomalies(
          snapshot.protocolId,
          snapshot.apyPercent
        );

        if (anomaly.suspicious) {
          anomalies.set(snapshot.protocolId, anomaly);
          this.logger.logAnomaly(snapshot.protocolId, anomaly, "warned");
        }
      }
    }

    // Use TWAP if enabled and we have history
    let effectiveSnapshots = snapshots;
    let twapUsed = false;

    if (this.config.useTWAP) {
      effectiveSnapshots = snapshots.map((snapshot) => {
        const twapResult = this.rateHistory.getTWAP(
          snapshot.protocolId,
          this.config.twapWindowHours
        );

        if (twapResult && twapResult.sampleCount >= 2) {
          twapUsed = true;
          return {
            ...snapshot,
            apyPercent: twapResult.twap,
          };
        }
        return snapshot;
      });
    }

    // Find the best protocol (highest APY)
    const bestProtocol = effectiveSnapshots.reduce((best, current) =>
      current.apyPercent > best.apyPercent ? current : best
    );

    // Find where the vault currently has funds (if any)
    const currentProtocol =
      effectiveSnapshots.find((s) => s.balance > 0n) || null;

    // Calculate APY differential in basis points
    const currentApy = currentProtocol?.apyPercent ?? 0;
    const apyDifferentialBps = Math.round(
      (bestProtocol.apyPercent - currentApy) * 10000
    );

    // Determine if we should rebalance with protection checks
    let shouldRebalance = false;
    let rejectReason: string | undefined;

    if (currentProtocol === null) {
      rejectReason = "no_funds_to_move";
    } else if (currentProtocol.protocolId === bestProtocol.protocolId) {
      rejectReason = "already_in_best_protocol";
    } else if (apyDifferentialBps < YIELD_CONFIG.MIN_APY_DIFFERENTIAL_BPS) {
      rejectReason = "apy_differential_below_threshold";
    } else if (anomalies.has(bestProtocol.protocolId)) {
      rejectReason = "target_protocol_anomaly_detected";
    } else {
      shouldRebalance = true;
    }

    const comparison: ProtectedYieldComparison = {
      snapshots: effectiveSnapshots,
      bestProtocol,
      currentProtocol,
      apyDifferentialBps,
      shouldRebalance,
      timestamp,
      twapUsed,
      anomalies,
      rejectReason,
      dataSource,
    };

    this.lastComparison = comparison;

    // Log the rate check
    this.logger.logRateCheck(comparison, {
      rejectReason,
      twapUsed,
      anomalyDetected: anomalies.size > 0,
    });

    return comparison;
  }

  /**
   * Get the last comparison result without fetching new data.
   */
  getLastComparison(): ProtectedYieldComparison | null {
    return this.lastComparison;
  }

  /**
   * Get the rate history instance for inspection.
   */
  getRateHistory(): RateHistory {
    return this.rateHistory;
  }

  /**
   * Format a comparison for display.
   */
  formatComparison(comparison: ProtectedYieldComparison): string {
    const lines: string[] = [];

    lines.push("=== Yield Comparison ===");
    lines.push(`Data source: ${comparison.dataSource}${comparison.twapUsed ? " (TWAP)" : ""}`);
    lines.push("");

    // Sort by APY descending
    const sorted = [...comparison.snapshots].sort(
      (a, b) => b.apyPercent - a.apyPercent
    );

    for (const snapshot of sorted) {
      const apyStr = (snapshot.apyPercent * 100).toFixed(2);
      const balanceStr = formatUSDC(snapshot.balance);
      const anomaly = comparison.anomalies.get(snapshot.protocolId);
      const marker =
        snapshot.protocolId === comparison.bestProtocol.protocolId
          ? " [BEST]"
          : snapshot.protocolId === comparison.currentProtocol?.protocolId
            ? " [CURRENT]"
            : "";
      const warning = anomaly?.suspicious ? " [ANOMALY]" : "";

      lines.push(
        `${snapshot.protocolName}: ${apyStr}% APY, $${balanceStr}${marker}${warning}`
      );
    }

    lines.push("");
    lines.push(
      `APY Differential: ${comparison.apyDifferentialBps} bps (${(comparison.apyDifferentialBps / 100).toFixed(2)}%)`
    );

    if (comparison.rejectReason) {
      lines.push(`Rebalance: NO (${comparison.rejectReason})`);
    } else {
      lines.push(`Rebalance: ${comparison.shouldRebalance ? "YES" : "NO"}`);
    }

    if (comparison.shouldRebalance && comparison.currentProtocol) {
      lines.push("");
      lines.push(
        `Recommended: Move from ${comparison.currentProtocol.protocolName} to ${comparison.bestProtocol.protocolName}`
      );
    }

    return lines.join("\n");
  }
}

/**
 * Format USDC amount (6 decimals) for display.
 */
function formatUSDC(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = amount % 1_000_000n;
  const fracStr = frac.toString().padStart(6, "0").slice(0, 2);
  return `${whole.toLocaleString()}.${fracStr}`;
}

/**
 * Rebalancing proposal for the agent to submit.
 */
export interface RebalanceProposal {
  fromProtocol: YieldProtocol["id"];
  toProtocol: YieldProtocol["id"];
  amount: bigint;
  expectedApyGainBps: number;
  withdrawCalldata: `0x${string}`;
  depositCalldata: `0x${string}`;
}

/**
 * Generate a rebalance proposal if warranted by the yield comparison.
 */
export function createRebalanceProposal(
  monitor: YieldMonitor,
  comparison: ProtectedYieldComparison,
  vault: Address
): RebalanceProposal | null {
  if (!comparison.shouldRebalance || !comparison.currentProtocol) {
    return null;
  }

  const fromProtocol = monitor.getProtocol(comparison.currentProtocol.protocolId);
  const toProtocol = monitor.getProtocol(comparison.bestProtocol.protocolId);

  if (!fromProtocol || !toProtocol) {
    return null;
  }

  const amount = comparison.currentProtocol.balance;

  return {
    fromProtocol: comparison.currentProtocol.protocolId,
    toProtocol: comparison.bestProtocol.protocolId,
    amount,
    expectedApyGainBps: comparison.apyDifferentialBps,
    withdrawCalldata: fromProtocol.encodeWithdraw(amount, vault),
    depositCalldata: toProtocol.encodeDeposit(amount, vault),
  };
}
