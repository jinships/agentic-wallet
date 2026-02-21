/**
 * Core types for AgentVault UserOp Builder & Approval Flow
 */

import type { Hex, Address } from 'viem';

// ============ ERC-4337 Types ============

/**
 * Packed UserOperation for EntryPoint v0.7
 * @see https://eips.ethereum.org/EIPS/eip-4337#useroperation
 */
export interface PackedUserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex; // packed: bytes16(verificationGasLimit) + bytes16(callGasLimit)
  preVerificationGas: bigint;
  gasFees: Hex; // packed: bytes16(maxPriorityFeePerGas) + bytes16(maxFeePerGas)
  paymasterAndData: Hex;
  signature: Hex;
}

/**
 * Unpacked gas values for easier manipulation
 */
export interface UserOpGasParams {
  verificationGasLimit: bigint;
  callGasLimit: bigint;
  preVerificationGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
}

// ============ Signature Types ============

/**
 * Signature type identifiers (must match contract constants)
 */
export const SIG_TYPE_PASSKEY = 0x00;
export const SIG_TYPE_SESSION_KEY = 0x01;

/**
 * WebAuthn authentication data structure
 * @see https://www.w3.org/TR/webauthn-2/#authenticator-data
 */
export interface WebAuthnAuth {
  authenticatorData: Hex;
  clientDataJSON: string;
  challengeIndex: bigint;
  typeIndex: bigint;
  r: bigint;
  s: bigint;
}

// ============ Protocol Types ============

/**
 * Supported yield protocols on Base
 */
export enum Protocol {
  AAVE_V3 = 'aave-v3',
  COMPOUND_V3 = 'compound-v3',
  MORPHO_BLUE = 'morpho-blue',
  MOONWELL = 'moonwell',
}

/**
 * Protocol addresses on Base mainnet
 */
export const PROTOCOL_ADDRESSES: Record<Protocol, Address> = {
  [Protocol.AAVE_V3]: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  [Protocol.COMPOUND_V3]: '0xb125E6687d4313864e53df431d5425969c15Eb2F',
  [Protocol.MORPHO_BLUE]: '0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A',
  [Protocol.MOONWELL]: '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22',
};

/**
 * Base mainnet contract addresses
 */
export const BASE_ADDRESSES = {
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
  ENTRY_POINT_V07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address,
  P256_PRECOMPILE: '0x0000000000000000000000000000000000000100' as Address,
  // AgentVault contracts (deployed 2026-02-21)
  AGENT_VAULT_IMPL: '0x8BC998ddCe53A52f6944178f7987fF384B467301' as Address,
  AGENT_VAULT_FACTORY: '0x74fa96F0A20A2A863E0921beBB6B398D969e096C' as Address,
} as const;

// ============ Strategy Types ============

/**
 * Rebalancing strategy proposal
 */
export interface RebalanceProposal {
  id: string;
  fromProtocol: Protocol;
  toProtocol: Protocol;
  amount: bigint; // in USDC (6 decimals)
  fromAPY: number;
  toAPY: number;
  apyDelta: number;
  estimatedGasCost: bigint;
  createdAt: Date;
  expiresAt: Date;
  status: ProposalStatus;
}

export enum ProposalStatus {
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EXECUTED = 'executed',
  EXPIRED = 'expired',
  FAILED = 'failed',
}

// ============ Approval Types ============

/**
 * Approval request sent to user
 */
export interface ApprovalRequest {
  proposalId: string;
  vaultAddress: Address;
  userOpHash: Hex;
  userOp: PackedUserOperation;
  displayData: ApprovalDisplayData;
  approvalUrl: string;
  expiresAt: Date;
}

/**
 * Human-readable data for approval UI
 */
export interface ApprovalDisplayData {
  action: string;
  fromProtocol: string;
  toProtocol: string;
  amount: string; // formatted with $ and decimals
  currentAPY: string;
  newAPY: string;
  apyGain: string;
  estimatedGas: string;
}

/**
 * Approval response from user
 */
export interface ApprovalResponse {
  proposalId: string;
  approved: boolean;
  signature?: Hex;
  webAuthnAuth?: WebAuthnAuth;
  timestamp: Date;
}

// ============ Session Key Types ============

/**
 * Session key configuration (matches contract struct)
 */
export interface SessionKeyConfig {
  key: Address;
  validUntil: number; // unix timestamp
  spendLimit: bigint; // in USDC (6 decimals)
}

/**
 * Session key for agent auto-execution
 *
 * @deprecated This interface stores the private key in plaintext.
 * Use SecureSessionKeyManager from './session-key-manager.js' instead,
 * which encrypts keys at rest and only decrypts for signing.
 */
export interface SessionKey {
  address: Address;
  /** @deprecated Private keys should not be stored in plaintext. Use SecureSessionKeyManager. */
  privateKey: Hex;
  config: SessionKeyConfig;
}

// ============ Vault Configuration ============

/**
 * AgentVault configuration
 */
export interface VaultConfig {
  address: Address;
  ownerX: bigint;
  ownerY: bigint;
  dailyLimit: bigint;
  autoExecuteThreshold: bigint;
  whitelistedProtocols: Address[];
}

// ============ Audit Log Types ============

export enum AuditEventType {
  PROPOSAL_CREATED = 'proposal_created',
  APPROVAL_REQUESTED = 'approval_requested',
  APPROVAL_RECEIVED = 'approval_received',
  APPROVAL_REJECTED = 'approval_rejected',
  APPROVAL_EXPIRED = 'approval_expired',
  EXECUTION_STARTED = 'execution_started',
  EXECUTION_SUCCESS = 'execution_success',
  EXECUTION_FAILED = 'execution_failed',
  SESSION_KEY_GRANTED = 'session_key_granted',
  SESSION_KEY_REVOKED = 'session_key_revoked',
}

export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  eventType: AuditEventType;
  proposalId?: string;
  vaultAddress: Address;
  userOpHash?: Hex;
  txHash?: Hex;
  details: Record<string, unknown>;
}

// ============ Error Types ============

export class UserOpBuildError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'UserOpBuildError';
  }
}

export class ApprovalFlowError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'ApprovalFlowError';
  }
}

export class SessionKeyError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'SessionKeyError';
  }
}
