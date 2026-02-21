/**
 * AgentVault - Agentic Stablecoin Yield Optimizer
 *
 * Agent 3 Components: UserOp Builder & Approval Flow
 *
 * This module provides:
 * - UserOperation building for ERC-4337 v0.7
 * - Passkey (WebAuthn) signature handling
 * - Session key management
 * - Approval request creation (notifications handled by OpenClaw)
 * - Comprehensive audit logging
 */

// ============ Types ============
export * from './types.js';

// ============ Wallet Manager ============
export {
  WalletManager,
  type WalletManagerConfig,
  createWalletManager,
  createTestnetWalletManager,
  ProtocolEncoders,
} from './wallet-manager.js';

// ============ Approval Flow ============
export {
  ApprovalFlow,
  type ApprovalFlowConfig,
  type ApprovalNotification,
  createApprovalFlow,
} from './approval-flow.js';

// ============ Audit Logger ============
export {
  AuditLogger,
  type AuditLoggerConfig,
  type AuditStorage,
  InMemoryAuditStorage,
  FileAuditStorage,
  createInMemoryAuditLogger,
  createFileAuditLogger,
} from './audit-logger.js';

// ============ Session Key Manager ============
export {
  SecureSessionKeyManager,
} from './session-key-manager.js';

// ============ Yield Monitor ============
export {
  YieldMonitor,
  type YieldMonitorConfig,
} from './yield-monitor.js';

// ============ Agent Runner ============
export {
  AgentRunner,
  type AgentConfig,
  loadConfigFromEnv,
} from './agent.js';

// ============ Config ============
export {
  ADDRESSES,
  YIELD_CONFIG,
  USDC_DECIMALS,
} from './config.js';

// ============ Re-export viem utilities ============
export { base, baseSepolia } from 'viem/chains';
