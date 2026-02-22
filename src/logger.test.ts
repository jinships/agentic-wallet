import { describe, it, expect, vi } from 'vitest';
import {
  Logger,
  createYieldMonitorLogger,
  createApprovalFlowLogger,
  createWalletManagerLogger,
} from './logger.js';
import type { YieldComparison, ProtocolSnapshot } from './protocols/index.js';

function makeSnapshot(overrides: Partial<ProtocolSnapshot> = {}): ProtocolSnapshot {
  return {
    protocolId: 'aave',
    protocolName: 'Aave V3',
    address: '0x1234567890abcdef1234567890abcdef12345678',
    apyPercent: 0.05,
    balance: 1_000_000n,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('Logger', () => {
  it('respects log level filtering', () => {
    const output = vi.fn();
    const logger = new Logger({ component: 'test' }, { level: 'warn', output, pretty: false });

    logger.debug('should not appear');
    logger.info('should not appear');
    logger.warn('should appear');
    logger.error('should appear');

    expect(output).toHaveBeenCalledTimes(2);
  });

  it('includes component context in output', () => {
    const output = vi.fn();
    const logger = new Logger(
      { component: 'yield-monitor' },
      { level: 'info', output, pretty: false }
    );

    logger.info('test message');

    const parsed = JSON.parse(output.mock.calls[0][0]);
    expect(parsed.component).toBe('yield-monitor');
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('test message');
  });

  it('formats structured log entries', () => {
    const output = vi.fn();
    const logger = new Logger({ component: 'test' }, { level: 'info', output, pretty: false });

    logger.info({
      event: 'rate_check',
      timestamp: '2025-01-01T00:00:00Z',
      protocols: [],
      bestProtocol: 'aave',
      currentProtocol: null,
      apyDifferentialBps: 50,
      shouldRebalance: true,
    });

    const parsed = JSON.parse(output.mock.calls[0][0]);
    expect(parsed.event).toBe('rate_check');
    expect(parsed.shouldRebalance).toBe(true);
  });

  it('pretty prints when configured', () => {
    const output = vi.fn();
    const logger = new Logger({ component: 'test' }, { level: 'info', output, pretty: true });

    logger.info('test');

    // Pretty JSON has newlines
    expect(output.mock.calls[0][0]).toContain('\n');
  });

  describe('logRateCheck', () => {
    it('formats yield comparison data', () => {
      const output = vi.fn();
      const logger = new Logger({ component: 'test' }, { level: 'info', output, pretty: false });

      const comparison: YieldComparison = {
        snapshots: [
          makeSnapshot({ protocolId: 'aave', apyPercent: 0.05, balance: 1_000_000n }),
          makeSnapshot({
            protocolId: 'compound',
            protocolName: 'Compound V3',
            apyPercent: 0.04,
            balance: 0n,
          }),
        ],
        bestProtocol: makeSnapshot({ protocolId: 'aave', apyPercent: 0.05 }),
        currentProtocol: makeSnapshot({
          protocolId: 'aave',
          apyPercent: 0.05,
          balance: 1_000_000n,
        }),
        apyDifferentialBps: 0,
        shouldRebalance: false,
        timestamp: Date.now(),
      };

      logger.logRateCheck(comparison, { rejectReason: 'already_in_best_protocol' });

      const parsed = JSON.parse(output.mock.calls[0][0]);
      expect(parsed.event).toBe('rate_check');
      expect(parsed.protocols).toHaveLength(2);
      expect(parsed.rejectReason).toBe('already_in_best_protocol');
    });
  });

  describe('logError', () => {
    it('captures error message and stack', () => {
      const output = vi.fn();
      const logger = new Logger({ component: 'test' }, { level: 'error', output, pretty: false });

      logger.logError(new Error('something broke'), { context: 'testing' });

      const parsed = JSON.parse(output.mock.calls[0][0]);
      expect(parsed.event).toBe('error');
      expect(parsed.error).toBe('something broke');
      expect(parsed.stack).toBeTruthy();
      expect(parsed.recoverable).toBe(true);
    });

    it('handles string errors', () => {
      const output = vi.fn();
      const logger = new Logger({ component: 'test' }, { level: 'error', output, pretty: false });

      logger.logError('plain string error');

      const parsed = JSON.parse(output.mock.calls[0][0]);
      expect(parsed.error).toBe('plain string error');
      expect(parsed.stack).toBeUndefined();
    });
  });

  describe('logAnomaly', () => {
    it('logs blocked anomalies at warn level', () => {
      const output = vi.fn();
      const logger = new Logger({ component: 'test' }, { level: 'info', output, pretty: false });

      logger.logAnomaly(
        'aave',
        { suspicious: true, reason: 'high_rate_velocity', severity: 'high' },
        'blocked'
      );

      const parsed = JSON.parse(output.mock.calls[0][0]);
      expect(parsed.level).toBe('warn');
      expect(parsed.event).toBe('rate_anomaly');
      expect(parsed.action).toBe('blocked');
    });
  });

  describe('child logger', () => {
    it('inherits parent context and adds new context', () => {
      const output = vi.fn();
      const parent = new Logger({ component: 'parent' }, { level: 'info', output, pretty: false });
      const child = parent.child({ subComponent: 'child-ctx' });

      child.info('from child');

      const parsed = JSON.parse(output.mock.calls[0][0]);
      expect(parsed.component).toBe('parent');
      expect(parsed.subComponent).toBe('child-ctx');
    });
  });

  describe('factory functions', () => {
    it('creates yield monitor logger', () => {
      const logger = createYieldMonitorLogger({ level: 'error', output: vi.fn() });
      expect(logger).toBeInstanceOf(Logger);
    });

    it('creates approval flow logger', () => {
      const logger = createApprovalFlowLogger({ level: 'error', output: vi.fn() });
      expect(logger).toBeInstanceOf(Logger);
    });

    it('creates wallet manager logger', () => {
      const logger = createWalletManagerLogger({ level: 'error', output: vi.fn() });
      expect(logger).toBeInstanceOf(Logger);
    });
  });
});
