import type { Address, Hex, Abi, ContractFunctionName, ContractFunctionArgs } from 'viem';

/**
 * Minimal client interface for protocol interactions.
 * This allows protocols to work with any viem client (base, mainnet, etc.)
 */
export interface ReadContractClient {
  readContract<
    const TAbi extends Abi | readonly unknown[],
    TFunctionName extends ContractFunctionName<TAbi, 'view' | 'pure'>,
    TArgs extends ContractFunctionArgs<TAbi, 'view' | 'pure', TFunctionName>,
  >(args: {
    address: Address;
    abi: TAbi;
    functionName: TFunctionName;
    args?: TArgs;
  }): Promise<unknown>;
}

/**
 * Common interface for all yield protocol integrations.
 * Each protocol implements this interface to enable unified yield comparison
 * and rebalancing operations.
 */
export interface YieldProtocol {
  /** Human-readable protocol name */
  readonly name: string;

  /** Main protocol contract address (pool, comet, vault, etc.) */
  readonly address: Address;

  /** Protocol identifier for logging and tracking */
  readonly id: 'aave' | 'compound' | 'morpho' | 'moonwell';

  /**
   * Get the current supply APY for USDC.
   * @returns APY as a decimal (e.g., 0.05 for 5%)
   */
  getAPY(): Promise<number>;

  /**
   * Get the vault's current balance in this protocol.
   * @param vault - The AgentVault address
   * @returns Balance in USDC (6 decimals)
   */
  getBalance(vault: Address): Promise<bigint>;

  /**
   * Encode a deposit call for the given amount.
   * @param amount - Amount in USDC (6 decimals)
   * @param vault - The AgentVault address (recipient of yield-bearing tokens)
   * @returns Encoded calldata for the deposit transaction
   */
  encodeDeposit(amount: bigint, vault: Address): Hex;

  /**
   * Encode a withdrawal call for the given amount.
   * @param amount - Amount in USDC (6 decimals)
   * @param vault - The AgentVault address
   * @returns Encoded calldata for the withdraw transaction
   */
  encodeWithdraw(amount: bigint, vault: Address): Hex;
}

/**
 * Snapshot of a protocol's current state.
 */
export interface ProtocolSnapshot {
  protocolId: YieldProtocol['id'];
  protocolName: string;
  address: Address;
  apyPercent: number;
  balance: bigint;
  timestamp: number;
}

/**
 * Result of yield comparison across all protocols.
 */
export interface YieldComparison {
  snapshots: ProtocolSnapshot[];
  bestProtocol: ProtocolSnapshot;
  currentProtocol: ProtocolSnapshot | null;
  apyDifferentialBps: number;
  shouldRebalance: boolean;
  timestamp: number;
}

// Re-export protocol implementations
export { AaveProtocol } from './aave.js';
export { CompoundProtocol } from './compound.js';
export { MorphoProtocol } from './morpho.js';
export { MoonwellProtocol } from './moonwell.js';
