/**
 * AuditLogger - Comprehensive audit logging for AgentVault operations
 *
 * Tracks:
 * - All proposal creations with reasoning
 * - Every approval request/response
 * - All transaction executions with tx hashes
 * - Session key grants/revocations
 * - Errors and failures
 *
 * Supports multiple storage backends and retention policies.
 */

import { type Address, type Hex } from 'viem';
import { nanoid } from 'nanoid';
import { type AuditLogEntry, AuditEventType } from './types.js';

// ============ Storage Interface ============

/**
 * Interface for audit log storage backends
 */
export interface AuditStorage {
  /** Store an audit log entry */
  store(entry: AuditLogEntry): Promise<void>;
  /** Query entries by vault address */
  queryByVault(vaultAddress: Address, limit?: number): Promise<AuditLogEntry[]>;
  /** Query entries by proposal ID */
  queryByProposal(proposalId: string): Promise<AuditLogEntry[]>;
  /** Query entries by event type */
  queryByEventType(eventType: AuditEventType, limit?: number): Promise<AuditLogEntry[]>;
  /** Query entries within a time range */
  queryByTimeRange(start: Date, end: Date, limit?: number): Promise<AuditLogEntry[]>;
  /** Delete entries older than a given date (for retention policy) */
  deleteOlderThan(date: Date): Promise<number>;
}

// ============ In-Memory Storage (Development) ============

/**
 * Simple in-memory storage for development/testing
 * Not suitable for production - use FileStorage or a database
 */
export class InMemoryAuditStorage implements AuditStorage {
  private entries: AuditLogEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries: number = 10000) {
    this.maxEntries = maxEntries;
  }

  async store(entry: AuditLogEntry): Promise<void> {
    this.entries.push(entry);

    // Trim if over max
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  async queryByVault(vaultAddress: Address, limit = 100): Promise<AuditLogEntry[]> {
    return this.entries
      .filter((e) => e.vaultAddress.toLowerCase() === vaultAddress.toLowerCase())
      .slice(-limit)
      .reverse();
  }

  async queryByProposal(proposalId: string): Promise<AuditLogEntry[]> {
    return this.entries.filter((e) => e.proposalId === proposalId).reverse();
  }

  async queryByEventType(eventType: AuditEventType, limit = 100): Promise<AuditLogEntry[]> {
    return this.entries
      .filter((e) => e.eventType === eventType)
      .slice(-limit)
      .reverse();
  }

  async queryByTimeRange(start: Date, end: Date, limit = 1000): Promise<AuditLogEntry[]> {
    return this.entries
      .filter((e) => e.timestamp >= start && e.timestamp <= end)
      .slice(-limit)
      .reverse();
  }

  async deleteOlderThan(date: Date): Promise<number> {
    const initialLength = this.entries.length;
    this.entries = this.entries.filter((e) => e.timestamp >= date);
    return initialLength - this.entries.length;
  }

  /** Get all entries (for debugging) */
  getAll(): AuditLogEntry[] {
    return [...this.entries];
  }
}

// ============ File Storage (Simple Persistence) ============

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * File-based storage that appends entries to JSONL files
 * Creates daily log files for easy rotation
 */
export class FileAuditStorage implements AuditStorage {
  private readonly logDir: string;
  private writeBuffer: AuditLogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly flushInterval = 1000; // 1 second

  constructor(logDir: string) {
    this.logDir = logDir;
  }

  async store(entry: AuditLogEntry): Promise<void> {
    this.writeBuffer.push(entry);

    // Schedule flush if not already scheduled
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushInterval);
    }
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (this.writeBuffer.length === 0) return;

    const entries = this.writeBuffer;
    this.writeBuffer = [];

    // Group by date
    const byDate = new Map<string, AuditLogEntry[]>();
    for (const entry of entries) {
      const dateKey = entry.timestamp.toISOString().split('T')[0];
      const existing = byDate.get(dateKey) || [];
      existing.push(entry);
      byDate.set(dateKey, existing);
    }

    // Append to date files
    await fs.mkdir(this.logDir, { recursive: true });

    for (const [dateKey, dateEntries] of byDate) {
      const filePath = join(this.logDir, `audit-${dateKey}.jsonl`);
      const lines = dateEntries.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await fs.appendFile(filePath, lines);
    }
  }

  async queryByVault(vaultAddress: Address, limit = 100): Promise<AuditLogEntry[]> {
    const entries = await this.readRecentEntries(limit * 2);
    return entries
      .filter((e) => e.vaultAddress.toLowerCase() === vaultAddress.toLowerCase())
      .slice(0, limit);
  }

  async queryByProposal(proposalId: string): Promise<AuditLogEntry[]> {
    const entries = await this.readRecentEntries(1000);
    return entries.filter((e) => e.proposalId === proposalId);
  }

  async queryByEventType(eventType: AuditEventType, limit = 100): Promise<AuditLogEntry[]> {
    const entries = await this.readRecentEntries(limit * 2);
    return entries.filter((e) => e.eventType === eventType).slice(0, limit);
  }

  async queryByTimeRange(start: Date, end: Date, limit = 1000): Promise<AuditLogEntry[]> {
    const entries = await this.readRecentEntries(limit * 2);
    return entries.filter((e) => e.timestamp >= start && e.timestamp <= end).slice(0, limit);
  }

  async deleteOlderThan(date: Date): Promise<number> {
    const files = await fs.readdir(this.logDir);
    const dateKey = date.toISOString().split('T')[0];
    let deleted = 0;

    for (const file of files) {
      if (file.startsWith('audit-') && file < `audit-${dateKey}`) {
        await fs.unlink(join(this.logDir, file));
        deleted++;
      }
    }

    return deleted;
  }

  private async readRecentEntries(limit: number): Promise<AuditLogEntry[]> {
    try {
      const files = await fs.readdir(this.logDir);
      const auditFiles = files
        .filter((f) => f.startsWith('audit-') && f.endsWith('.jsonl'))
        .sort()
        .reverse();

      const entries: AuditLogEntry[] = [];

      for (const file of auditFiles) {
        if (entries.length >= limit) break;

        const content = await fs.readFile(join(this.logDir, file), 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);

        for (const line of lines.reverse()) {
          if (entries.length >= limit) break;
          try {
            const entry = JSON.parse(line);
            entry.timestamp = new Date(entry.timestamp);
            entries.push(entry);
          } catch {
            // Skip malformed lines
          }
        }
      }

      return entries;
    } catch {
      return [];
    }
  }

  /** Force flush any buffered entries */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    await this.flush();
  }
}

// ============ AuditLogger Class ============

export interface AuditLoggerConfig {
  storage: AuditStorage;
  /** Retention period in days (default 90) */
  retentionDays?: number;
  /** Whether to also log to console (default true in dev) */
  consoleLog?: boolean;
}

export class AuditLogger {
  private readonly storage: AuditStorage;
  private readonly retentionDays: number;
  private readonly consoleLog: boolean;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: AuditLoggerConfig) {
    this.storage = config.storage;
    this.retentionDays = config.retentionDays ?? 90;
    this.consoleLog = config.consoleLog ?? process.env.NODE_ENV !== 'production';

    // Schedule daily cleanup
    this.scheduleCleanup();
  }

  // ============ Logging Methods ============

  /**
   * Log a proposal creation
   */
  async logProposalCreated(
    vaultAddress: Address,
    proposalId: string,
    details: {
      fromProtocol: string;
      toProtocol: string;
      amount: string;
      apyDelta: number;
      reasoning?: string;
    }
  ): Promise<void> {
    await this.log({
      eventType: AuditEventType.PROPOSAL_CREATED,
      vaultAddress,
      proposalId,
      details,
    });
  }

  /**
   * Log an approval request sent
   */
  async logApprovalRequested(
    vaultAddress: Address,
    proposalId: string,
    userOpHash: Hex,
    details: {
      approvalUrl: string;
      expiresAt: string;
      notificationMethod: 'telegram' | 'push' | 'email';
    }
  ): Promise<void> {
    await this.log({
      eventType: AuditEventType.APPROVAL_REQUESTED,
      vaultAddress,
      proposalId,
      userOpHash,
      details,
    });
  }

  /**
   * Log an approval received
   */
  async logApprovalReceived(
    vaultAddress: Address,
    proposalId: string,
    userOpHash: Hex,
    details: {
      signatureType: 'passkey' | 'session_key';
      responseTime: number; // ms from request to response
    }
  ): Promise<void> {
    await this.log({
      eventType: AuditEventType.APPROVAL_RECEIVED,
      vaultAddress,
      proposalId,
      userOpHash,
      details,
    });
  }

  /**
   * Log an approval rejection
   */
  async logApprovalRejected(
    vaultAddress: Address,
    proposalId: string,
    details: {
      source: 'user' | 'timeout' | 'telegram_callback';
      reason?: string;
    }
  ): Promise<void> {
    await this.log({
      eventType: AuditEventType.APPROVAL_REJECTED,
      vaultAddress,
      proposalId,
      details,
    });
  }

  /**
   * Log approval expiry
   */
  async logApprovalExpired(vaultAddress: Address, proposalId: string): Promise<void> {
    await this.log({
      eventType: AuditEventType.APPROVAL_EXPIRED,
      vaultAddress,
      proposalId,
      details: {},
    });
  }

  /**
   * Log execution started
   */
  async logExecutionStarted(
    vaultAddress: Address,
    proposalId: string,
    userOpHash: Hex
  ): Promise<void> {
    await this.log({
      eventType: AuditEventType.EXECUTION_STARTED,
      vaultAddress,
      proposalId,
      userOpHash,
      details: {},
    });
  }

  /**
   * Log successful execution
   */
  async logExecutionSuccess(
    vaultAddress: Address,
    proposalId: string,
    userOpHash: Hex,
    txHash: Hex,
    details: {
      gasUsed?: string;
      blockNumber?: number;
    }
  ): Promise<void> {
    await this.log({
      eventType: AuditEventType.EXECUTION_SUCCESS,
      vaultAddress,
      proposalId,
      userOpHash,
      txHash,
      details,
    });
  }

  /**
   * Log failed execution
   */
  async logExecutionFailed(
    vaultAddress: Address,
    proposalId: string,
    userOpHash: Hex,
    details: {
      error: string;
      revertReason?: string;
    }
  ): Promise<void> {
    await this.log({
      eventType: AuditEventType.EXECUTION_FAILED,
      vaultAddress,
      proposalId,
      userOpHash,
      details,
    });
  }

  /**
   * Log session key granted
   */
  async logSessionKeyGranted(
    vaultAddress: Address,
    details: {
      sessionKeyAddress: Address;
      validUntil: string;
      spendLimit: string;
    }
  ): Promise<void> {
    await this.log({
      eventType: AuditEventType.SESSION_KEY_GRANTED,
      vaultAddress,
      details,
    });
  }

  /**
   * Log session key revoked
   */
  async logSessionKeyRevoked(
    vaultAddress: Address,
    details: {
      sessionKeyAddress: Address;
      reason?: string;
    }
  ): Promise<void> {
    await this.log({
      eventType: AuditEventType.SESSION_KEY_REVOKED,
      vaultAddress,
      details,
    });
  }

  // ============ Core Logging ============

  private async log(params: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<void> {
    const entry: AuditLogEntry = {
      id: nanoid(16),
      timestamp: new Date(),
      ...params,
    };

    // Store
    await this.storage.store(entry);

    // Console log in development
    if (this.consoleLog) {
      const emoji = this.getEventEmoji(entry.eventType);
      console.log(
        `${emoji} [AUDIT] ${entry.eventType}`,
        entry.proposalId ? `proposal=${entry.proposalId}` : '',
        entry.txHash ? `tx=${entry.txHash.slice(0, 10)}...` : ''
      );
    }
  }

  private getEventEmoji(eventType: AuditEventType): string {
    const emojis: Record<AuditEventType, string> = {
      [AuditEventType.PROPOSAL_CREATED]: 'CREATED',
      [AuditEventType.APPROVAL_REQUESTED]: 'REQUESTED',
      [AuditEventType.APPROVAL_RECEIVED]: 'APPROVED',
      [AuditEventType.APPROVAL_REJECTED]: 'REJECTED',
      [AuditEventType.APPROVAL_EXPIRED]: 'EXPIRED',
      [AuditEventType.EXECUTION_STARTED]: 'STARTED',
      [AuditEventType.EXECUTION_SUCCESS]: 'SUCCESS',
      [AuditEventType.EXECUTION_FAILED]: 'FAILED',
      [AuditEventType.SESSION_KEY_GRANTED]: 'KEY_GRANTED',
      [AuditEventType.SESSION_KEY_REVOKED]: 'KEY_REVOKED',
    };
    return emojis[eventType] || 'LOG';
  }

  // ============ Query Methods ============

  async getVaultHistory(vaultAddress: Address, limit = 100): Promise<AuditLogEntry[]> {
    return this.storage.queryByVault(vaultAddress, limit);
  }

  async getProposalHistory(proposalId: string): Promise<AuditLogEntry[]> {
    return this.storage.queryByProposal(proposalId);
  }

  async getRecentExecutions(limit = 50): Promise<AuditLogEntry[]> {
    const success = await this.storage.queryByEventType(AuditEventType.EXECUTION_SUCCESS, limit);
    const failed = await this.storage.queryByEventType(AuditEventType.EXECUTION_FAILED, limit);

    return [...success, ...failed]
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  // ============ Cleanup ============

  private scheduleCleanup(): void {
    // Run cleanup once a day
    const msPerDay = 24 * 60 * 60 * 1000;
    this.cleanupTimer = setInterval(() => this.runCleanup(), msPerDay);
  }

  private async runCleanup(): Promise<void> {
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);
    const deleted = await this.storage.deleteOlderThan(cutoff);

    if (deleted > 0) {
      console.log(`[AUDIT] Cleaned up ${deleted} entries older than ${cutoff.toISOString()}`);
    }
  }

  /** Stop the cleanup timer */
  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }
}

// ============ Factory Functions ============

/**
 * Create an AuditLogger with in-memory storage (for development/testing)
 */
export function createInMemoryAuditLogger(): AuditLogger {
  return new AuditLogger({
    storage: new InMemoryAuditStorage(),
    consoleLog: true,
  });
}

/**
 * Create an AuditLogger with file storage
 */
export function createFileAuditLogger(logDir: string): AuditLogger {
  return new AuditLogger({
    storage: new FileAuditStorage(logDir),
    consoleLog: process.env.NODE_ENV !== 'production',
  });
}
