import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  InMemoryAuditStorage,
  AuditLogger,
  createInMemoryAuditLogger,
} from './audit-logger.js';
import { AuditEventType, type AuditLogEntry } from './types.js';
import type { Address, Hex } from 'viem';

const VAULT: Address = '0x1234567890abcdef1234567890abcdef12345678';

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: 'test-1',
    timestamp: new Date(),
    eventType: AuditEventType.PROPOSAL_CREATED,
    vaultAddress: VAULT,
    details: {},
    ...overrides,
  };
}

describe('InMemoryAuditStorage', () => {
  let storage: InMemoryAuditStorage;

  beforeEach(() => {
    storage = new InMemoryAuditStorage(100);
  });

  it('stores and retrieves entries by vault', async () => {
    await storage.store(makeEntry({ id: 'a' }));
    await storage.store(
      makeEntry({
        id: 'b',
        vaultAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      })
    );

    const results = await storage.queryByVault(VAULT);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('a');
  });

  it('queries by vault address case-insensitively', async () => {
    await storage.store(makeEntry({ id: 'a' }));
    const results = await storage.queryByVault(VAULT.toUpperCase() as Address);
    expect(results).toHaveLength(1);
  });

  it('queries by proposal ID', async () => {
    await storage.store(makeEntry({ id: 'a', proposalId: 'prop-1' }));
    await storage.store(makeEntry({ id: 'b', proposalId: 'prop-2' }));

    const results = await storage.queryByProposal('prop-1');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('a');
  });

  it('queries by event type', async () => {
    await storage.store(
      makeEntry({ id: 'a', eventType: AuditEventType.EXECUTION_SUCCESS })
    );
    await storage.store(
      makeEntry({ id: 'b', eventType: AuditEventType.EXECUTION_FAILED })
    );
    await storage.store(
      makeEntry({ id: 'c', eventType: AuditEventType.EXECUTION_SUCCESS })
    );

    const results = await storage.queryByEventType(AuditEventType.EXECUTION_SUCCESS);
    expect(results).toHaveLength(2);
  });

  it('queries by time range', async () => {
    const t1 = new Date('2025-01-01');
    const t2 = new Date('2025-06-01');
    const t3 = new Date('2025-12-01');

    await storage.store(makeEntry({ id: 'a', timestamp: t1 }));
    await storage.store(makeEntry({ id: 'b', timestamp: t2 }));
    await storage.store(makeEntry({ id: 'c', timestamp: t3 }));

    const results = await storage.queryByTimeRange(
      new Date('2025-03-01'),
      new Date('2025-09-01')
    );
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('b');
  });

  it('deletes entries older than a given date', async () => {
    await storage.store(makeEntry({ id: 'old', timestamp: new Date('2024-01-01') }));
    await storage.store(makeEntry({ id: 'new', timestamp: new Date('2025-06-01') }));

    const deleted = await storage.deleteOlderThan(new Date('2025-01-01'));
    expect(deleted).toBe(1);

    const all = storage.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('new');
  });

  it('respects maxEntries limit', async () => {
    const small = new InMemoryAuditStorage(3);
    for (let i = 0; i < 5; i++) {
      await small.store(makeEntry({ id: `entry-${i}` }));
    }
    expect(small.getAll()).toHaveLength(3);
    // Should keep the most recent entries
    expect(small.getAll()[0].id).toBe('entry-2');
  });

  it('returns results in reverse chronological order', async () => {
    await storage.store(makeEntry({ id: 'first', proposalId: 'p' }));
    await storage.store(makeEntry({ id: 'second', proposalId: 'p' }));

    const results = await storage.queryByProposal('p');
    expect(results[0].id).toBe('second');
    expect(results[1].id).toBe('first');
  });
});

describe('AuditLogger', () => {
  let logger: AuditLogger;
  let storage: InMemoryAuditStorage;

  beforeEach(() => {
    storage = new InMemoryAuditStorage();
    logger = new AuditLogger({
      storage,
      consoleLog: false,
      retentionDays: 90,
    });
  });

  afterEach(() => {
    logger.close();
  });

  it('logs proposal creation', async () => {
    await logger.logProposalCreated(VAULT, 'prop-1', {
      fromProtocol: 'Aave V3',
      toProtocol: 'Compound V3',
      amount: '1000000000',
      apyDelta: 0.5,
    });

    const entries = storage.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].eventType).toBe(AuditEventType.PROPOSAL_CREATED);
    expect(entries[0].proposalId).toBe('prop-1');
    expect(entries[0].vaultAddress).toBe(VAULT);
  });

  it('logs execution success with tx hash', async () => {
    const txHash = '0xabcdef1234567890' as Hex;
    const userOpHash = '0x1111111111111111' as Hex;

    await logger.logExecutionSuccess(VAULT, 'prop-2', userOpHash, txHash, {
      gasUsed: '50000',
      blockNumber: 12345,
    });

    const entries = storage.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].eventType).toBe(AuditEventType.EXECUTION_SUCCESS);
    expect(entries[0].txHash).toBe(txHash);
    expect(entries[0].userOpHash).toBe(userOpHash);
  });

  it('logs session key events', async () => {
    await logger.logSessionKeyGranted(VAULT, {
      sessionKeyAddress: '0xaaaa000000000000000000000000000000000001' as Address,
      validUntil: '2025-12-31',
      spendLimit: '1000000000',
    });

    await logger.logSessionKeyRevoked(VAULT, {
      sessionKeyAddress: '0xaaaa000000000000000000000000000000000001' as Address,
      reason: 'expired',
    });

    const entries = storage.getAll();
    expect(entries).toHaveLength(2);
    expect(entries[0].eventType).toBe(AuditEventType.SESSION_KEY_GRANTED);
    expect(entries[1].eventType).toBe(AuditEventType.SESSION_KEY_REVOKED);
  });

  it('getRecentExecutions merges success and failure', async () => {
    await logger.logExecutionSuccess(VAULT, 'p1', '0xaa' as Hex, '0xbb' as Hex, {});
    await logger.logExecutionFailed(VAULT, 'p2', '0xcc' as Hex, {
      error: 'reverted',
    });

    const recent = await logger.getRecentExecutions();
    expect(recent).toHaveLength(2);
  });

  it('getVaultHistory and getProposalHistory delegate to storage', async () => {
    await logger.logProposalCreated(VAULT, 'p1', {
      fromProtocol: 'Aave',
      toProtocol: 'Compound',
      amount: '100',
      apyDelta: 0.1,
    });

    const vaultHistory = await logger.getVaultHistory(VAULT);
    expect(vaultHistory).toHaveLength(1);

    const proposalHistory = await logger.getProposalHistory('p1');
    expect(proposalHistory).toHaveLength(1);
  });
});

describe('createInMemoryAuditLogger', () => {
  it('creates a working logger', async () => {
    const logger = createInMemoryAuditLogger();
    // Should not throw
    await logger.logApprovalExpired(VAULT, 'p1');
    logger.close();
  });
});
