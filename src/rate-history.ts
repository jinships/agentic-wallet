/**
 * Rate History - TWAP calculation and anomaly detection for yield rates.
 *
 * Protects against rate manipulation attacks by:
 * 1. Using time-weighted average prices (TWAP) instead of spot rates
 * 2. Detecting suspicious rate velocity changes
 * 3. Flagging anomalies that could indicate manipulation
 */

import type { YieldProtocol } from './protocols/index.js';

export interface RateEntry {
  protocolId: YieldProtocol['id'];
  apy: number;
  timestamp: number;
  source: 'onchain' | 'defillama';
}

export interface RateAnomaly {
  suspicious: boolean;
  reason?: string;
  severity?: 'low' | 'medium' | 'high';
  details?: {
    currentRate: number;
    previousRate: number;
    changePercent: number;
    timeWindowMs: number;
  };
}

export interface TWAPResult {
  twap: number;
  sampleCount: number;
  oldestSample: number;
  newestSample: number;
}

// Configuration
const DEFAULT_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES_PER_PROTOCOL = 1000; // Prevent unbounded growth
const RATE_VELOCITY_THRESHOLD = 0.5; // 50% change = suspicious
const RATE_VELOCITY_WINDOW_MS = 60 * 60 * 1000; // 1 hour window for velocity check

export class RateHistory {
  private history: Map<YieldProtocol['id'], RateEntry[]> = new Map();
  private readonly windowMs: number;

  constructor(windowMs: number = DEFAULT_HISTORY_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * Record a new rate entry.
   */
  record(entry: RateEntry): void {
    const entries = this.history.get(entry.protocolId) ?? [];

    // Add new entry
    entries.push(entry);

    // Prune old entries outside the window
    const cutoff = Date.now() - this.windowMs;
    const pruned = entries.filter((e) => e.timestamp >= cutoff);

    // Also limit total entries to prevent memory issues
    const limited =
      pruned.length > MAX_ENTRIES_PER_PROTOCOL ? pruned.slice(-MAX_ENTRIES_PER_PROTOCOL) : pruned;

    this.history.set(entry.protocolId, limited);
  }

  /**
   * Get all entries for a protocol within a time window.
   */
  getEntries(protocolId: YieldProtocol['id'], windowMs?: number): RateEntry[] {
    const entries = this.history.get(protocolId) ?? [];
    const cutoff = Date.now() - (windowMs ?? this.windowMs);
    return entries.filter((e) => e.timestamp >= cutoff);
  }

  /**
   * Calculate Time-Weighted Average Price (TWAP) for a protocol.
   *
   * @param protocolId - The protocol to calculate TWAP for
   * @param windowHours - Number of hours to include in TWAP (default: 1)
   * @returns TWAP result with metadata, or null if insufficient data
   */
  getTWAP(protocolId: YieldProtocol['id'], windowHours: number = 1): TWAPResult | null {
    const windowMs = windowHours * 60 * 60 * 1000;
    const entries = this.getEntries(protocolId, windowMs);

    if (entries.length === 0) {
      return null;
    }

    if (entries.length === 1) {
      return {
        twap: entries[0].apy,
        sampleCount: 1,
        oldestSample: entries[0].timestamp,
        newestSample: entries[0].timestamp,
      };
    }

    // Sort by timestamp
    const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);

    // Calculate time-weighted average
    let weightedSum = 0;
    let totalWeight = 0;

    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];
      const weight = next.timestamp - current.timestamp;

      weightedSum += current.apy * weight;
      totalWeight += weight;
    }

    // Add the last entry with a small weight (time since last sample)
    const lastEntry = sorted[sorted.length - 1];
    const timeSinceLast = Math.min(
      Date.now() - lastEntry.timestamp,
      60 * 60 * 1000 // Cap at 1 hour
    );
    weightedSum += lastEntry.apy * timeSinceLast;
    totalWeight += timeSinceLast;

    const twap = totalWeight > 0 ? weightedSum / totalWeight : lastEntry.apy;

    return {
      twap,
      sampleCount: sorted.length,
      oldestSample: sorted[0].timestamp,
      newestSample: lastEntry.timestamp,
    };
  }

  /**
   * Detect rate anomalies that could indicate manipulation.
   *
   * Checks:
   * 1. Rate velocity - sudden large changes
   * 2. Deviation from TWAP - current rate far from average
   * 3. Insufficient data - not enough history to trust
   */
  detectAnomalies(protocolId: YieldProtocol['id'], currentRate?: number): RateAnomaly {
    const entries = this.getEntries(protocolId, RATE_VELOCITY_WINDOW_MS);

    // Insufficient data to detect anomalies
    if (entries.length < 2) {
      return {
        suspicious: false,
        reason: 'insufficient_data',
        severity: 'low',
      };
    }

    const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
    const latest = currentRate ?? sorted[sorted.length - 1].apy;
    const oldest = sorted[0].apy;

    // Check rate velocity
    if (oldest > 0) {
      const changePercent = Math.abs(latest - oldest) / oldest;

      if (changePercent > RATE_VELOCITY_THRESHOLD) {
        return {
          suspicious: true,
          reason: 'high_rate_velocity',
          severity: changePercent > 1.0 ? 'high' : 'medium',
          details: {
            currentRate: latest,
            previousRate: oldest,
            changePercent,
            timeWindowMs: RATE_VELOCITY_WINDOW_MS,
          },
        };
      }
    }

    // Check deviation from TWAP
    const twapResult = this.getTWAP(protocolId, 1);
    if (twapResult && twapResult.twap > 0) {
      const deviation = Math.abs(latest - twapResult.twap) / twapResult.twap;

      // If current rate is >20% different from 1-hour TWAP, suspicious
      if (deviation > 0.2) {
        return {
          suspicious: true,
          reason: 'twap_deviation',
          severity: deviation > 0.5 ? 'high' : 'medium',
          details: {
            currentRate: latest,
            previousRate: twapResult.twap,
            changePercent: deviation,
            timeWindowMs: 60 * 60 * 1000,
          },
        };
      }
    }

    return { suspicious: false };
  }

  /**
   * Get the latest rate for a protocol.
   */
  getLatestRate(protocolId: YieldProtocol['id']): RateEntry | null {
    const entries = this.history.get(protocolId);
    if (!entries || entries.length === 0) {
      return null;
    }
    return entries[entries.length - 1];
  }

  /**
   * Check if rate data is stale.
   */
  isStale(protocolId: YieldProtocol['id'], maxAgeMs: number): boolean {
    const latest = this.getLatestRate(protocolId);
    if (!latest) {
      return true;
    }
    return Date.now() - latest.timestamp > maxAgeMs;
  }

  /**
   * Clear all history (useful for testing).
   */
  clear(): void {
    this.history.clear();
  }

  /**
   * Get statistics about the history.
   */
  getStats(): Record<YieldProtocol['id'], { count: number; oldestMs: number }> {
    const stats: Record<string, { count: number; oldestMs: number }> = {};

    for (const [protocolId, entries] of this.history) {
      if (entries.length > 0) {
        const oldest = Math.min(...entries.map((e) => e.timestamp));
        stats[protocolId] = {
          count: entries.length,
          oldestMs: Date.now() - oldest,
        };
      }
    }

    return stats as Record<YieldProtocol['id'], { count: number; oldestMs: number }>;
  }
}

/**
 * Singleton rate history instance.
 */
let globalRateHistory: RateHistory | null = null;

export function getRateHistory(): RateHistory {
  if (!globalRateHistory) {
    globalRateHistory = new RateHistory();
  }
  return globalRateHistory;
}

export function resetRateHistory(): void {
  globalRateHistory = null;
}
