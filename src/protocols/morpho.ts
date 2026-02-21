import { type Address, type Hex, encodeFunctionData } from 'viem';
import type { YieldProtocol, ReadContractClient } from './index.js';
import { ADDRESSES, SECONDS_PER_YEAR } from '../config.js';

// ERC-4626 Vault ABI (Morpho uses standard ERC-4626)
const ERC4626_ABI = [
  {
    name: 'totalAssets',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'totalSupply',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'convertToAssets',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
] as const;

// For APY calculation, we need to track share price over time
// This is a simplified approach - in production, use historical data or an oracle
const SHARE_PRICE_CACHE = new Map<string, { price: number; timestamp: number }>();
const APY_SAMPLE_PERIOD = 24 * 60 * 60 * 1000; // 24 hours in ms

export class MorphoProtocol implements YieldProtocol {
  readonly name = 'Morpho Blue (Spark)';
  readonly address = ADDRESSES.MORPHO_SPARK_VAULT;
  readonly id = 'morpho' as const;

  constructor(private readonly client: ReadContractClient) {}

  async getAPY(): Promise<number> {
    // Get current share price (assets per share)
    const [totalAssets, totalSupply] = await Promise.all([
      this.client.readContract({
        address: this.address,
        abi: ERC4626_ABI,
        functionName: 'totalAssets',
      }),
      this.client.readContract({
        address: this.address,
        abi: ERC4626_ABI,
        functionName: 'totalSupply',
      }),
    ]);

    // Avoid division by zero
    if (totalSupply === 0n) {
      return 0;
    }

    const currentPrice = Number(totalAssets) / Number(totalSupply);
    const now = Date.now();
    const cacheKey = this.address;
    const cached = SHARE_PRICE_CACHE.get(cacheKey);

    if (cached && now - cached.timestamp >= APY_SAMPLE_PERIOD) {
      // Calculate APY from price change
      const priceChange = (currentPrice - cached.price) / cached.price;
      const timeDelta = (now - cached.timestamp) / 1000; // seconds
      const ratePerSecond = priceChange / timeDelta;
      const apy = ratePerSecond * SECONDS_PER_YEAR;

      // Update cache
      SHARE_PRICE_CACHE.set(cacheKey, { price: currentPrice, timestamp: now });

      return Math.max(0, apy); // APY can't be negative
    }

    // First call or cache too recent - store and return estimate
    // In production, fetch historical data from an indexer
    SHARE_PRICE_CACHE.set(cacheKey, { price: currentPrice, timestamp: now });

    // Return a reasonable estimate for Morpho (typically 3-8% for USDC)
    // This will be replaced with actual calculation after 24h of data
    return 0.05; // 5% estimate
  }

  async getBalance(vault: Address): Promise<bigint> {
    // Get share balance
    const shares = (await this.client.readContract({
      address: this.address,
      abi: ERC4626_ABI,
      functionName: 'balanceOf',
      args: [vault],
    })) as bigint;

    if (shares === 0n) {
      return 0n;
    }

    // Convert shares to underlying assets (USDC)
    const assets = (await this.client.readContract({
      address: this.address,
      abi: ERC4626_ABI,
      functionName: 'convertToAssets',
      args: [shares],
    })) as bigint;

    return assets;
  }

  encodeDeposit(amount: bigint, vault: Address): Hex {
    return encodeFunctionData({
      abi: ERC4626_ABI,
      functionName: 'deposit',
      args: [amount, vault],
    });
  }

  encodeWithdraw(amount: bigint, vault: Address): Hex {
    // For ERC-4626, withdraw(assets, receiver, owner)
    // The vault is both the receiver and owner of the shares
    return encodeFunctionData({
      abi: ERC4626_ABI,
      functionName: 'withdraw',
      args: [amount, vault, vault],
    });
  }
}
