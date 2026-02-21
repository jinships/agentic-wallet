/**
 * AgentVault Main Agent
 *
 * Orchestrates:
 * - Yield monitoring and rate comparison
 * - Rebalance proposal creation
 * - Auto-execution for small amounts (session key)
 * - Approval requests for large amounts (passkey)
 * - UserOp submission to bundler
 *
 * Run with: npx tsx src/agent.ts
 */

import { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';

import { YieldMonitor, type ProtectedYieldComparison } from './yield-monitor.js';
import { WalletManager, ProtocolEncoders } from './wallet-manager.js';
import { ApprovalFlow, type ApprovalNotification } from './approval-flow.js';
import { SecureSessionKeyManager } from './session-key-manager.js';
import { AuditLogger, createFileAuditLogger } from './audit-logger.js';
import { YIELD_CONFIG, ADDRESSES, USDC_DECIMALS } from './config.js';
import { Protocol, type RebalanceProposal } from './types.js';

// Simple logger interface for agent
interface SimpleLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// ============ Configuration ============

export interface AgentConfig {
  /** Vault address to manage */
  vaultAddress: Address;
  /** RPC URL for Base */
  rpcUrl: string;
  /** Bundler URL (Pimlico, etc.) */
  bundlerUrl: string;
  /** Chain to use */
  chain: 'base' | 'base-sepolia';
  /** Master key for session key encryption */
  sessionKeyMasterKey: Hex;
  /** Session key address (must be granted on-chain) */
  sessionKeyAddress: Address;
  /** Session key private key */
  sessionKeyPrivate: Hex;
  /** Approval UI base URL */
  approvalUiBaseUrl: string;
  /** Polling interval in ms (default: 1 hour) */
  pollIntervalMs?: number;
  /** Auto-execute threshold in USDC (6 decimals) */
  autoExecuteThreshold?: bigint;
  /** Callback when notification should be sent */
  onNotification?: (notification: ApprovalNotification) => Promise<void>;
}

function loadConfigFromEnv(): AgentConfig {
  const required = (key: string): string => {
    const value = process.env[key];
    if (!value) throw new Error(`Missing required environment variable: ${key}`);
    return value;
  };

  const optional = <T>(key: string, defaultValue: T): T => {
    const value = process.env[key];
    return value !== undefined ? (value as unknown as T) : defaultValue;
  };

  return {
    vaultAddress: required('VAULT_ADDRESS') as Address,
    rpcUrl: required('RPC_URL'),
    bundlerUrl: required('BUNDLER_URL'),
    chain: optional('CHAIN', 'base-sepolia') as 'base' | 'base-sepolia',
    sessionKeyMasterKey: required('SESSION_KEY_MASTER') as Hex,
    sessionKeyAddress: required('SESSION_KEY_ADDRESS') as Address,
    sessionKeyPrivate: required('SESSION_KEY_PRIVATE') as Hex,
    approvalUiBaseUrl: optional('APPROVAL_UI_URL', 'http://localhost:3000'),
    pollIntervalMs: Number(optional('POLL_INTERVAL_MS', String(YIELD_CONFIG.POLL_INTERVAL_MS))),
    autoExecuteThreshold: BigInt(
      optional('AUTO_EXECUTE_THRESHOLD', String(YIELD_CONFIG.AUTO_EXECUTE_THRESHOLD))
    ),
  };
}

// ============ Agent Class ============

export class AgentRunner {
  private readonly config: AgentConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any; // PublicClient - typed as any due to L2 chain type complexities
  private readonly yieldMonitor: YieldMonitor;
  private readonly walletManager: WalletManager;
  private readonly approvalFlow: ApprovalFlow;
  private readonly sessionKeyManager: SecureSessionKeyManager;
  private readonly auditLogger: AuditLogger;
  private readonly logger: SimpleLogger;

  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;

  // Track current positions
  private currentProtocol: Protocol | null = null;
  private currentBalance: bigint = 0n;

  constructor(config: AgentConfig) {
    this.config = config;
    this.logger = createAgentLogger();

    // Initialize viem client
    const chain = config.chain === 'base' ? base : baseSepolia;
    this.client = createPublicClient({
      chain,
      transport: http(config.rpcUrl),
    });

    // Initialize yield monitor
    this.yieldMonitor = new YieldMonitor(this.client, {
      useTWAP: true,
      enableAnomalyDetection: true,
      useDeFiLlamaFallback: true,
    });

    // Initialize wallet manager
    this.walletManager = new WalletManager({
      publicClient: this.client,
      bundlerUrl: config.bundlerUrl,
      chain,
    });

    // Initialize approval flow
    this.approvalFlow = new ApprovalFlow(this.walletManager, {
      approvalUiBaseUrl: config.approvalUiBaseUrl,
    });

    // Initialize session key manager
    this.sessionKeyManager = new SecureSessionKeyManager(config.sessionKeyMasterKey);

    // Initialize audit logger
    this.auditLogger = createFileAuditLogger('./logs/audit');

    this.logger.info('Agent initialized', {
      vaultAddress: config.vaultAddress,
      chain: config.chain,
    });
  }

  // ============ Main Loop ============

  /**
   * Start the agent monitoring loop.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Agent is already running');
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting agent...');

    // Load session key
    this.loadSessionKey();

    // Initial position check
    await this.refreshCurrentPosition();

    // Run initial check
    await this.checkAndRebalance();

    // Start polling loop
    this.pollTimer = setInterval(async () => {
      try {
        await this.checkAndRebalance();
      } catch (error) {
        this.logger.error('Error in polling loop', { error: String(error) });
      }
    }, this.config.pollIntervalMs);

    this.logger.info('Agent started', {
      pollIntervalMs: this.config.pollIntervalMs,
    });
  }

  /**
   * Stop the agent.
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.logger.info('Agent stopped');
  }

  // ============ Core Logic ============

  /**
   * Check yields and rebalance if beneficial.
   */
  private async checkAndRebalance(): Promise<void> {
    this.logger.info('Checking yields...');

    try {
      // Get yield comparison
      const comparison = await this.yieldMonitor.compareYields(this.config.vaultAddress);

      this.logger.info('Yield comparison complete', {
        best: comparison.bestProtocol.protocolId,
        bestApy: (comparison.bestProtocol.apyPercent * 100).toFixed(2) + '%',
        current: this.currentProtocol,
        shouldRebalance: comparison.shouldRebalance,
      });

      // Check if rebalance is rejected due to anomalies
      if (comparison.rejectReason) {
        this.logger.warn('Rebalance rejected', { reason: comparison.rejectReason });
        return;
      }

      // Check if rebalance is needed
      if (!comparison.shouldRebalance) {
        this.logger.info('No rebalance needed');
        return;
      }

      // Determine amount to rebalance
      const amount = await this.getRebalanceAmount();
      if (amount === 0n) {
        this.logger.info('No balance to rebalance');
        return;
      }

      // Create proposal
      const fromProtocol = this.currentProtocol ?? Protocol.AAVE_V3;
      const toProtocol = this.protocolIdToEnum(comparison.bestProtocol.protocolId);

      const proposal = this.approvalFlow.createProposal({
        fromProtocol,
        toProtocol,
        amount,
        fromAPY: comparison.currentProtocol?.apyPercent ?? 0,
        toAPY: comparison.bestProtocol.apyPercent,
        estimatedGasCost: await this.estimateGasCost(),
      });

      this.logger.info('Created rebalance proposal', {
        proposalId: proposal.id,
        from: fromProtocol,
        to: toProtocol,
        amount: this.formatUsdc(amount),
        apyDelta: (proposal.apyDelta * 100).toFixed(2) + '%',
      });

      // Decide: auto-execute or request approval
      if (amount <= this.config.autoExecuteThreshold!) {
        await this.autoExecute(proposal);
      } else {
        await this.requestApproval(proposal);
      }
    } catch (error) {
      this.logger.error('Failed to check/rebalance', { error: String(error) });
    }
  }

  /**
   * Auto-execute a rebalance using session key.
   */
  private async autoExecute(proposal: RebalanceProposal): Promise<void> {
    this.logger.info('Auto-executing with session key', { proposalId: proposal.id });

    try {
      // Get session key for signing
      const sessionKey = this.sessionKeyManager.decryptForSigning(this.config.sessionKeyAddress);

      // Build the rebalance UserOp
      const { userOp, protocolData } = this.buildRebalanceData(proposal);

      // Get the full UserOp
      const builtUserOp = await this.walletManager.buildExecuteStrategyOp(
        this.config.vaultAddress,
        this.getProtocolAddress(proposal.toProtocol),
        protocolData
      );

      // Sign with session key
      const signedUserOp = await this.walletManager.signWithSessionKey(builtUserOp, {
        address: sessionKey.address,
        privateKey: sessionKey.privateKey,
        config: {
          key: sessionKey.address,
          validUntil: sessionKey.config.validUntil,
          spendLimit: sessionKey.config.spendLimit,
        },
      });

      // Submit to bundler
      this.logger.info('Submitting to bundler...');
      const userOpHash = await this.walletManager.submitUserOp(signedUserOp);

      this.logger.info('UserOp submitted', { userOpHash });

      // Wait for inclusion
      const result = await this.walletManager.waitForUserOp(userOpHash);

      if (result.success) {
        this.logger.info('Rebalance executed successfully', {
          proposalId: proposal.id,
          txHash: result.txHash,
        });

        // Update current position
        this.currentProtocol = proposal.toProtocol;

        await this.auditLogger.logExecutionSuccess(
          this.config.vaultAddress,
          proposal.id,
          userOpHash,
          result.txHash,
          { gasUsed: undefined, blockNumber: undefined }
        );
      } else {
        this.logger.error('Rebalance execution failed', {
          proposalId: proposal.id,
          txHash: result.txHash,
        });

        await this.auditLogger.logExecutionFailed(
          this.config.vaultAddress,
          proposal.id,
          userOpHash,
          { error: 'Execution reverted', revertReason: undefined }
        );
      }
    } catch (error) {
      this.logger.error('Auto-execution failed', { proposalId: proposal.id, error: String(error) });
      throw error;
    }
  }

  /**
   * Request approval for a large rebalance.
   */
  private async requestApproval(proposal: RebalanceProposal): Promise<void> {
    this.logger.info('Requesting approval (amount exceeds threshold)', {
      proposalId: proposal.id,
      amount: this.formatUsdc(proposal.amount),
      threshold: this.formatUsdc(this.config.autoExecuteThreshold!),
    });

    try {
      // Build the UserOp
      const { protocolData } = this.buildRebalanceData(proposal);
      const userOp = await this.walletManager.buildExecuteStrategyOp(
        this.config.vaultAddress,
        this.getProtocolAddress(proposal.toProtocol),
        protocolData
      );

      // Create approval request
      const { notification } = await this.approvalFlow.requestApproval(
        proposal,
        this.config.vaultAddress,
        userOp
      );

      this.logger.info('Approval request created', {
        proposalId: proposal.id,
        approvalUrl: notification.approvalUrl,
        expiresAt: notification.expiresAt.toISOString(),
      });

      // Send notification via callback
      if (this.config.onNotification) {
        await this.config.onNotification(notification);
      } else {
        // Default: log the notification for manual handling
        console.log('\n========== APPROVAL REQUIRED ==========');
        console.log(notification.message);
        console.log('\nApproval URL:', notification.approvalUrl);
        console.log('=========================================\n');
      }
    } catch (error) {
      this.logger.error('Failed to create approval request', {
        proposalId: proposal.id,
        error: String(error),
      });
      throw error;
    }
  }

  /**
   * Process an approval response from the UI.
   */
  async processApproval(proposalId: string, webAuthnAuth: any): Promise<{ txHash: Hex }> {
    this.logger.info('Processing approval', { proposalId });

    try {
      // Get the signed UserOp
      const signedUserOp = await this.approvalFlow.processApproval({
        proposalId,
        approved: true,
        webAuthnAuth,
        timestamp: new Date(),
      });

      // Submit to bundler
      const userOpHash = await this.walletManager.submitUserOp(signedUserOp);

      this.logger.info('UserOp submitted after approval', { userOpHash });

      // Wait for inclusion
      const result = await this.walletManager.waitForUserOp(userOpHash);

      if (result.success) {
        this.logger.info('Approved transaction executed', { txHash: result.txHash });
      } else {
        this.logger.error('Approved transaction failed', { txHash: result.txHash });
      }

      return { txHash: result.txHash };
    } catch (error) {
      this.logger.error('Failed to process approval', { proposalId, error: String(error) });
      throw error;
    }
  }

  // ============ Helper Methods ============

  private loadSessionKey(): void {
    // Check if session key is already loaded
    const existing = this.sessionKeyManager.getEncryptedKey(this.config.sessionKeyAddress);
    if (existing) {
      this.logger.info('Session key already loaded', { address: this.config.sessionKeyAddress });
      return;
    }

    // Import the session key
    this.sessionKeyManager.importSessionKey(this.config.sessionKeyPrivate, {
      validUntil: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days
      spendLimit: 1000n * 10n ** BigInt(USDC_DECIMALS), // $1000
    });

    this.logger.info('Session key imported', { address: this.config.sessionKeyAddress });
  }

  private async refreshCurrentPosition(): Promise<void> {
    // Check balances across all protocols to determine current position
    const protocols = this.yieldMonitor.getProtocols();

    for (const protocol of protocols) {
      try {
        const balance = await protocol.getBalance(this.config.vaultAddress);
        if (balance > 0n) {
          this.currentProtocol = this.protocolIdToEnum(protocol.id);
          this.currentBalance = balance;
          this.logger.info('Found current position', {
            protocol: protocol.id,
            balance: this.formatUsdc(balance),
          });
          return;
        }
      } catch {
        // Protocol might not have a position
      }
    }

    this.logger.info('No existing position found');
  }

  private async getRebalanceAmount(): Promise<bigint> {
    // Use current balance, or check USDC balance if no position
    if (this.currentBalance > 0n) {
      return this.currentBalance;
    }

    // Check raw USDC balance in vault
    try {
      const balance = (await this.client.readContract({
        address: ADDRESSES.USDC as Address,
        abi: [
          {
            name: 'balanceOf',
            type: 'function',
            inputs: [{ name: 'account', type: 'address' }],
            outputs: [{ type: 'uint256' }],
            stateMutability: 'view',
          },
        ],
        functionName: 'balanceOf',
        args: [this.config.vaultAddress],
      })) as bigint;

      return balance;
    } catch {
      return 0n;
    }
  }

  private buildRebalanceData(proposal: RebalanceProposal): { userOp: null; protocolData: Hex } {
    // Encode deposit to new protocol based on protocol type
    let protocolData: Hex;

    switch (proposal.toProtocol) {
      case Protocol.AAVE_V3:
        protocolData = ProtocolEncoders.aaveSupply(
          ADDRESSES.USDC as Address,
          proposal.amount,
          this.config.vaultAddress
        );
        break;
      case Protocol.COMPOUND_V3:
        protocolData = ProtocolEncoders.compoundSupply(ADDRESSES.USDC as Address, proposal.amount);
        break;
      case Protocol.MORPHO_BLUE:
        protocolData = ProtocolEncoders.erc4626Deposit(proposal.amount, this.config.vaultAddress);
        break;
      case Protocol.MOONWELL:
        protocolData = ProtocolEncoders.moonwellMint(proposal.amount);
        break;
      default:
        throw new Error(`Unknown protocol: ${proposal.toProtocol}`);
    }

    return { userOp: null, protocolData };
  }

  private async estimateGasCost(): Promise<bigint> {
    // Rough estimate for Base L2: ~0.001 ETH for a rebalance
    // In production, this would be more precise
    return 1_000_000_000_000_000n; // 0.001 ETH in wei
  }

  private getProtocolAddress(protocol: Protocol): Address {
    const addresses: Record<Protocol, Address> = {
      [Protocol.AAVE_V3]: ADDRESSES.AAVE_POOL as Address,
      [Protocol.COMPOUND_V3]: ADDRESSES.COMPOUND_CUSDC as Address,
      [Protocol.MORPHO_BLUE]: ADDRESSES.MORPHO_SPARK_VAULT as Address,
      [Protocol.MOONWELL]: ADDRESSES.MOONWELL_MUSDC as Address,
    };
    return addresses[protocol];
  }

  private protocolIdToEnum(id: string): Protocol {
    const mapping: Record<string, Protocol> = {
      aave: Protocol.AAVE_V3,
      compound: Protocol.COMPOUND_V3,
      morpho: Protocol.MORPHO_BLUE,
      moonwell: Protocol.MOONWELL,
    };
    return mapping[id] ?? Protocol.AAVE_V3;
  }

  private formatUsdc(amount: bigint): string {
    const num = Number(amount) / 10 ** USDC_DECIMALS;
    return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

// ============ Logger for Agent ============

function createAgentLogger(): SimpleLogger {
  return {
    info: (message: string, data?: Record<string, unknown>) => {
      console.log(
        JSON.stringify({
          level: 'info',
          timestamp: new Date().toISOString(),
          component: 'agent',
          message,
          ...data,
        })
      );
    },
    warn: (message: string, data?: Record<string, unknown>) => {
      console.log(
        JSON.stringify({
          level: 'warn',
          timestamp: new Date().toISOString(),
          component: 'agent',
          message,
          ...data,
        })
      );
    },
    error: (message: string, data?: Record<string, unknown>) => {
      console.error(
        JSON.stringify({
          level: 'error',
          timestamp: new Date().toISOString(),
          component: 'agent',
          message,
          ...data,
        })
      );
    },
  };
}

// ============ CLI Entry Point ============

async function main() {
  console.log('AgentVault Agent Starting...\n');

  // Load config from environment
  let config: AgentConfig;
  try {
    config = loadConfigFromEnv();
  } catch (error) {
    console.error('Failed to load configuration:', error);
    console.log('\nRequired environment variables:');
    console.log('  VAULT_ADDRESS       - Your vault contract address');
    console.log('  RPC_URL             - Base RPC URL (Alchemy, etc.)');
    console.log('  BUNDLER_URL         - Pimlico bundler URL');
    console.log('  SESSION_KEY_MASTER  - 32-byte hex key for encryption');
    console.log('  SESSION_KEY_ADDRESS - Address of granted session key');
    console.log('  SESSION_KEY_PRIVATE - Private key of session key');
    console.log('\nOptional:');
    console.log('  CHAIN               - "base" or "base-sepolia" (default)');
    console.log('  APPROVAL_UI_URL     - URL for approval UI');
    console.log('  POLL_INTERVAL_MS    - Polling interval (default: 3600000)');
    console.log('  AUTO_EXECUTE_THRESHOLD - Auto-execute limit in USDC base units');
    process.exit(1);
  }

  // Create and start agent
  const agent = new AgentRunner(config);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, shutting down...');
    agent.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down...');
    agent.stop();
    process.exit(0);
  });

  // Start the agent
  await agent.start();
}

// Export for programmatic use
export { loadConfigFromEnv };

// Run if executed directly
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
