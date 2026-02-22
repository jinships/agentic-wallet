/**
 * Integration tests: DeFiLlama API.
 *
 * Verifies that the DeFiLlama fallback data source works correctly
 * with the live API.
 *
 * Run with: TESTNET=1 npm test
 */

import { describe, it, expect } from 'vitest';
import { fetchDeFiLlamaRates, getPoolId } from '../protocols/defillama.js';
import { TESTNET_ENABLED, retry } from './setup.js';

const TIMEOUT = 30_000;

describe.skipIf(!TESTNET_ENABLED)('DeFiLlama API (live)', () => {
  it(
    'fetchDeFiLlamaRates returns rates for known protocols',
    async () => {
      const result = await retry(() => fetchDeFiLlamaRates());

      expect(result.source).toBe('defillama');
      expect(result.timestamp).toBeGreaterThan(0);
      expect(result.rates.size).toBeGreaterThan(0);

      console.log('\n  === DeFiLlama Rates ===');
      for (const [id, rate] of result.rates) {
        console.log(`  ${id}: ${(rate * 100).toFixed(4)}%`);
        // Each rate should be a reasonable APY
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThan(1.0); // < 100%
      }
    },
    TIMEOUT
  );

  it(
    'rates are reasonably close to each other (no wild outliers)',
    async () => {
      const result = await retry(() => fetchDeFiLlamaRates());

      const rates = Array.from(result.rates.values());
      if (rates.length < 2) return; // Skip if not enough data

      const max = Math.max(...rates);
      const min = Math.min(...rates);

      // The spread between protocols shouldn't be more than 20% absolute
      // (e.g., if one is at 5%, another shouldn't be at 25%)
      expect(max - min).toBeLessThan(0.20);
    },
    TIMEOUT
  );

  describe('getPoolId', () => {
    it('returns pool IDs for all known protocols', () => {
      const protocols = ['aave', 'compound', 'morpho', 'moonwell'] as const;
      for (const id of protocols) {
        const poolId = getPoolId(id);
        expect(poolId).toBeTruthy();
        // DeFiLlama pool IDs are UUIDs
        expect(poolId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        );
      }
    });
  });
});
