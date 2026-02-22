import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateHistory, getRateHistory, resetRateHistory } from './rate-history.js';

describe('RateHistory', () => {
  let history: RateHistory;

  beforeEach(() => {
    history = new RateHistory();
  });

  describe('record and getEntries', () => {
    it('stores and retrieves entries by protocol', () => {
      const now = Date.now();
      history.record({ protocolId: 'aave', apy: 0.05, timestamp: now, source: 'onchain' });
      history.record({ protocolId: 'compound', apy: 0.04, timestamp: now, source: 'onchain' });

      const aaveEntries = history.getEntries('aave');
      expect(aaveEntries).toHaveLength(1);
      expect(aaveEntries[0].apy).toBe(0.05);

      const compoundEntries = history.getEntries('compound');
      expect(compoundEntries).toHaveLength(1);
    });

    it('prunes entries outside the time window', () => {
      const windowMs = 1000;
      history = new RateHistory(windowMs);

      const now = Date.now();
      history.record({ protocolId: 'aave', apy: 0.03, timestamp: now - 2000, source: 'onchain' });
      history.record({ protocolId: 'aave', apy: 0.05, timestamp: now, source: 'onchain' });

      const entries = history.getEntries('aave');
      expect(entries).toHaveLength(1);
      expect(entries[0].apy).toBe(0.05);
    });

    it('returns empty array for unknown protocol', () => {
      expect(history.getEntries('morpho')).toEqual([]);
    });
  });

  describe('getTWAP', () => {
    it('returns null when no entries exist', () => {
      expect(history.getTWAP('aave')).toBeNull();
    });

    it('returns the single entry value when only one sample', () => {
      const now = Date.now();
      history.record({ protocolId: 'aave', apy: 0.05, timestamp: now, source: 'onchain' });

      const result = history.getTWAP('aave', 1);
      expect(result).not.toBeNull();
      expect(result!.twap).toBe(0.05);
      expect(result!.sampleCount).toBe(1);
    });

    it('calculates time-weighted average correctly', () => {
      const now = Date.now();
      // 5% for 2 seconds, then 3% for ~0 seconds
      history.record({ protocolId: 'aave', apy: 0.05, timestamp: now - 3000, source: 'onchain' });
      history.record({ protocolId: 'aave', apy: 0.03, timestamp: now - 1000, source: 'onchain' });

      const result = history.getTWAP('aave', 1);
      expect(result).not.toBeNull();
      expect(result!.sampleCount).toBe(2);
      // The TWAP should be between 0.03 and 0.05
      // First segment: 0.05 * 2000ms weight, second segment: 0.03 * (time since last)
      expect(result!.twap).toBeGreaterThan(0.03);
      expect(result!.twap).toBeLessThan(0.06);
    });
  });

  describe('detectAnomalies', () => {
    it('returns not suspicious with insufficient data', () => {
      history.record({ protocolId: 'aave', apy: 0.05, timestamp: Date.now(), source: 'onchain' });
      const result = history.detectAnomalies('aave');
      expect(result.suspicious).toBe(false);
      expect(result.reason).toBe('insufficient_data');
    });

    it('detects high rate velocity', () => {
      const now = Date.now();
      // 5% -> 10% (100% change) within the velocity window
      history.record({ protocolId: 'aave', apy: 0.05, timestamp: now - 30000, source: 'onchain' });
      history.record({ protocolId: 'aave', apy: 0.1, timestamp: now, source: 'onchain' });

      const result = history.detectAnomalies('aave');
      expect(result.suspicious).toBe(true);
      expect(result.reason).toBe('high_rate_velocity');
      expect(result.details!.changePercent).toBe(1.0);
    });

    it('does not flag normal rate changes', () => {
      const now = Date.now();
      // 5% -> 5.1% (2% change — well under 50% threshold)
      history.record({ protocolId: 'aave', apy: 0.05, timestamp: now - 30000, source: 'onchain' });
      history.record({ protocolId: 'aave', apy: 0.051, timestamp: now, source: 'onchain' });

      const result = history.detectAnomalies('aave');
      expect(result.suspicious).toBe(false);
    });

    it('accepts an explicit currentRate parameter', () => {
      const now = Date.now();
      history.record({ protocolId: 'aave', apy: 0.05, timestamp: now - 30000, source: 'onchain' });
      history.record({ protocolId: 'aave', apy: 0.05, timestamp: now, source: 'onchain' });

      // Pass a very different currentRate
      const result = history.detectAnomalies('aave', 0.15);
      expect(result.suspicious).toBe(true);
    });
  });

  describe('getLatestRate / isStale', () => {
    it('returns null for unknown protocol', () => {
      expect(history.getLatestRate('morpho')).toBeNull();
    });

    it('returns the most recently recorded entry', () => {
      const now = Date.now();
      history.record({ protocolId: 'aave', apy: 0.03, timestamp: now - 1000, source: 'onchain' });
      history.record({ protocolId: 'aave', apy: 0.05, timestamp: now, source: 'defillama' });

      const latest = history.getLatestRate('aave');
      expect(latest!.apy).toBe(0.05);
      expect(latest!.source).toBe('defillama');
    });

    it('isStale returns true when no data exists', () => {
      expect(history.isStale('aave', 1000)).toBe(true);
    });

    it('isStale returns true when data is old', () => {
      history.record({
        protocolId: 'aave',
        apy: 0.05,
        timestamp: Date.now() - 5000,
        source: 'onchain',
      });
      expect(history.isStale('aave', 1000)).toBe(true);
    });

    it('isStale returns false when data is fresh', () => {
      history.record({
        protocolId: 'aave',
        apy: 0.05,
        timestamp: Date.now(),
        source: 'onchain',
      });
      expect(history.isStale('aave', 60000)).toBe(false);
    });
  });

  describe('clear and getStats', () => {
    it('clear removes all entries', () => {
      history.record({
        protocolId: 'aave',
        apy: 0.05,
        timestamp: Date.now(),
        source: 'onchain',
      });
      history.clear();
      expect(history.getEntries('aave')).toEqual([]);
    });

    it('getStats returns counts and ages', () => {
      const now = Date.now();
      history.record({ protocolId: 'aave', apy: 0.05, timestamp: now - 1000, source: 'onchain' });
      history.record({ protocolId: 'aave', apy: 0.06, timestamp: now, source: 'onchain' });

      const stats = history.getStats();
      expect(stats.aave).toBeDefined();
      expect(stats.aave.count).toBe(2);
      expect(stats.aave.oldestMs).toBeGreaterThanOrEqual(1000);
    });
  });

  describe('global singleton', () => {
    it('getRateHistory returns same instance', () => {
      resetRateHistory();
      const a = getRateHistory();
      const b = getRateHistory();
      expect(a).toBe(b);
    });

    it('resetRateHistory creates a new instance', () => {
      const a = getRateHistory();
      resetRateHistory();
      const b = getRateHistory();
      expect(a).not.toBe(b);
    });
  });
});
