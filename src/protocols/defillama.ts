/**
 * DeFiLlama API client for fallback APY data.
 * Used when on-chain rate reads fail or are stale.
 */

import type { YieldProtocol } from './index.js';

const DEFILLAMA_YIELDS_URL = 'https://yields.llama.fi/pools';

// DeFiLlama pool IDs for our protocols on Base
// These are stable identifiers from DeFiLlama's API
const POOL_MAPPINGS: Record<YieldProtocol['id'], string> = {
  aave: '825688c0-c694-4a6b-8497-177e425b7348', // Aave V3 USDC on Base
  compound: '7da72d09-56ca-4ec5-a45f-59114353e487', // Compound V3 USDC on Base
  morpho: 'c246220b-541a-4902-8a35-f5c5ad263a8e', // Morpho Blue USDC on Base
  moonwell: 'e5ae4a88-32b1-44e3-9a5a-7be29188e7a4', // Moonwell USDC on Base
};

interface DeFiLlamaPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
}

interface DeFiLlamaResponse {
  status: string;
  data: DeFiLlamaPool[];
}

export interface DeFiLlamaRates {
  rates: Map<YieldProtocol['id'], number>;
  timestamp: number;
  source: 'defillama';
}

/**
 * Fetch APY rates from DeFiLlama as a fallback data source.
 */
export async function fetchDeFiLlamaRates(): Promise<DeFiLlamaRates> {
  const response = await fetchWithRetry(DEFILLAMA_YIELDS_URL, 3);
  const data = (await response.json()) as DeFiLlamaResponse;

  if (data.status !== 'success') {
    throw new Error(`DeFiLlama API error: ${data.status}`);
  }

  const rates = new Map<YieldProtocol['id'], number>();

  // Build a lookup map from pool ID to our protocol ID
  const poolToProtocol = new Map<string, YieldProtocol['id']>();
  for (const [protocolId, poolId] of Object.entries(POOL_MAPPINGS)) {
    poolToProtocol.set(poolId, protocolId as YieldProtocol['id']);
  }

  // Extract rates for our protocols
  for (const pool of data.data) {
    const protocolId = poolToProtocol.get(pool.pool);
    if (protocolId) {
      // DeFiLlama returns APY as percentage (e.g., 5.0 for 5%)
      // Convert to decimal (0.05)
      const apy = (pool.apyBase ?? pool.apy ?? 0) / 100;
      rates.set(protocolId, apy);
    }
  }

  return {
    rates,
    timestamp: Date.now(),
    source: 'defillama',
  };
}

/**
 * Fetch with exponential backoff retry.
 */
async function fetchWithRetry(
  url: string,
  maxRetries: number,
  baseDelayMs = 1000
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'AgentVault/1.0',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(`Failed after ${maxRetries} retries: ${lastError?.message}`);
}

/**
 * Get the DeFiLlama pool ID for a protocol.
 */
export function getPoolId(protocolId: YieldProtocol['id']): string | undefined {
  return POOL_MAPPINGS[protocolId];
}
