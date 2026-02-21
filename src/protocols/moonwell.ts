import {
  type Address,
  type Hex,
  encodeFunctionData,
} from "viem";
import type { YieldProtocol, ReadContractClient } from "./index.js";
import { ADDRESSES, SECONDS_PER_YEAR } from "../config.js";

// Moonwell mToken ABI (Compound V2 style)
const MTOKEN_ABI = [
  {
    name: "supplyRatePerTimestamp",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "exchangeRateStored",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "mintAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "redeemUnderlying",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "redeemAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Moonwell uses 1e18 precision for rates and exchange rates
const RATE_MANTISSA = 10n ** 18n;
// Exchange rate is scaled by 10^(18 - underlyingDecimals + mTokenDecimals)
// For USDC (6 decimals) and mToken (8 decimals): 10^(18 - 6 + 8) = 10^20
const EXCHANGE_RATE_SCALE = 10n ** 20n;

export class MoonwellProtocol implements YieldProtocol {
  readonly name = "Moonwell";
  readonly address = ADDRESSES.MOONWELL_MUSDC;
  readonly id = "moonwell" as const;

  constructor(private readonly client: ReadContractClient) {}

  async getAPY(): Promise<number> {
    // supplyRatePerTimestamp returns rate per second, scaled by 1e18
    const supplyRate = await this.client.readContract({
      address: this.address,
      abi: MTOKEN_ABI,
      functionName: "supplyRatePerTimestamp",
    });

    // Convert to annual rate
    const ratePerSecond = Number(supplyRate) / Number(RATE_MANTISSA);
    const apy = ratePerSecond * SECONDS_PER_YEAR;

    return apy;
  }

  async getBalance(vault: Address): Promise<bigint> {
    // Get mToken balance
    const mTokenBalance = await this.client.readContract({
      address: this.address,
      abi: MTOKEN_ABI,
      functionName: "balanceOf",
      args: [vault],
    }) as bigint;

    if (mTokenBalance === 0n) {
      return 0n;
    }

    // Get exchange rate to convert to underlying
    const exchangeRate = await this.client.readContract({
      address: this.address,
      abi: MTOKEN_ABI,
      functionName: "exchangeRateStored",
    }) as bigint;

    // underlying = mTokenBalance * exchangeRate / EXCHANGE_RATE_SCALE
    const underlying = (mTokenBalance * exchangeRate) / EXCHANGE_RATE_SCALE;

    return underlying;
  }

  encodeDeposit(amount: bigint, _vault: Address): Hex {
    // mint() takes the underlying amount and mints mTokens to msg.sender
    return encodeFunctionData({
      abi: MTOKEN_ABI,
      functionName: "mint",
      args: [amount],
    });
  }

  encodeWithdraw(amount: bigint, _vault: Address): Hex {
    // redeemUnderlying() redeems a specific amount of underlying to msg.sender
    return encodeFunctionData({
      abi: MTOKEN_ABI,
      functionName: "redeemUnderlying",
      args: [amount],
    });
  }
}
