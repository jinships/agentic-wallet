/**
 * Integration tests: Protocol on-chain reads against Base mainnet.
 *
 * These tests make real RPC calls to Base mainnet to verify that
 * our protocol adapters can successfully read from live contracts.
 *
 * Run with: TESTNET=1 npm test
 * Skip in CI by not setting TESTNET=1.
 */

import { describe, it, expect } from 'vitest';
import { AaveProtocol } from '../protocols/aave.js';
import { CompoundProtocol } from '../protocols/compound.js';
import { MorphoProtocol } from '../protocols/morpho.js';
import { MoonwellProtocol } from '../protocols/moonwell.js';
import { TESTNET_ENABLED, getBaseMainnetClient, KNOWN_BASE_ADDRESS, retry } from './setup.js';
import type { Address } from 'viem';

const TIMEOUT = 30_000;

// Zero address — unlikely to have positions, but getAPY should still work
const ZERO_VAULT: Address = '0x0000000000000000000000000000000000000001';

describe.skipIf(!TESTNET_ENABLED)('Protocol on-chain reads (Base mainnet)', () => {
  const client = TESTNET_ENABLED ? getBaseMainnetClient() : (null as any);

  describe('AaveProtocol', () => {
    it(
      'getAPY returns a reasonable USDC supply rate',
      async () => {
        const aave = new AaveProtocol(client);
        const apy = await retry(() => aave.getAPY());

        // APY should be between 0% and 50% (sanity check)
        expect(apy).toBeGreaterThanOrEqual(0);
        expect(apy).toBeLessThan(0.5);
        console.log(`  Aave V3 USDC APY: ${(apy * 100).toFixed(4)}%`);
      },
      TIMEOUT
    );

    it(
      'getBalance returns a bigint for any address',
      async () => {
        const aave = new AaveProtocol(client);
        const balance = await retry(() => aave.getBalance(ZERO_VAULT));

        expect(typeof balance).toBe('bigint');
        expect(balance).toBeGreaterThanOrEqual(0n);
      },
      TIMEOUT
    );
  });

  describe('CompoundProtocol', () => {
    it(
      'getAPY returns a reasonable USDC supply rate',
      async () => {
        const compound = new CompoundProtocol(client);
        const apy = await retry(() => compound.getAPY());

        expect(apy).toBeGreaterThanOrEqual(0);
        expect(apy).toBeLessThan(0.5);
        console.log(`  Compound V3 USDC APY: ${(apy * 100).toFixed(4)}%`);
      },
      TIMEOUT
    );

    it(
      'getBalance returns a bigint',
      async () => {
        const compound = new CompoundProtocol(client);
        const balance = await retry(() => compound.getBalance(ZERO_VAULT));

        expect(typeof balance).toBe('bigint');
        expect(balance).toBeGreaterThanOrEqual(0n);
      },
      TIMEOUT
    );
  });

  describe('MorphoProtocol', () => {
    it(
      'getAPY returns a non-negative rate',
      async () => {
        const morpho = new MorphoProtocol(client);
        const apy = await retry(() => morpho.getAPY());

        expect(apy).toBeGreaterThanOrEqual(0);
        expect(apy).toBeLessThan(1.0); // Less than 100%
        console.log(`  Morpho Blue USDC APY: ${(apy * 100).toFixed(4)}%`);
      },
      TIMEOUT
    );

    it(
      'getBalance returns a bigint',
      async () => {
        const morpho = new MorphoProtocol(client);
        const balance = await retry(() => morpho.getBalance(ZERO_VAULT));

        expect(typeof balance).toBe('bigint');
        expect(balance).toBeGreaterThanOrEqual(0n);
      },
      TIMEOUT
    );
  });

  describe('MoonwellProtocol', () => {
    it(
      'getAPY returns a reasonable rate',
      async () => {
        const moonwell = new MoonwellProtocol(client);
        const apy = await retry(() => moonwell.getAPY());

        expect(apy).toBeGreaterThanOrEqual(0);
        expect(apy).toBeLessThan(0.5);
        console.log(`  Moonwell USDC APY: ${(apy * 100).toFixed(4)}%`);
      },
      TIMEOUT
    );

    it(
      'getBalance returns a bigint',
      async () => {
        const moonwell = new MoonwellProtocol(client);
        const balance = await retry(() => moonwell.getBalance(ZERO_VAULT));

        expect(typeof balance).toBe('bigint');
        expect(balance).toBeGreaterThanOrEqual(0n);
      },
      TIMEOUT
    );
  });

  describe('Cross-protocol comparison', () => {
    it(
      'all protocols return APYs that can be compared',
      async () => {
        const protocols = [
          new AaveProtocol(client),
          new CompoundProtocol(client),
          new MorphoProtocol(client),
          new MoonwellProtocol(client),
        ];

        const results = await Promise.all(
          protocols.map(async (p) => ({
            id: p.id,
            name: p.name,
            apy: await retry(() => p.getAPY()),
          }))
        );

        // All should return valid numbers
        for (const r of results) {
          expect(typeof r.apy).toBe('number');
          expect(Number.isFinite(r.apy)).toBe(true);
        }

        // Sort by APY and log
        results.sort((a, b) => b.apy - a.apy);
        console.log('\n  === Live APY Rankings ===');
        for (const r of results) {
          console.log(`  ${r.name}: ${(r.apy * 100).toFixed(4)}%`);
        }
      },
      TIMEOUT
    );
  });
});
