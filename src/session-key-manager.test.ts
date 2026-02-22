import { describe, it, expect, beforeEach } from 'vitest';
import {
  SecureSessionKeyManager,
  deriveMasterKey,
  generateMasterKey,
} from './session-key-manager.js';
import type { Hex, Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as crypto from 'node:crypto';
import { bytesToHex } from 'viem';

// Deterministic 32-byte master key for testing
const TEST_MASTER_KEY = bytesToHex(crypto.randomBytes(32)) as Hex;

describe('SecureSessionKeyManager', () => {
  let manager: SecureSessionKeyManager;
  const futureTimestamp = Math.floor(Date.now() / 1000) + 86400; // +1 day

  beforeEach(() => {
    manager = new SecureSessionKeyManager(TEST_MASTER_KEY);
  });

  describe('constructor', () => {
    it('accepts a hex master key', () => {
      expect(() => new SecureSessionKeyManager(TEST_MASTER_KEY)).not.toThrow();
    });

    it('accepts a Buffer master key', () => {
      const buf = crypto.randomBytes(32);
      expect(() => new SecureSessionKeyManager(buf)).not.toThrow();
    });

    it('rejects wrong-length keys', () => {
      const short = '0x1234' as Hex;
      expect(() => new SecureSessionKeyManager(short)).toThrow(/must be 32 bytes/);
    });

    it('rejects wrong-length Buffer', () => {
      expect(() => new SecureSessionKeyManager(Buffer.alloc(16))).toThrow(/must be 32 bytes/);
    });
  });

  describe('generateSessionKey', () => {
    it('generates a key with encrypted private key', () => {
      const result = manager.generateSessionKey({
        validUntil: futureTimestamp,
        spendLimit: 1000n,
      });

      expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(result.encryptedPrivateKey).toBeTruthy();
      expect(result.iv).toBeTruthy();
      expect(result.authTag).toBeTruthy();
      // Encrypted key should NOT look like a raw hex private key
      expect(result.encryptedPrivateKey).not.toMatch(/^0x/);
    });

    it('generates unique keys each time', () => {
      const k1 = manager.generateSessionKey({ validUntil: futureTimestamp, spendLimit: 1000n });
      const k2 = manager.generateSessionKey({ validUntil: futureTimestamp, spendLimit: 1000n });
      expect(k1.address).not.toBe(k2.address);
    });
  });

  describe('importSessionKey', () => {
    it('imports and encrypts an existing private key', () => {
      const account = privateKeyToAccount(bytesToHex(crypto.randomBytes(32)) as Hex);
      // We need the actual private key — generate fresh
      const pk = bytesToHex(crypto.randomBytes(32)) as Hex;
      const imported = manager.importSessionKey(pk, {
        validUntil: futureTimestamp,
        spendLimit: 500n,
      });

      expect(imported.encryptedPrivateKey).toBeTruthy();
      expect(imported.config.spendLimit).toBe(500n);
    });
  });

  describe('decryptForSigning', () => {
    it('round-trips: generate → decrypt recovers a valid signing key', () => {
      const encrypted = manager.generateSessionKey({
        validUntil: futureTimestamp,
        spendLimit: 1000n,
      });

      const decrypted = manager.decryptForSigning(encrypted.address);
      expect(decrypted.address).toBe(encrypted.address);
      expect(decrypted.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);

      // The decrypted key should derive the same address
      const account = privateKeyToAccount(decrypted.privateKey);
      expect(account.address).toBe(encrypted.address);
    });

    it('round-trips: import → decrypt recovers original key', () => {
      const pk = bytesToHex(crypto.randomBytes(32)) as Hex;
      const originalAccount = privateKeyToAccount(pk);

      manager.importSessionKey(pk, { validUntil: futureTimestamp, spendLimit: 100n });
      const decrypted = manager.decryptForSigning(originalAccount.address);

      expect(decrypted.privateKey).toBe(pk);
    });

    it('throws for unknown address', () => {
      expect(() =>
        manager.decryptForSigning('0x0000000000000000000000000000000000000001')
      ).toThrow(/No session key found/);
    });

    it('throws for expired keys', () => {
      const pastTimestamp = Math.floor(Date.now() / 1000) - 1000;
      const encrypted = manager.generateSessionKey({
        validUntil: pastTimestamp,
        spendLimit: 1000n,
      });

      expect(() => manager.decryptForSigning(encrypted.address)).toThrow(/expired/);
    });

    it('cannot decrypt with a different master key', () => {
      const encrypted = manager.generateSessionKey({
        validUntil: futureTimestamp,
        spendLimit: 1000n,
      });

      const otherKey = bytesToHex(crypto.randomBytes(32)) as Hex;
      const otherManager = new SecureSessionKeyManager(otherKey);
      otherManager.loadEncryptedKey(encrypted);

      // AES-GCM should reject with wrong key (auth tag mismatch)
      expect(() => otherManager.decryptForSigning(encrypted.address)).toThrow();
    });
  });

  describe('key lifecycle', () => {
    it('revokeSessionKey removes the key', () => {
      const encrypted = manager.generateSessionKey({
        validUntil: futureTimestamp,
        spendLimit: 1000n,
      });

      expect(manager.revokeSessionKey(encrypted.address)).toBe(true);
      expect(manager.getEncryptedKey(encrypted.address)).toBeUndefined();
      expect(manager.revokeSessionKey(encrypted.address)).toBe(false);
    });

    it('listSessionKeys returns all addresses', () => {
      manager.generateSessionKey({ validUntil: futureTimestamp, spendLimit: 100n });
      manager.generateSessionKey({ validUntil: futureTimestamp, spendLimit: 200n });

      expect(manager.listSessionKeys()).toHaveLength(2);
    });

    it('getValidSessionKeys excludes expired keys', () => {
      manager.generateSessionKey({ validUntil: futureTimestamp, spendLimit: 100n });
      manager.generateSessionKey({
        validUntil: Math.floor(Date.now() / 1000) - 100,
        spendLimit: 200n,
      });

      expect(manager.getValidSessionKeys()).toHaveLength(1);
    });

    it('cleanupExpired removes only expired keys', () => {
      manager.generateSessionKey({ validUntil: futureTimestamp, spendLimit: 100n });
      manager.generateSessionKey({
        validUntil: Math.floor(Date.now() / 1000) - 100,
        spendLimit: 200n,
      });

      const removed = manager.cleanupExpired();
      expect(removed).toBe(1);
      expect(manager.listSessionKeys()).toHaveLength(1);
    });

    it('loadEncryptedKey makes key available', () => {
      const encrypted = manager.generateSessionKey({
        validUntil: futureTimestamp,
        spendLimit: 1000n,
      });

      const freshManager = new SecureSessionKeyManager(TEST_MASTER_KEY);
      expect(freshManager.getEncryptedKey(encrypted.address)).toBeUndefined();

      freshManager.loadEncryptedKey(encrypted);
      expect(freshManager.getEncryptedKey(encrypted.address)).toBeDefined();

      const decrypted = freshManager.decryptForSigning(encrypted.address);
      expect(decrypted.address).toBe(encrypted.address);
    });
  });
});

describe('deriveMasterKey', () => {
  it('produces a deterministic 32-byte key', () => {
    const k1 = deriveMasterKey('my-secret');
    const k2 = deriveMasterKey('my-secret');
    expect(k1).toEqual(k2);
    expect(k1.length).toBe(32);
  });

  it('different secrets produce different keys', () => {
    const k1 = deriveMasterKey('secret-a');
    const k2 = deriveMasterKey('secret-b');
    expect(k1).not.toEqual(k2);
  });

  it('different salts produce different keys', () => {
    const k1 = deriveMasterKey('same-secret', 'salt-a');
    const k2 = deriveMasterKey('same-secret', 'salt-b');
    expect(k1).not.toEqual(k2);
  });
});

describe('generateMasterKey', () => {
  it('produces a 66-char hex string (0x + 64)', () => {
    const key = generateMasterKey();
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('generates unique keys', () => {
    expect(generateMasterKey()).not.toBe(generateMasterKey());
  });
});
