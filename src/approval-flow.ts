/**
 * ApprovalFlow - Manage transaction approval requests
 *
 * Handles:
 * - Creating approval requests with deep-links
 * - Tracking approval status and expiry
 * - Processing passkey signature responses
 *
 * NOTE: Notifications are handled by OpenClaw, not this module.
 * This module returns structured data that OpenClaw can use to
 * send notifications via Telegram or other channels.
 */

import { type Address, type Hex } from 'viem';
import { nanoid } from 'nanoid';

import {
  type PackedUserOperation,
  type RebalanceProposal,
  type ApprovalRequest,
  type ApprovalResponse,
  type ApprovalDisplayData,
  type WebAuthnAuth,
  type AuditLogEntry,
  ProposalStatus,
  AuditEventType,
  Protocol,
  ApprovalFlowError,
} from './types.js';
import { WalletManager } from './wallet-manager.js';

// ============ Configuration ============

export interface ApprovalFlowConfig {
  /** Base URL for the approval UI */
  approvalUiBaseUrl: string;
  /** Default approval timeout in milliseconds (24 hours) */
  approvalTimeout?: number;
  /** Callback for audit logging */
  onAuditLog?: (entry: AuditLogEntry) => void | Promise<void>;
}

const DEFAULT_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours

// ============ Notification Message (for OpenClaw) ============

/**
 * Structured notification data for OpenClaw to send via Telegram/etc.
 * OpenClaw handles the actual notification delivery.
 */
export interface ApprovalNotification {
  /** The proposal ID for tracking */
  proposalId: string;
  /** URL the user should open to approve */
  approvalUrl: string;
  /** Human-readable message */
  message: string;
  /** Structured data for rich notifications */
  displayData: ApprovalDisplayData;
  /** When this approval expires */
  expiresAt: Date;
}

// ============ ApprovalFlow Class ============

export class ApprovalFlow {
  private readonly config: ApprovalFlowConfig;
  private readonly walletManager: WalletManager;
  private readonly pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private readonly proposals: Map<string, RebalanceProposal> = new Map();

  constructor(walletManager: WalletManager, config: ApprovalFlowConfig) {
    this.walletManager = walletManager;
    this.config = config;
  }

  // ============ Proposal Management ============

  /**
   * Create a rebalancing proposal
   */
  createProposal(params: {
    fromProtocol: Protocol;
    toProtocol: Protocol;
    amount: bigint;
    fromAPY: number;
    toAPY: number;
    estimatedGasCost: bigint;
  }): RebalanceProposal {
    const timeout = this.config.approvalTimeout ?? DEFAULT_TIMEOUT;

    const proposal: RebalanceProposal = {
      id: nanoid(12),
      fromProtocol: params.fromProtocol,
      toProtocol: params.toProtocol,
      amount: params.amount,
      fromAPY: params.fromAPY,
      toAPY: params.toAPY,
      apyDelta: params.toAPY - params.fromAPY,
      estimatedGasCost: params.estimatedGasCost,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + timeout),
      status: ProposalStatus.PENDING_APPROVAL,
    };

    this.proposals.set(proposal.id, proposal);

    this.logAudit({
      eventType: AuditEventType.PROPOSAL_CREATED,
      proposalId: proposal.id,
      details: {
        fromProtocol: params.fromProtocol,
        toProtocol: params.toProtocol,
        amount: params.amount.toString(),
        apyDelta: proposal.apyDelta.toFixed(2),
      },
    });

    return proposal;
  }

  /**
   * Get a proposal by ID
   */
  getProposal(proposalId: string): RebalanceProposal | undefined {
    return this.proposals.get(proposalId);
  }

  /**
   * Update proposal status
   */
  updateProposalStatus(proposalId: string, status: ProposalStatus): void {
    const proposal = this.proposals.get(proposalId);
    if (proposal) {
      proposal.status = status;
    }
  }

  // ============ Approval Request Creation ============

  /**
   * Create an approval request.
   *
   * Returns an ApprovalNotification that can be passed to OpenClaw
   * for sending via Telegram or other notification channels.
   *
   * @param proposal The rebalancing proposal
   * @param vaultAddress The AgentVault address
   * @param userOp The unsigned UserOperation
   * @returns Approval request details + notification for OpenClaw
   */
  async requestApproval(
    proposal: RebalanceProposal,
    vaultAddress: Address,
    userOp: PackedUserOperation
  ): Promise<{ request: ApprovalRequest; notification: ApprovalNotification }> {
    // Get UserOp hash for signing
    const { userOpHash } = await this.walletManager.prepareForPasskeySigning(userOp);

    // Create display data
    const displayData = this.formatDisplayData(proposal);

    // Generate approval URL
    const approvalUrl = this.generateApprovalUrl(proposal.id, userOpHash, vaultAddress);

    const approvalRequest: ApprovalRequest = {
      proposalId: proposal.id,
      vaultAddress,
      userOpHash,
      userOp,
      displayData,
      approvalUrl,
      expiresAt: proposal.expiresAt,
    };

    // Store pending approval
    this.pendingApprovals.set(proposal.id, approvalRequest);

    this.logAudit({
      eventType: AuditEventType.APPROVAL_REQUESTED,
      proposalId: proposal.id,
      vaultAddress,
      userOpHash,
      details: {
        approvalUrl,
        expiresAt: proposal.expiresAt.toISOString(),
      },
    });

    // Create notification data for OpenClaw
    const notification: ApprovalNotification = {
      proposalId: proposal.id,
      approvalUrl,
      message: this.formatNotificationMessage(displayData, proposal.expiresAt),
      displayData,
      expiresAt: proposal.expiresAt,
    };

    return { request: approvalRequest, notification };
  }

  /**
   * Format proposal data for human-readable display
   */
  private formatDisplayData(proposal: RebalanceProposal): ApprovalDisplayData {
    const protocolNames: Record<Protocol, string> = {
      [Protocol.AAVE_V3]: 'Aave V3',
      [Protocol.COMPOUND_V3]: 'Compound V3',
      [Protocol.MORPHO_BLUE]: 'Morpho Blue',
      [Protocol.MOONWELL]: 'Moonwell',
    };

    // Format amount (USDC has 6 decimals)
    const amountNum = Number(proposal.amount) / 1e6;
    const formattedAmount = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amountNum);

    // Format gas cost in USD (assuming ~$0.001 per 1000 gas on Base)
    const gasCostUsd = Number(proposal.estimatedGasCost) * 0.000001;
    const formattedGas = gasCostUsd < 0.01 ? '<$0.01' : `$${gasCostUsd.toFixed(2)}`;

    return {
      action: 'Rebalance USDC',
      fromProtocol: protocolNames[proposal.fromProtocol],
      toProtocol: protocolNames[proposal.toProtocol],
      amount: formattedAmount,
      currentAPY: `${proposal.fromAPY.toFixed(2)}%`,
      newAPY: `${proposal.toAPY.toFixed(2)}%`,
      apyGain: `+${proposal.apyDelta.toFixed(2)}%`,
      estimatedGas: formattedGas,
    };
  }

  /**
   * Generate the approval UI URL with encoded parameters
   */
  private generateApprovalUrl(
    proposalId: string,
    userOpHash: Hex,
    vaultAddress: Address
  ): string {
    const params = new URLSearchParams({
      id: proposalId,
      hash: userOpHash,
      vault: vaultAddress,
    });

    return `${this.config.approvalUiBaseUrl}?${params.toString()}`;
  }

  /**
   * Format a human-readable notification message.
   * OpenClaw can use this directly or customize it.
   */
  private formatNotificationMessage(
    data: ApprovalDisplayData,
    expiresAt: Date
  ): string {
    const expiresIn = Math.round((expiresAt.getTime() - Date.now()) / 3600000);

    return [
      `AgentVault Approval Request`,
      ``,
      `Action: ${data.action}`,
      `Amount: ${data.amount}`,
      ``,
      `From: ${data.fromProtocol} (${data.currentAPY} APY)`,
      `To: ${data.toProtocol} (${data.newAPY} APY)`,
      ``,
      `APY Gain: ${data.apyGain}`,
      `Gas Cost: ${data.estimatedGas}`,
      ``,
      `Expires in ${expiresIn}h. Tap the link to approve with Face ID.`,
    ].join('\n');
  }

  // ============ Approval Processing ============

  /**
   * Process an approval response from the UI
   * @param response The approval response with signature
   * @returns Signed UserOperation ready for submission
   */
  async processApproval(response: ApprovalResponse): Promise<PackedUserOperation> {
    const pendingRequest = this.pendingApprovals.get(response.proposalId);

    if (!pendingRequest) {
      throw new ApprovalFlowError(
        `No pending approval found for proposal ${response.proposalId}`
      );
    }

    // Check expiry
    if (new Date() > pendingRequest.expiresAt) {
      this.updateProposalStatus(response.proposalId, ProposalStatus.EXPIRED);
      this.pendingApprovals.delete(response.proposalId);

      this.logAudit({
        eventType: AuditEventType.APPROVAL_EXPIRED,
        proposalId: response.proposalId,
        vaultAddress: pendingRequest.vaultAddress,
        details: {},
      });

      throw new ApprovalFlowError('Approval request has expired');
    }

    if (!response.approved) {
      this.updateProposalStatus(response.proposalId, ProposalStatus.REJECTED);
      this.pendingApprovals.delete(response.proposalId);

      this.logAudit({
        eventType: AuditEventType.APPROVAL_REJECTED,
        proposalId: response.proposalId,
        vaultAddress: pendingRequest.vaultAddress,
        details: {},
      });

      throw new ApprovalFlowError('User rejected the approval request');
    }

    if (!response.webAuthnAuth) {
      throw new ApprovalFlowError('Missing WebAuthn signature in approval');
    }

    // Attach passkey signature to UserOp
    const signedUserOp = this.walletManager.attachPasskeySignature(
      pendingRequest.userOp,
      response.webAuthnAuth
    );

    // Update status
    this.updateProposalStatus(response.proposalId, ProposalStatus.APPROVED);
    this.pendingApprovals.delete(response.proposalId);

    this.logAudit({
      eventType: AuditEventType.APPROVAL_RECEIVED,
      proposalId: response.proposalId,
      vaultAddress: pendingRequest.vaultAddress,
      userOpHash: pendingRequest.userOpHash,
      details: {
        timestamp: response.timestamp.toISOString(),
      },
    });

    return signedUserOp;
  }

  /**
   * Reject a proposal (can be called by OpenClaw when user rejects via Telegram)
   */
  rejectProposal(proposalId: string, source: string = 'user'): void {
    const pendingRequest = this.pendingApprovals.get(proposalId);

    if (pendingRequest) {
      this.updateProposalStatus(proposalId, ProposalStatus.REJECTED);
      this.pendingApprovals.delete(proposalId);

      this.logAudit({
        eventType: AuditEventType.APPROVAL_REJECTED,
        proposalId,
        vaultAddress: pendingRequest.vaultAddress,
        details: { source },
      });
    }
  }

  // ============ Execution ============

  /**
   * Execute a signed UserOperation
   */
  async executeApprovedUserOp(
    proposalId: string,
    signedUserOp: PackedUserOperation
  ): Promise<{ txHash: Hex; success: boolean }> {
    const proposal = this.proposals.get(proposalId);

    this.logAudit({
      eventType: AuditEventType.EXECUTION_STARTED,
      proposalId,
      vaultAddress: signedUserOp.sender,
      details: {},
    });

    try {
      // Submit to bundler
      const userOpHash = await this.walletManager.submitUserOp(signedUserOp);

      // Wait for inclusion
      const result = await this.walletManager.waitForUserOp(userOpHash, 60_000);

      if (proposal) {
        proposal.status = result.success
          ? ProposalStatus.EXECUTED
          : ProposalStatus.FAILED;
      }

      this.logAudit({
        eventType: result.success
          ? AuditEventType.EXECUTION_SUCCESS
          : AuditEventType.EXECUTION_FAILED,
        proposalId,
        vaultAddress: signedUserOp.sender,
        userOpHash,
        txHash: result.txHash,
        details: { success: result.success },
      });

      return result;
    } catch (error) {
      if (proposal) {
        proposal.status = ProposalStatus.FAILED;
      }

      this.logAudit({
        eventType: AuditEventType.EXECUTION_FAILED,
        proposalId,
        vaultAddress: signedUserOp.sender,
        details: {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });

      throw error;
    }
  }

  // ============ Cleanup ============

  /**
   * Clean up expired approvals.
   * Should be called periodically.
   */
  cleanupExpired(): void {
    const now = new Date();

    for (const [proposalId, request] of this.pendingApprovals.entries()) {
      if (now > request.expiresAt) {
        this.updateProposalStatus(proposalId, ProposalStatus.EXPIRED);
        this.pendingApprovals.delete(proposalId);

        this.logAudit({
          eventType: AuditEventType.APPROVAL_EXPIRED,
          proposalId,
          vaultAddress: request.vaultAddress,
          details: {},
        });
      }
    }
  }

  /**
   * Get all pending approval requests
   */
  getPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values());
  }

  // ============ Audit Logging ============

  private logAudit(
    params: Omit<AuditLogEntry, 'id' | 'timestamp' | 'vaultAddress'> & {
      vaultAddress?: Address;
    }
  ): void {
    const entry: AuditLogEntry = {
      id: nanoid(16),
      timestamp: new Date(),
      vaultAddress: params.vaultAddress ?? ('0x' as Address),
      eventType: params.eventType,
      proposalId: params.proposalId,
      userOpHash: params.userOpHash,
      txHash: params.txHash,
      details: params.details,
    };

    // Call the audit callback if configured
    if (this.config.onAuditLog) {
      try {
        this.config.onAuditLog(entry);
      } catch (error) {
        console.error('Audit log callback error:', error);
      }
    }

    // Also log to console in development
    if (process.env.NODE_ENV !== 'production') {
      console.log(
        `[AUDIT] ${entry.eventType}`,
        JSON.stringify(entry, null, 2)
      );
    }
  }
}

// ============ Factory Function ============

/**
 * Create an ApprovalFlow instance
 */
export function createApprovalFlow(
  walletManager: WalletManager,
  config: ApprovalFlowConfig
): ApprovalFlow {
  return new ApprovalFlow(walletManager, config);
}
