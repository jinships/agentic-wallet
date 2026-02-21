import { type Address, type Hex, encodeFunctionData } from 'viem';
import type { YieldProtocol, ReadContractClient } from './index.js';
import { ADDRESSES, SECONDS_PER_YEAR } from '../config.js';

// Aave V3 Pool ABI (minimal for our needs)
const AAVE_POOL_ABI = [
  {
    name: 'getReserveData',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'configuration', type: 'uint256' },
          { name: 'liquidityIndex', type: 'uint128' },
          { name: 'currentLiquidityRate', type: 'uint128' },
          { name: 'variableBorrowIndex', type: 'uint128' },
          { name: 'currentVariableBorrowRate', type: 'uint128' },
          { name: 'currentStableBorrowRate', type: 'uint128' },
          { name: 'lastUpdateTimestamp', type: 'uint40' },
          { name: 'id', type: 'uint16' },
          { name: 'aTokenAddress', type: 'address' },
          { name: 'stableDebtTokenAddress', type: 'address' },
          { name: 'variableDebtTokenAddress', type: 'address' },
          { name: 'interestRateStrategyAddress', type: 'address' },
          { name: 'accruedToTreasury', type: 'uint128' },
          { name: 'unbacked', type: 'uint128' },
          { name: 'isolationModeTotalDebt', type: 'uint128' },
        ],
      },
    ],
  },
  {
    name: 'supply',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// aToken ABI for balance
const ATOKEN_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// RAY = 1e27 (Aave's precision for rates)
const RAY = 10n ** 27n;

export class AaveProtocol implements YieldProtocol {
  readonly name = 'Aave V3';
  readonly address = ADDRESSES.AAVE_POOL;
  readonly id = 'aave' as const;

  constructor(private readonly client: ReadContractClient) {}

  async getAPY(): Promise<number> {
    const reserveData = (await this.client.readContract({
      address: this.address,
      abi: AAVE_POOL_ABI,
      functionName: 'getReserveData',
      args: [ADDRESSES.USDC],
    })) as { currentLiquidityRate: bigint };

    // currentLiquidityRate is in RAY (1e27) and represents the current supply rate per second
    // To get APY: rate / RAY
    const liquidityRate = reserveData.currentLiquidityRate;
    const ratePerSecond = Number(liquidityRate) / Number(RAY);

    // Simple APY calculation (not compounding for simplicity)
    // For more accuracy, use: (1 + ratePerSecond)^secondsPerYear - 1
    const apy = ratePerSecond * SECONDS_PER_YEAR;

    return apy;
  }

  async getBalance(vault: Address): Promise<bigint> {
    // aTokens represent 1:1 with underlying, so balance of aUSDC = USDC deposited
    const balance = (await this.client.readContract({
      address: ADDRESSES.AAVE_AUSDC,
      abi: ATOKEN_ABI,
      functionName: 'balanceOf',
      args: [vault],
    })) as bigint;

    return balance;
  }

  encodeDeposit(amount: bigint, vault: Address): Hex {
    return encodeFunctionData({
      abi: AAVE_POOL_ABI,
      functionName: 'supply',
      args: [ADDRESSES.USDC, amount, vault, 0],
    });
  }

  encodeWithdraw(amount: bigint, vault: Address): Hex {
    return encodeFunctionData({
      abi: AAVE_POOL_ABI,
      functionName: 'withdraw',
      args: [ADDRESSES.USDC, amount, vault],
    });
  }
}
