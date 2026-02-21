/**
 * WalletManager - UserOperation Builder & Submission for AgentVault
 *
 * Builds ERC-4337 v0.7 PackedUserOperations for:
 * - Strategy execution (deposits/withdrawals to yield protocols)
 * - Session key management
 * - Withdrawal to external addresses
 *
 * Handles gas estimation including Base L1 data fees.
 */

import {
  type Address,
  type Hex,
  type PublicClient,
  type Chain,
  encodeFunctionData,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  concat,
  toHex,
  pad,
  signatureToHex,
  hexToBytes,
  bytesToHex,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

import {
  type PackedUserOperation,
  type UserOpGasParams,
  type SessionKey,
  type VaultConfig,
  type WebAuthnAuth,
  SIG_TYPE_PASSKEY,
  SIG_TYPE_SESSION_KEY,
  BASE_ADDRESSES,
  UserOpBuildError,
} from './types.js';

// ============ Contract ABIs (minimal) ============

const AGENT_VAULT_ABI = [
  {
    name: 'executeStrategy',
    type: 'function',
    inputs: [
      { name: 'protocol', type: 'address' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'withdraw',
    type: 'function',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'grantSessionKey',
    type: 'function',
    inputs: [
      { name: 'key', type: 'address' },
      { name: 'validUntil', type: 'uint48' },
      { name: 'spendLimit', type: 'uint128' },
    ],
    outputs: [],
  },
  {
    name: 'revokeSessionKey',
    type: 'function',
    inputs: [{ name: 'key', type: 'address' }],
    outputs: [],
  },
  {
    name: 'setProtocolWhitelist',
    type: 'function',
    inputs: [
      { name: 'protocol', type: 'address' },
      { name: 'status', type: 'bool' },
    ],
    outputs: [],
  },
  {
    name: 'setAutoExecuteThreshold',
    type: 'function',
    inputs: [{ name: 'newThreshold', type: 'uint128' }],
    outputs: [],
  },
  {
    name: 'setDailyLimit',
    type: 'function',
    inputs: [{ name: 'newLimit', type: 'uint128' }],
    outputs: [],
  },
  {
    name: 'getNonce',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

const ENTRY_POINT_ABI = [
  {
    name: 'getUserOpHash',
    type: 'function',
    inputs: [
      {
        name: 'userOp',
        type: 'tuple',
        components: [
          { name: 'sender', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'initCode', type: 'bytes' },
          { name: 'callData', type: 'bytes' },
          { name: 'accountGasLimits', type: 'bytes32' },
          { name: 'preVerificationGas', type: 'uint256' },
          { name: 'gasFees', type: 'bytes32' },
          { name: 'paymasterAndData', type: 'bytes' },
          { name: 'signature', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    name: 'getNonce',
    type: 'function',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'key', type: 'uint192' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

// ============ Gas Constants ============

/**
 * Default gas parameters for Base L2
 * These are conservative estimates - actual values determined by estimation
 */
const DEFAULT_GAS_PARAMS: UserOpGasParams = {
  verificationGasLimit: 500_000n, // Higher for P-256 verification
  callGasLimit: 200_000n,
  preVerificationGas: 100_000n,
  maxPriorityFeePerGas: 1_000_000n, // 0.001 gwei (Base is cheap)
  maxFeePerGas: 1_000_000_000n, // 1 gwei
};

// ============ WalletManager Class ============

export interface WalletManagerConfig {
  publicClient: PublicClient;
  bundlerUrl: string;
  chain: Chain;
}

export class WalletManager {
  private readonly client: PublicClient;
  private readonly bundlerUrl: string;
  private readonly chain: Chain;
  private readonly entryPoint: Address;

  constructor(config: WalletManagerConfig) {
    this.client = config.publicClient;
    this.bundlerUrl = config.bundlerUrl;
    this.chain = config.chain;
    this.entryPoint = BASE_ADDRESSES.ENTRY_POINT_V07;
  }

  // ============ UserOp Building ============

  /**
   * Build a UserOperation for executing a yield strategy
   * @param vault The AgentVault address
   * @param protocol The target protocol address
   * @param protocolCallData The encoded call to the protocol (e.g., supply, withdraw)
   * @returns Unsigned PackedUserOperation ready for signing
   */
  async buildExecuteStrategyOp(
    vault: Address,
    protocol: Address,
    protocolCallData: Hex
  ): Promise<PackedUserOperation> {
    const callData = encodeFunctionData({
      abi: AGENT_VAULT_ABI,
      functionName: 'executeStrategy',
      args: [protocol, protocolCallData],
    });

    return this.buildUserOp(vault, callData);
  }

  /**
   * Build a UserOperation for withdrawing tokens
   * @param vault The AgentVault address
   * @param token The token to withdraw
   * @param to Recipient address
   * @param amount Amount to withdraw
   * @returns Unsigned PackedUserOperation ready for signing
   */
  async buildWithdrawOp(
    vault: Address,
    token: Address,
    to: Address,
    amount: bigint
  ): Promise<PackedUserOperation> {
    const callData = encodeFunctionData({
      abi: AGENT_VAULT_ABI,
      functionName: 'withdraw',
      args: [token, to, amount],
    });

    return this.buildUserOp(vault, callData);
  }

  /**
   * Build a UserOperation for granting a session key
   * @param vault The AgentVault address
   * @param key Session key address
   * @param validUntil Expiry timestamp
   * @param spendLimit Max spend for this key
   * @returns Unsigned PackedUserOperation ready for signing
   */
  async buildGrantSessionKeyOp(
    vault: Address,
    key: Address,
    validUntil: number,
    spendLimit: bigint
  ): Promise<PackedUserOperation> {
    const callData = encodeFunctionData({
      abi: AGENT_VAULT_ABI,
      functionName: 'grantSessionKey',
      args: [key, validUntil, spendLimit],
    });

    return this.buildUserOp(vault, callData);
  }

  /**
   * Build a UserOperation for revoking a session key
   */
  async buildRevokeSessionKeyOp(
    vault: Address,
    key: Address
  ): Promise<PackedUserOperation> {
    const callData = encodeFunctionData({
      abi: AGENT_VAULT_ABI,
      functionName: 'revokeSessionKey',
      args: [key],
    });

    return this.buildUserOp(vault, callData);
  }

  /**
   * Build a base UserOperation with gas estimation
   */
  private async buildUserOp(
    sender: Address,
    callData: Hex
  ): Promise<PackedUserOperation> {
    // Get nonce from EntryPoint
    const nonce = await this.getNonce(sender);

    // Estimate gas (includes L1 data fee for Base)
    const gasParams = await this.estimateGas(sender, callData, nonce);

    // Pack gas parameters into v0.7 format
    const accountGasLimits = packGasLimits(
      gasParams.verificationGasLimit,
      gasParams.callGasLimit
    );
    const gasFees = packGasFees(
      gasParams.maxPriorityFeePerGas,
      gasParams.maxFeePerGas
    );

    return {
      sender,
      nonce,
      initCode: '0x' as Hex,
      callData,
      accountGasLimits,
      preVerificationGas: gasParams.preVerificationGas,
      gasFees,
      paymasterAndData: '0x' as Hex,
      signature: '0x' as Hex, // Placeholder - will be filled by signing
    };
  }

  // ============ Gas Estimation ============

  /**
   * Estimate gas for a UserOperation
   * Includes Base L1 data fee calculation
   */
  private async estimateGas(
    sender: Address,
    callData: Hex,
    nonce: bigint
  ): Promise<UserOpGasParams> {
    try {
      // Try bundler estimation first
      const bundlerEstimate = await this.estimateViaBundle(sender, callData, nonce);
      if (bundlerEstimate) {
        return bundlerEstimate;
      }
    } catch {
      // Fall back to defaults with L1 adjustment
    }

    // Calculate L1 data fee overhead for Base
    const l1DataFee = this.estimateL1DataFee(callData);

    return {
      ...DEFAULT_GAS_PARAMS,
      preVerificationGas: DEFAULT_GAS_PARAMS.preVerificationGas + l1DataFee,
    };
  }

  /**
   * Estimate via bundler's eth_estimateUserOperationGas
   */
  private async estimateViaBundle(
    sender: Address,
    callData: Hex,
    nonce: bigint
  ): Promise<UserOpGasParams | null> {
    try {
      const dummyOp = {
        sender,
        nonce: toHex(nonce),
        initCode: '0x',
        callData,
        accountGasLimits: packGasLimits(500_000n, 200_000n),
        preVerificationGas: toHex(100_000n),
        gasFees: packGasFees(1_000_000n, 1_000_000_000n),
        paymasterAndData: '0x',
        signature: '0x' + '00'.repeat(65), // Dummy signature
      };

      const response = await fetch(this.bundlerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_estimateUserOperationGas',
          params: [dummyOp, this.entryPoint],
        }),
      });

      const result = await response.json() as {
        error?: unknown;
        result?: {
          verificationGasLimit: string;
          callGasLimit: string;
          preVerificationGas: string;
        };
      };
      if (result.error || !result.result) return null;

      return {
        verificationGasLimit: BigInt(result.result.verificationGasLimit),
        callGasLimit: BigInt(result.result.callGasLimit),
        preVerificationGas: BigInt(result.result.preVerificationGas),
        maxPriorityFeePerGas: DEFAULT_GAS_PARAMS.maxPriorityFeePerGas,
        maxFeePerGas: DEFAULT_GAS_PARAMS.maxFeePerGas,
      };
    } catch {
      return null;
    }
  }

  /**
   * Estimate L1 data fee for Base
   * Base charges for L1 data availability (~16 gas per non-zero byte)
   */
  private estimateL1DataFee(callData: Hex): bigint {
    const bytes = hexToBytes(callData);
    let nonZeroBytes = 0n;
    let zeroBytes = 0n;

    for (const byte of bytes) {
      if (byte === 0) {
        zeroBytes++;
      } else {
        nonZeroBytes++;
      }
    }

    // Base L1 fee calculation (simplified)
    // Non-zero bytes: 16 gas, Zero bytes: 4 gas
    const l1Gas = nonZeroBytes * 16n + zeroBytes * 4n;

    // Add overhead for UserOp structure (~500 bytes)
    return l1Gas + 8_000n;
  }

  // ============ Nonce Management ============

  /**
   * Get the next nonce for a wallet from EntryPoint
   */
  async getNonce(sender: Address, key: bigint = 0n): Promise<bigint> {
    const nonce = await this.client.readContract({
      address: this.entryPoint,
      abi: ENTRY_POINT_ABI,
      functionName: 'getNonce',
      args: [sender, key],
    });

    return nonce;
  }

  // ============ UserOp Hash ============

  /**
   * Calculate the UserOperation hash for signing
   */
  async getUserOpHash(userOp: PackedUserOperation): Promise<Hex> {
    // Calculate hash locally (matches EntryPoint.getUserOpHash)
    const userOpHash = keccak256(
      encodeAbiParameters(
        parseAbiParameters(
          'address, uint256, bytes32, bytes32, bytes32, uint256, bytes32, bytes32'
        ),
        [
          userOp.sender,
          userOp.nonce,
          keccak256(userOp.initCode),
          keccak256(userOp.callData),
          userOp.accountGasLimits,
          userOp.preVerificationGas,
          userOp.gasFees,
          keccak256(userOp.paymasterAndData),
        ]
      )
    );

    // Include chain ID and EntryPoint address
    const fullHash = keccak256(
      encodeAbiParameters(parseAbiParameters('bytes32, address, uint256'), [
        userOpHash,
        this.entryPoint,
        BigInt(this.chain.id),
      ])
    );

    return fullHash;
  }

  // ============ Signing ============

  /**
   * Sign a UserOperation with a session key (for auto-execute)
   *
   * @deprecated Use signWithSecureSessionKey instead to avoid plaintext key exposure
   * @param userOp The UserOperation to sign
   * @param sessionKey The session key to sign with
   * @returns Signed UserOperation with session key signature
   */
  async signWithSessionKey(
    userOp: PackedUserOperation,
    sessionKey: SessionKey
  ): Promise<PackedUserOperation> {
    console.warn(
      'DEPRECATION WARNING: signWithSessionKey stores plaintext keys. Use signWithSecureSessionKey instead.'
    );
    return this.signWithPrivateKey(userOp, sessionKey.privateKey, sessionKey.address);
  }

  /**
   * Sign a UserOperation with a decrypted session key.
   * The key should be decrypted just before calling this and discarded after.
   *
   * @param userOp The UserOperation to sign
   * @param privateKey The decrypted private key (will be used and should be discarded)
   * @param sessionKeyAddress The session key address
   * @returns Signed UserOperation with session key signature
   */
  async signWithPrivateKey(
    userOp: PackedUserOperation,
    privateKey: Hex,
    sessionKeyAddress: Address
  ): Promise<PackedUserOperation> {
    const userOpHash = await this.getUserOpHash(userOp);

    // Sign with session key
    const account = privateKeyToAccount(privateKey);
    const signature = await account.signMessage({
      message: { raw: hexToBytes(userOpHash) },
    });

    // Format: [sigType(1)] [sessionKeyAddr(20)] [signature(65)]
    const packedSignature = concat([
      toHex(SIG_TYPE_SESSION_KEY, { size: 1 }),
      sessionKeyAddress,
      signature,
    ]) as Hex;

    return {
      ...userOp,
      signature: packedSignature,
    };
  }

  /**
   * Prepare a UserOperation for passkey signing
   * Returns the hash that needs to be signed by WebAuthn
   * @param userOp The unsigned UserOperation
   * @returns Hash to be signed and the userOp
   */
  async prepareForPasskeySigning(
    userOp: PackedUserOperation
  ): Promise<{ userOpHash: Hex; userOp: PackedUserOperation }> {
    const userOpHash = await this.getUserOpHash(userOp);
    return { userOpHash, userOp };
  }

  /**
   * Attach a passkey (WebAuthn) signature to a UserOperation
   * @param userOp The UserOperation
   * @param webAuthnAuth The WebAuthn authentication response
   * @returns Signed UserOperation
   */
  attachPasskeySignature(
    userOp: PackedUserOperation,
    webAuthnAuth: WebAuthnAuth
  ): PackedUserOperation {
    // Encode WebAuthn auth data
    const encodedAuth = encodeAbiParameters(
      parseAbiParameters(
        'bytes authenticatorData, string clientDataJSON, uint256 challengeIndex, uint256 typeIndex, uint256 r, uint256 s'
      ),
      [
        webAuthnAuth.authenticatorData,
        webAuthnAuth.clientDataJSON,
        webAuthnAuth.challengeIndex,
        webAuthnAuth.typeIndex,
        webAuthnAuth.r,
        webAuthnAuth.s,
      ]
    );

    // Format: [sigType(1)] [encodedAuth]
    const packedSignature = concat([
      toHex(SIG_TYPE_PASSKEY, { size: 1 }),
      encodedAuth,
    ]) as Hex;

    return {
      ...userOp,
      signature: packedSignature,
    };
  }

  // ============ Submission ============

  /**
   * Submit a signed UserOperation to the bundler
   * @param userOp The signed UserOperation
   * @returns UserOperation hash
   */
  async submitUserOp(userOp: PackedUserOperation): Promise<Hex> {
    const response = await fetch(this.bundlerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_sendUserOperation',
        params: [this.formatForBundler(userOp), this.entryPoint],
      }),
    });

    const result = await response.json() as {
      error?: { message?: string };
      result?: Hex;
    };

    if (result.error) {
      throw new UserOpBuildError(
        `Bundler error: ${result.error.message || JSON.stringify(result.error)}`
      );
    }

    return result.result as Hex;
  }

  /**
   * Wait for a UserOperation to be included in a block
   * @param userOpHash The UserOperation hash
   * @param timeout Timeout in milliseconds
   * @returns Transaction hash
   */
  async waitForUserOp(
    userOpHash: Hex,
    timeout: number = 60_000
  ): Promise<{ txHash: Hex; success: boolean }> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(this.bundlerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getUserOperationReceipt',
            params: [userOpHash],
          }),
        });

        const result = await response.json() as {
          result?: {
            receipt: { transactionHash: Hex };
            success: boolean;
          };
        };

        if (result.result) {
          return {
            txHash: result.result.receipt.transactionHash,
            success: result.result.success,
          };
        }
      } catch {
        // Continue polling
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    throw new UserOpBuildError(`UserOp not included within ${timeout}ms`);
  }

  /**
   * Format UserOperation for bundler JSON-RPC
   */
  private formatForBundler(userOp: PackedUserOperation): Record<string, string> {
    return {
      sender: userOp.sender,
      nonce: toHex(userOp.nonce),
      initCode: userOp.initCode,
      callData: userOp.callData,
      accountGasLimits: userOp.accountGasLimits,
      preVerificationGas: toHex(userOp.preVerificationGas),
      gasFees: userOp.gasFees,
      paymasterAndData: userOp.paymasterAndData,
      signature: userOp.signature,
    };
  }
}

// ============ Helper Functions ============

/**
 * Pack verification and call gas limits into bytes32
 * Format: bytes16(verificationGasLimit) + bytes16(callGasLimit)
 */
function packGasLimits(
  verificationGasLimit: bigint,
  callGasLimit: bigint
): Hex {
  return concat([
    pad(toHex(verificationGasLimit), { size: 16 }),
    pad(toHex(callGasLimit), { size: 16 }),
  ]) as Hex;
}

/**
 * Pack max priority and max fee per gas into bytes32
 * Format: bytes16(maxPriorityFeePerGas) + bytes16(maxFeePerGas)
 */
function packGasFees(
  maxPriorityFeePerGas: bigint,
  maxFeePerGas: bigint
): Hex {
  return concat([
    pad(toHex(maxPriorityFeePerGas), { size: 16 }),
    pad(toHex(maxFeePerGas), { size: 16 }),
  ]) as Hex;
}

// ============ Protocol Call Encoders ============

/**
 * Encode protocol-specific calls for use with executeStrategy
 */
export const ProtocolEncoders = {
  /**
   * Encode Aave V3 supply call
   */
  aaveSupply(asset: Address, amount: bigint, onBehalfOf: Address): Hex {
    return encodeFunctionData({
      abi: [
        {
          name: 'supply',
          type: 'function',
          inputs: [
            { name: 'asset', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'onBehalfOf', type: 'address' },
            { name: 'referralCode', type: 'uint16' },
          ],
        },
      ],
      functionName: 'supply',
      args: [asset, amount, onBehalfOf, 0],
    });
  },

  /**
   * Encode Aave V3 withdraw call
   */
  aaveWithdraw(asset: Address, amount: bigint, to: Address): Hex {
    return encodeFunctionData({
      abi: [
        {
          name: 'withdraw',
          type: 'function',
          inputs: [
            { name: 'asset', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'to', type: 'address' },
          ],
        },
      ],
      functionName: 'withdraw',
      args: [asset, amount, to],
    });
  },

  /**
   * Encode Compound V3 supply call
   */
  compoundSupply(asset: Address, amount: bigint): Hex {
    return encodeFunctionData({
      abi: [
        {
          name: 'supply',
          type: 'function',
          inputs: [
            { name: 'asset', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
        },
      ],
      functionName: 'supply',
      args: [asset, amount],
    });
  },

  /**
   * Encode Compound V3 withdraw call
   */
  compoundWithdraw(asset: Address, amount: bigint): Hex {
    return encodeFunctionData({
      abi: [
        {
          name: 'withdraw',
          type: 'function',
          inputs: [
            { name: 'asset', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
        },
      ],
      functionName: 'withdraw',
      args: [asset, amount],
    });
  },

  /**
   * Encode ERC-4626 deposit (Morpho)
   */
  erc4626Deposit(assets: bigint, receiver: Address): Hex {
    return encodeFunctionData({
      abi: [
        {
          name: 'deposit',
          type: 'function',
          inputs: [
            { name: 'assets', type: 'uint256' },
            { name: 'receiver', type: 'address' },
          ],
        },
      ],
      functionName: 'deposit',
      args: [assets, receiver],
    });
  },

  /**
   * Encode ERC-4626 withdraw (Morpho)
   */
  erc4626Withdraw(assets: bigint, receiver: Address, owner: Address): Hex {
    return encodeFunctionData({
      abi: [
        {
          name: 'withdraw',
          type: 'function',
          inputs: [
            { name: 'assets', type: 'uint256' },
            { name: 'receiver', type: 'address' },
            { name: 'owner', type: 'address' },
          ],
        },
      ],
      functionName: 'withdraw',
      args: [assets, receiver, owner],
    });
  },

  /**
   * Encode Moonwell mint (deposit)
   */
  moonwellMint(mintAmount: bigint): Hex {
    return encodeFunctionData({
      abi: [
        {
          name: 'mint',
          type: 'function',
          inputs: [{ name: 'mintAmount', type: 'uint256' }],
        },
      ],
      functionName: 'mint',
      args: [mintAmount],
    });
  },

  /**
   * Encode Moonwell redeemUnderlying (withdraw)
   */
  moonwellRedeem(redeemAmount: bigint): Hex {
    return encodeFunctionData({
      abi: [
        {
          name: 'redeemUnderlying',
          type: 'function',
          inputs: [{ name: 'redeemAmount', type: 'uint256' }],
        },
      ],
      functionName: 'redeemUnderlying',
      args: [redeemAmount],
    });
  },
};

// ============ Factory Function ============

/**
 * Create a WalletManager instance for Base mainnet
 */
export function createWalletManager(
  publicClient: PublicClient,
  bundlerUrl: string
): WalletManager {
  return new WalletManager({
    publicClient,
    bundlerUrl,
    chain: base,
  });
}

/**
 * Create a WalletManager instance for Base Sepolia testnet
 */
export function createTestnetWalletManager(
  publicClient: PublicClient,
  bundlerUrl: string
): WalletManager {
  return new WalletManager({
    publicClient,
    bundlerUrl,
    chain: baseSepolia,
  });
}
