/**
 * Integration tests: WalletManager on-chain interactions.
 *
 * Tests UserOp building, gas estimation, and hash computation
 * against live Base mainnet/Sepolia contracts.
 *
 * Run with: TESTNET=1 npm test
 */

import { describe, it, expect } from 'vitest';
import { WalletManager, ProtocolEncoders } from '../wallet-manager.js';
import { TESTNET_ENABLED, getBaseMainnetClient, retry } from './setup.js';
import { base } from 'viem/chains';
import type { Address, Hex } from 'viem';
import { ADDRESSES } from '../config.js';

const TIMEOUT = 30_000;

// Use a dummy vault address for read-only tests
const DUMMY_VAULT: Address = '0x0000000000000000000000000000000000000001';
// Fake bundler URL — we won't actually submit, just test building
const FAKE_BUNDLER = 'http://localhost:0';

describe.skipIf(!TESTNET_ENABLED)('WalletManager on-chain (Base mainnet)', () => {
  const client = TESTNET_ENABLED ? getBaseMainnetClient() : (null as any);

  describe('getNonce', () => {
    it(
      'reads nonce from EntryPoint for any address',
      async () => {
        const wm = new WalletManager({
          publicClient: client,
          bundlerUrl: FAKE_BUNDLER,
          chain: base,
        });

        const nonce = await retry(() => wm.getNonce(DUMMY_VAULT));
        expect(typeof nonce).toBe('bigint');
        // For an address that hasn't sent userops, nonce should be 0
        expect(nonce).toBeGreaterThanOrEqual(0n);
      },
      TIMEOUT
    );
  });

  describe('getUserOpHash', () => {
    it(
      'computes a deterministic hash for a UserOp',
      async () => {
        const wm = new WalletManager({
          publicClient: client,
          bundlerUrl: FAKE_BUNDLER,
          chain: base,
        });

        const callData = ProtocolEncoders.aaveSupply(
          ADDRESSES.USDC as Address,
          1_000_000n,
          DUMMY_VAULT
        );

        const userOp = {
          sender: DUMMY_VAULT,
          nonce: 0n,
          initCode: '0x' as Hex,
          callData,
          accountGasLimits: ('0x' + '0'.repeat(64)) as Hex,
          preVerificationGas: 100_000n,
          gasFees: ('0x' + '0'.repeat(64)) as Hex,
          paymasterAndData: '0x' as Hex,
          signature: '0x' as Hex,
        };

        const hash1 = await wm.getUserOpHash(userOp);
        const hash2 = await wm.getUserOpHash(userOp);

        expect(hash1).toMatch(/^0x[0-9a-f]{64}$/);
        expect(hash1).toBe(hash2); // Deterministic

        // Different nonce should produce different hash
        const userOp2 = { ...userOp, nonce: 1n };
        const hash3 = await wm.getUserOpHash(userOp2);
        expect(hash3).not.toBe(hash1);
      },
      TIMEOUT
    );
  });

  describe('buildExecuteStrategyOp', () => {
    it(
      'builds a valid UserOp structure (falls back to default gas when no bundler)',
      async () => {
        const wm = new WalletManager({
          publicClient: client,
          bundlerUrl: FAKE_BUNDLER,
          chain: base,
        });

        const callData = ProtocolEncoders.compoundSupply(ADDRESSES.USDC as Address, 1_000_000n);

        const userOp = await retry(() =>
          wm.buildExecuteStrategyOp(DUMMY_VAULT, ADDRESSES.COMPOUND_CUSDC as Address, callData)
        );

        expect(userOp.sender).toBe(DUMMY_VAULT);
        expect(typeof userOp.nonce).toBe('bigint');
        expect(userOp.callData).toMatch(/^0x/);
        expect(userOp.callData.length).toBeGreaterThan(10);
        expect(userOp.preVerificationGas).toBeGreaterThan(0n);
        expect(userOp.initCode).toBe('0x');
        expect(userOp.paymasterAndData).toBe('0x');
        expect(userOp.signature).toBe('0x'); // unsigned
      },
      TIMEOUT
    );
  });
});
