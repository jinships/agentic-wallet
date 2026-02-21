import { base } from 'viem/chains';

export const CHAIN = base;

// Base Mainnet Protocol Addresses
export const ADDRESSES = {
  // Tokens
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const,

  // Aave V3
  AAVE_POOL: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as const,
  AAVE_AUSDC: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0Ab' as const,

  // Compound V3
  COMPOUND_CUSDC: '0xb125E6687d4313864e53df431d5425969c15Eb2F' as const,

  // Morpho Blue (Spark USDC Vault)
  MORPHO_SPARK_VAULT: '0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A' as const,

  // Moonwell
  MOONWELL_MUSDC: '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22' as const,

  // ERC-4337 Infrastructure
  ENTRYPOINT_V07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const,

  // RIP-7212 P-256 Precompile
  P256_VERIFIER: '0x0000000000000000000000000000000000000100' as const,
} as const;

// Yield optimization parameters
export const YIELD_CONFIG = {
  // Minimum APY differential to trigger rebalance (in basis points, 50 = 0.5%)
  MIN_APY_DIFFERENTIAL_BPS: 50,

  // Polling interval in milliseconds (1 hour)
  POLL_INTERVAL_MS: 60 * 60 * 1000,

  // Rate staleness threshold (if rates older than this, mark as stale)
  RATE_STALENESS_MS: 2 * 60 * 60 * 1000, // 2 hours

  // Auto-execute threshold in USDC (6 decimals). Default $100 = 100_000_000
  AUTO_EXECUTE_THRESHOLD: 100_000_000n,
} as const;

// USDC decimals
export const USDC_DECIMALS = 6;

// Seconds per year for APY calculations
export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
