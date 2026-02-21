import {
  type Address,
  type Hex,
  encodeFunctionData,
} from "viem";
import type { YieldProtocol, ReadContractClient } from "./index.js";
import { ADDRESSES, SECONDS_PER_YEAR } from "../config.js";

// Compound V3 Comet ABI (minimal for our needs)
const COMET_ABI = [
  {
    name: "getUtilization",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getSupplyRate",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "utilization", type: "uint256" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "supply",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// Compound uses 1e18 precision for rates
const RATE_SCALE = 10n ** 18n;

export class CompoundProtocol implements YieldProtocol {
  readonly name = "Compound V3";
  readonly address = ADDRESSES.COMPOUND_CUSDC;
  readonly id = "compound" as const;

  constructor(private readonly client: ReadContractClient) {}

  async getAPY(): Promise<number> {
    // Get current utilization
    const utilization = await this.client.readContract({
      address: this.address,
      abi: COMET_ABI,
      functionName: "getUtilization",
    }) as bigint;

    // Get supply rate at current utilization (returns rate per second scaled by 1e18)
    const supplyRate = await this.client.readContract({
      address: this.address,
      abi: COMET_ABI,
      functionName: "getSupplyRate",
      args: [utilization],
    }) as bigint;

    // Convert to annual rate
    const ratePerSecond = Number(supplyRate) / Number(RATE_SCALE);
    const apy = ratePerSecond * SECONDS_PER_YEAR;

    return apy;
  }

  async getBalance(vault: Address): Promise<bigint> {
    // Compound V3 balanceOf returns the principal balance in base asset (USDC)
    const balance = await this.client.readContract({
      address: this.address,
      abi: COMET_ABI,
      functionName: "balanceOf",
      args: [vault],
    }) as bigint;

    return balance;
  }

  encodeDeposit(amount: bigint, _vault: Address): Hex {
    // In Compound V3, supply() credits the msg.sender (which will be the vault via EntryPoint)
    return encodeFunctionData({
      abi: COMET_ABI,
      functionName: "supply",
      args: [ADDRESSES.USDC, amount],
    });
  }

  encodeWithdraw(amount: bigint, _vault: Address): Hex {
    return encodeFunctionData({
      abi: COMET_ABI,
      functionName: "withdraw",
      args: [ADDRESSES.USDC, amount],
    });
  }
}
