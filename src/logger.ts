/**
 * Structured logging for AgentVault yield monitoring.
 *
 * All logs are JSON-formatted for easy parsing by log aggregation tools.
 */

import type { YieldProtocol, ProtocolSnapshot, YieldComparison } from './protocols/index.js';
import type { RateAnomaly, TWAPResult } from './rate-history.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  component: string;
  [key: string]: unknown;
}

export interface RateCheckLog {
  event: 'rate_check';
  timestamp: string;
  protocols: {
    id: YieldProtocol['id'];
    name: string;
    apy: number;
    apyPercent: string;
    balance: string;
    balanceUsd: string;
  }[];
  bestProtocol: YieldProtocol['id'];
  currentProtocol: YieldProtocol['id'] | null;
  apyDifferentialBps: number;
  shouldRebalance: boolean;
  rejectReason?: string;
  twapUsed?: boolean;
  anomalyDetected?: boolean;
}

export interface RebalanceProposalLog {
  event: 'rebalance_proposal';
  timestamp: string;
  proposalId: string;
  fromProtocol: YieldProtocol['id'];
  toProtocol: YieldProtocol['id'];
  amount: string;
  amountUsd: string;
  expectedApyGainBps: number;
  estimatedGasUsd?: string;
}

export interface ErrorLog {
  event: 'error';
  timestamp: string;
  error: string;
  stack?: string;
  context?: Record<string, unknown>;
  recoverable: boolean;
}

export interface AnomalyLog {
  event: 'rate_anomaly';
  timestamp: string;
  protocolId: YieldProtocol['id'];
  anomaly: RateAnomaly;
  action: 'blocked' | 'warned';
}

type LogEntry = RateCheckLog | RebalanceProposalLog | ErrorLog | AnomalyLog;

export interface LoggerConfig {
  level: LogLevel;
  pretty: boolean;
  output: (message: string) => void;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private readonly config: LoggerConfig;
  private readonly context: LogContext;

  constructor(context: LogContext, config?: Partial<LoggerConfig>) {
    this.context = context;
    this.config = {
      level: config?.level ?? 'info',
      pretty: config?.pretty ?? process.env.NODE_ENV !== 'production',
      output: config?.output ?? console.log,
    };
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.level];
  }

  private formatMessage(level: LogLevel, entry: LogEntry | string): string {
    const base = {
      level,
      ...this.context,
      ...(typeof entry === 'string' ? { message: entry } : entry),
    };

    if (this.config.pretty) {
      return JSON.stringify(base, null, 2);
    }
    return JSON.stringify(base);
  }

  debug(entry: LogEntry | string): void {
    if (this.shouldLog('debug')) {
      this.config.output(this.formatMessage('debug', entry));
    }
  }

  info(entry: LogEntry | string): void {
    if (this.shouldLog('info')) {
      this.config.output(this.formatMessage('info', entry));
    }
  }

  warn(entry: LogEntry | string): void {
    if (this.shouldLog('warn')) {
      this.config.output(this.formatMessage('warn', entry));
    }
  }

  error(entry: LogEntry | string): void {
    if (this.shouldLog('error')) {
      this.config.output(this.formatMessage('error', entry));
    }
  }

  /**
   * Log a rate check event.
   */
  logRateCheck(
    comparison: YieldComparison,
    options?: {
      rejectReason?: string;
      twapUsed?: boolean;
      anomalyDetected?: boolean;
    }
  ): void {
    const log: RateCheckLog = {
      event: 'rate_check',
      timestamp: new Date().toISOString(),
      protocols: comparison.snapshots.map((s) => ({
        id: s.protocolId,
        name: s.protocolName,
        apy: s.apyPercent,
        apyPercent: `${(s.apyPercent * 100).toFixed(2)}%`,
        balance: s.balance.toString(),
        balanceUsd: formatUSDC(s.balance),
      })),
      bestProtocol: comparison.bestProtocol.protocolId,
      currentProtocol: comparison.currentProtocol?.protocolId ?? null,
      apyDifferentialBps: comparison.apyDifferentialBps,
      shouldRebalance: comparison.shouldRebalance,
      ...options,
    };

    this.info(log);
  }

  /**
   * Log a rebalance proposal.
   */
  logRebalanceProposal(
    proposalId: string,
    fromProtocol: YieldProtocol['id'],
    toProtocol: YieldProtocol['id'],
    amount: bigint,
    expectedApyGainBps: number,
    estimatedGasUsd?: string
  ): void {
    const log: RebalanceProposalLog = {
      event: 'rebalance_proposal',
      timestamp: new Date().toISOString(),
      proposalId,
      fromProtocol,
      toProtocol,
      amount: amount.toString(),
      amountUsd: formatUSDC(amount),
      expectedApyGainBps,
      estimatedGasUsd,
    };

    this.info(log);
  }

  /**
   * Log an error.
   */
  logError(error: Error | string, context?: Record<string, unknown>, recoverable = true): void {
    const log: ErrorLog = {
      event: 'error',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
      context,
      recoverable,
    };

    this.error(log);
  }

  /**
   * Log a rate anomaly detection.
   */
  logAnomaly(
    protocolId: YieldProtocol['id'],
    anomaly: RateAnomaly,
    action: 'blocked' | 'warned'
  ): void {
    const log: AnomalyLog = {
      event: 'rate_anomaly',
      timestamp: new Date().toISOString(),
      protocolId,
      anomaly,
      action,
    };

    if (action === 'blocked') {
      this.warn(log);
    } else {
      this.info(log);
    }
  }

  /**
   * Create a child logger with additional context.
   */
  child(additionalContext: Partial<LogContext>): Logger {
    return new Logger({ ...this.context, ...additionalContext }, this.config);
  }
}

/**
 * Format USDC amount (6 decimals) for display.
 */
function formatUSDC(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = amount % 1_000_000n;
  const fracStr = frac.toString().padStart(6, '0').slice(0, 2);
  return `$${whole.toLocaleString()}.${fracStr}`;
}

/**
 * Create a logger for the yield monitor component.
 */
export function createYieldMonitorLogger(config?: Partial<LoggerConfig>): Logger {
  return new Logger({ component: 'yield-monitor' }, config);
}

/**
 * Create a logger for the approval flow component.
 */
export function createApprovalFlowLogger(config?: Partial<LoggerConfig>): Logger {
  return new Logger({ component: 'approval-flow' }, config);
}

/**
 * Create a logger for the wallet manager component.
 */
export function createWalletManagerLogger(config?: Partial<LoggerConfig>): Logger {
  return new Logger({ component: 'wallet-manager' }, config);
}
