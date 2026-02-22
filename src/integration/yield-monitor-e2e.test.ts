/**
 * Integration tests: YieldMonitor end-to-end with live data.
 *
 * Tests the full yield monitoring pipeline against real Base mainnet
 * contracts and DeFiLlama API.
 *
 * Run with: TESTNET=1 npm test
 */

import { describe, it, expect, afterEach } from 'vitest';
import { YieldMonitor } from '../yield-monitor.js';
import { TESTNET_ENABLED, getBaseMainnetClient, retry } from './setup.js';
import { resetRateHistory } from '../rate-history.js';
import type { Address } from 'viem';

const TIMEOUT = 60_000;

// Address with no protocol positions — tests the "no funds" path
const EMPTY_VAULT: Address = '0x0000000000000000000000000000000000000001';

describe.skipIf(!TESTNET_ENABLED)('YieldMonitor E2E (Base mainnet)', () => {
  const client = TESTNET_ENABLED ? getBaseMainnetClient() : (null as any);

  afterEach(() => {
    resetRateHistory();
  });

  it(
    'getSnapshots returns data for all 4 protocols',
    async () => {
      const monitor = new YieldMonitor(client, {
        useTWAP: false,
        enableAnomalyDetection: false,
        useDeFiLlamaFallback: true,
        rateStalenesMs: 7200000,
      });

      const { snapshots, dataSource } = await retry(() => monitor.getSnapshots(EMPTY_VAULT));

      expect(snapshots).toHaveLength(4);
      expect(['onchain', 'defillama', 'mixed']).toContain(dataSource);

      console.log(`\n  Data source: ${dataSource}`);
      for (const s of snapshots) {
        console.log(
          `  ${s.protocolName}: ${(s.apyPercent * 100).toFixed(4)}% APY, balance=${s.balance}`
        );
        expect(s.apyPercent).toBeGreaterThanOrEqual(0);
        expect(typeof s.balance).toBe('bigint');
        expect(s.timestamp).toBeGreaterThan(0);
      }
    },
    TIMEOUT
  );

  it(
    'compareYields produces a valid comparison with recommendations',
    async () => {
      const monitor = new YieldMonitor(client, {
        useTWAP: false,
        enableAnomalyDetection: false,
        useDeFiLlamaFallback: true,
        rateStalenesMs: 7200000,
      });

      const comparison = await retry(() => monitor.compareYields(EMPTY_VAULT));

      // Best protocol should have the highest APY
      expect(comparison.bestProtocol).toBeDefined();
      expect(comparison.bestProtocol.apyPercent).toBeGreaterThanOrEqual(0);

      // For empty vault, no current protocol
      expect(comparison.currentProtocol).toBeNull();

      // Should not rebalance (no funds)
      expect(comparison.shouldRebalance).toBe(false);
      expect(comparison.rejectReason).toBe('no_funds_to_move');

      // Format and log
      const formatted = monitor.formatComparison(comparison);
      console.log('\n' + formatted);
    },
    TIMEOUT
  );

  it(
    'rate history is populated after getSnapshots',
    async () => {
      const monitor = new YieldMonitor(client, {
        useTWAP: false,
        enableAnomalyDetection: false,
        useDeFiLlamaFallback: true,
        rateStalenesMs: 7200000,
      });

      await retry(() => monitor.getSnapshots(EMPTY_VAULT));

      const rateHistory = monitor.getRateHistory();
      const stats = rateHistory.getStats();

      // Should have entries for at least some protocols
      const protocolIds = Object.keys(stats);
      expect(protocolIds.length).toBeGreaterThan(0);

      for (const id of protocolIds) {
        expect(stats[id as keyof typeof stats].count).toBeGreaterThanOrEqual(1);
      }
    },
    TIMEOUT
  );

  it(
    'anomaly detection runs without errors on live data',
    async () => {
      const monitor = new YieldMonitor(client, {
        useTWAP: true,
        enableAnomalyDetection: true,
        useDeFiLlamaFallback: true,
        rateStalenesMs: 7200000,
      });

      // First call seeds the rate history
      await retry(() => monitor.compareYields(EMPTY_VAULT));

      // Second call has history to compare against
      const comparison = await retry(() => monitor.compareYields(EMPTY_VAULT));

      // With two quick successive calls, rates shouldn't change much
      // so no anomalies should be detected
      expect(comparison.anomalies.size).toBe(0);
      expect(comparison.twapUsed).toBe(true);
    },
    TIMEOUT
  );
});
