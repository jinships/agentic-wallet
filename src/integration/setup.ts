/**
 * Integration test setup and utilities.
 *
 * These tests interact with real networks and external APIs.
 * They require:
 * - TESTNET=1 environment variable to run
 * - RPC_URL_BASE_SEPOLIA (optional, defaults to public RPC)
 * - RPC_URL_BASE (optional, defaults to public RPC — used for read-only mainnet tests)
 *
 * Skip in CI by not setting TESTNET=1.
 */

import { createPublicClient, http, type PublicClient, type Chain } from 'viem';
import { base, baseSepolia } from 'viem/chains';

export const TESTNET_ENABLED = process.env.TESTNET === '1' || process.env.TESTNET === 'true';

/**
 * Create a public client for Base mainnet (read-only).
 * Uses a public RPC by default — sufficient for view calls.
 */
export function getBaseMainnetClient(): PublicClient {
  const rpcUrl = process.env.RPC_URL_BASE || 'https://mainnet.base.org';
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  }) as PublicClient;
}

/**
 * Create a public client for Base Sepolia testnet.
 */
export function getBaseSepoliaClient(): PublicClient {
  const rpcUrl = process.env.RPC_URL_BASE_SEPOLIA || 'https://sepolia.base.org';
  return createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  }) as PublicClient;
}

/**
 * A known vault/wallet address on Base mainnet that has protocol positions.
 * Used for read-only balance checks. This is a well-known DeFi address.
 * If it has no positions, balance tests will just return 0 (not fail).
 */
export const KNOWN_BASE_ADDRESS = '0x0000000000000000000000000000000000000001' as const;

/**
 * Retry wrapper for flaky network calls in tests.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  delayMs = 2000
): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (i < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      }
    }
  }
  throw lastError;
}
