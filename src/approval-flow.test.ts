import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApprovalFlow, type ApprovalFlowConfig } from './approval-flow.js';
import { WalletManager } from './wallet-manager.js';
import {
  Protocol,
  ProposalStatus,
  ApprovalFlowError,
  type PackedUserOperation,
  type WebAuthnAuth,
} from './types.js';
import type { Hex, Address } from 'viem';

// ============ Mocks ============

const VAULT: Address = '0x1111111111111111111111111111111111111111';

function makeMockUserOp(overrides: Partial<PackedUserOperation> = {}): PackedUserOperation {
  return {
    sender: VAULT,
    nonce: 0n,
    initCode: '0x',
    callData: '0x',
    accountGasLimits: '0x' + '0'.repeat(64),
    preVerificationGas: 100000n,
    gasFees: '0x' + '0'.repeat(64),
    paymasterAndData: '0x',
    signature: '0x',
    ...overrides,
  } as PackedUserOperation;
}

function createMockWalletManager() {
  return {
    prepareForPasskeySigning: vi.fn().mockResolvedValue({
      userOpHash: '0xdeadbeef' as Hex,
      userOp: makeMockUserOp(),
    }),
    attachPasskeySignature: vi.fn().mockImplementation((userOp, _auth) => ({
      ...userOp,
      signature: '0xsigned',
    })),
    submitUserOp: vi.fn().mockResolvedValue('0xopHash' as Hex),
    waitForUserOp: vi.fn().mockResolvedValue({
      txHash: '0xtxHash' as Hex,
      success: true,
    }),
  } as unknown as WalletManager;
}

const DEFAULT_CONFIG: ApprovalFlowConfig = {
  approvalUiBaseUrl: 'https://approve.test',
  approvalTimeout: 60_000, // 1 minute for tests
};

describe('ApprovalFlow', () => {
  let flow: ApprovalFlow;
  let mockWallet: WalletManager;

  beforeEach(() => {
    mockWallet = createMockWalletManager();
    flow = new ApprovalFlow(mockWallet, DEFAULT_CONFIG);
  });

  describe('createProposal', () => {
    it('creates a proposal with correct fields', () => {
      const proposal = flow.createProposal({
        fromProtocol: Protocol.AAVE_V3,
        toProtocol: Protocol.COMPOUND_V3,
        amount: 1_000_000_000n, // $1000
        fromAPY: 0.03,
        toAPY: 0.05,
        estimatedGasCost: 50000n,
      });

      expect(proposal.id).toBeTruthy();
      expect(proposal.fromProtocol).toBe(Protocol.AAVE_V3);
      expect(proposal.toProtocol).toBe(Protocol.COMPOUND_V3);
      expect(proposal.amount).toBe(1_000_000_000n);
      expect(proposal.apyDelta).toBeCloseTo(0.02);
      expect(proposal.status).toBe(ProposalStatus.PENDING_APPROVAL);
      expect(proposal.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('each proposal gets a unique ID', () => {
      const p1 = flow.createProposal({
        fromProtocol: Protocol.AAVE_V3,
        toProtocol: Protocol.COMPOUND_V3,
        amount: 100n,
        fromAPY: 0.03,
        toAPY: 0.05,
        estimatedGasCost: 0n,
      });
      const p2 = flow.createProposal({
        fromProtocol: Protocol.AAVE_V3,
        toProtocol: Protocol.COMPOUND_V3,
        amount: 100n,
        fromAPY: 0.03,
        toAPY: 0.05,
        estimatedGasCost: 0n,
      });
      expect(p1.id).not.toBe(p2.id);
    });
  });

  describe('getProposal / updateProposalStatus', () => {
    it('retrieves a created proposal', () => {
      const proposal = flow.createProposal({
        fromProtocol: Protocol.AAVE_V3,
        toProtocol: Protocol.MORPHO_BLUE,
        amount: 100n,
        fromAPY: 0.02,
        toAPY: 0.06,
        estimatedGasCost: 0n,
      });

      expect(flow.getProposal(proposal.id)).toBe(proposal);
    });

    it('returns undefined for unknown ID', () => {
      expect(flow.getProposal('nonexistent')).toBeUndefined();
    });

    it('updates proposal status', () => {
      const proposal = flow.createProposal({
        fromProtocol: Protocol.AAVE_V3,
        toProtocol: Protocol.MOONWELL,
        amount: 100n,
        fromAPY: 0.02,
        toAPY: 0.04,
        estimatedGasCost: 0n,
      });

      flow.updateProposalStatus(proposal.id, ProposalStatus.APPROVED);
      expect(flow.getProposal(proposal.id)!.status).toBe(ProposalStatus.APPROVED);
    });
  });

  describe('requestApproval', () => {
    it('creates approval request and notification', async () => {
      const proposal = flow.createProposal({
        fromProtocol: Protocol.AAVE_V3,
        toProtocol: Protocol.COMPOUND_V3,
        amount: 5_000_000_000n, // $5000
        fromAPY: 0.03,
        toAPY: 0.055,
        estimatedGasCost: 100000n,
      });

      const { request, notification } = await flow.requestApproval(
        proposal,
        VAULT,
        makeMockUserOp()
      );

      expect(request.proposalId).toBe(proposal.id);
      expect(request.vaultAddress).toBe(VAULT);
      expect(request.approvalUrl).toContain('https://approve.test');
      expect(request.approvalUrl).toContain(proposal.id);

      expect(notification.proposalId).toBe(proposal.id);
      expect(notification.message).toContain('Rebalance USDC');
      expect(notification.message).toContain('Aave V3');
      expect(notification.message).toContain('Compound V3');
      expect(notification.displayData.amount).toContain('5,000');
    });

    it('tracks pending approvals', async () => {
      const proposal = flow.createProposal({
        fromProtocol: Protocol.AAVE_V3,
        toProtocol: Protocol.COMPOUND_V3,
        amount: 100n,
        fromAPY: 0.03,
        toAPY: 0.05,
        estimatedGasCost: 0n,
      });

      await flow.requestApproval(proposal, VAULT, makeMockUserOp());

      const pending = flow.getPendingApprovals();
      expect(pending).toHaveLength(1);
      expect(pending[0].proposalId).toBe(proposal.id);
    });
  });

  describe('processApproval', () => {
    it('processes an approved response and returns signed UserOp', async () => {
      const proposal = flow.createProposal({
        fromProtocol: Protocol.AAVE_V3,
        toProtocol: Protocol.COMPOUND_V3,
        amount: 100n,
        fromAPY: 0.03,
        toAPY: 0.05,
        estimatedGasCost: 0n,
      });

      await flow.requestApproval(proposal, VAULT, makeMockUserOp());

      const webAuthnAuth: WebAuthnAuth = {
        authenticatorData: '0xaabbcc',
        clientDataJSON: '{}',
        challengeIndex: 0n,
        typeIndex: 0n,
        r: 1n,
        s: 2n,
      };

      const signedOp = await flow.processApproval({
        proposalId: proposal.id,
        approved: true,
        webAuthnAuth,
        timestamp: new Date(),
      });

      expect(signedOp.signature).toBe('0xsigned');
      expect(flow.getProposal(proposal.id)!.status).toBe(ProposalStatus.APPROVED);
      expect(flow.getPendingApprovals()).toHaveLength(0);
    });

    it('throws for unknown proposal', async () => {
      await expect(
        flow.processApproval({
          proposalId: 'nonexistent',
          approved: true,
          timestamp: new Date(),
        })
      ).rejects.toThrow(ApprovalFlowError);
    });

    it('throws on rejection and updates status', async () => {
      const proposal = flow.createProposal({
        fromProtocol: Protocol.AAVE_V3,
        toProtocol: Protocol.COMPOUND_V3,
        amount: 100n,
        fromAPY: 0.03,
        toAPY: 0.05,
        estimatedGasCost: 0n,
      });

      await flow.requestApproval(proposal, VAULT, makeMockUserOp());

      await expect(
        flow.processApproval({
          proposalId: proposal.id,
          approved: false,
          timestamp: new Date(),
        })
      ).rejects.toThrow(/rejected/);

      expect(flow.getProposal(proposal.id)!.status).toBe(ProposalStatus.REJECTED);
    });

    it('throws when approval is expired', async () => {
      // Use a very short timeout
      const shortFlow = new ApprovalFlow(mockWallet, {
        ...DEFAULT_CONFIG,
        approvalTimeout: 1, // 1ms
      });

      const proposal = shortFlow.createProposal({
        fromProtocol: Protocol.AAVE_V3,
        toProtocol: Protocol.COMPOUND_V3,
        amount: 100n,
        fromAPY: 0.03,
        toAPY: 0.05,
        estimatedGasCost: 0n,
      });

      await shortFlow.requestApproval(proposal, VAULT, makeMockUserOp());

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 10));

      await expect(
        shortFlow.processApproval({
          proposalId: proposal.id,
          approved: true,
          webAuthnAuth: {
            authenticatorData: '0x',
            clientDataJSON: '',
            challengeIndex: 0n,
            typeIndex: 0n,
            r: 0n,
            s: 0n,
          },
          timestamp: new Date(),
        })
      ).rejects.toThrow(/expired/);

      expect(shortFlow.getProposal(proposal.id)!.status).toBe(ProposalStatus.EXPIRED);
    });

    it('throws when missing webAuthn signature', async () => {
      const proposal = flow.createProposal({
        fromProtocol: Protocol.AAVE_V3,
        toProtocol: Protocol.COMPOUND_V3,
        amount: 100n,
        fromAPY: 0.03,
        toAPY: 0.05,
        estimatedGasCost: 0n,
      });

      await flow.requestApproval(proposal, VAULT, makeMockUserOp());

      await expect(
        flow.processApproval({
          proposalId: proposal.id,
          approved: true,
          // No webAuthnAuth
          timestamp: new Date(),
        })
      ).rejects.toThrow(/Missing WebAuthn/);
    });
  });

  describe('rejectProposal', () => {
    it('rejects a pending proposal', async () => {
      const proposal = flow.createProposal({
        fromProtocol: Protocol.AAVE_V3,
        toProtocol: Protocol.COMPOUND_V3,
        amount: 100n,
        fromAPY: 0.03,
        toAPY: 0.05,
        estimatedGasCost: 0n,
      });

      await flow.requestApproval(proposal, VAULT, makeMockUserOp());
      flow.rejectProposal(proposal.id, 'telegram_callback');

      expect(flow.getProposal(proposal.id)!.status).toBe(ProposalStatus.REJECTED);
      expect(flow.getPendingApprovals()).toHaveLength(0);
    });

    it('silently ignores unknown proposal', () => {
      expect(() => flow.rejectProposal('nonexistent')).not.toThrow();
    });
  });

  describe('cleanupExpired', () => {
    it('removes expired pending approvals', async () => {
      const shortFlow = new ApprovalFlow(mockWallet, {
        ...DEFAULT_CONFIG,
        approvalTimeout: 1,
      });

      const proposal = shortFlow.createProposal({
        fromProtocol: Protocol.AAVE_V3,
        toProtocol: Protocol.COMPOUND_V3,
        amount: 100n,
        fromAPY: 0.03,
        toAPY: 0.05,
        estimatedGasCost: 0n,
      });

      await shortFlow.requestApproval(proposal, VAULT, makeMockUserOp());
      await new Promise((r) => setTimeout(r, 10));

      shortFlow.cleanupExpired();

      expect(shortFlow.getPendingApprovals()).toHaveLength(0);
      expect(shortFlow.getProposal(proposal.id)!.status).toBe(ProposalStatus.EXPIRED);
    });
  });
});
