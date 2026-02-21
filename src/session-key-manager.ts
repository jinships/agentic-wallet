/**
 * Secure Session Key Manager
 *
 * Addresses C1: Session key private keys should not be stored in plaintext.
 *
 * This module provides:
 * - Encrypted key storage using AES-256-GCM
 * - Key derivation from a master secret
 * - Secure key lifecycle management
 */

import { type Address, type Hex, keccak256, toHex, hexToBytes, bytesToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as crypto from "node:crypto";

/**
 * Encrypted session key - safe to store/log
 */
export interface EncryptedSessionKey {
  address: Address;
  encryptedPrivateKey: string; // base64 encoded encrypted key
  iv: string; // base64 encoded IV
  authTag: string; // base64 encoded auth tag
  config: {
    validUntil: number;
    spendLimit: bigint;
  };
}

/**
 * Session key for signing (only in memory during use)
 */
export interface DecryptedSessionKey {
  address: Address;
  privateKey: Hex;
  config: {
    validUntil: number;
    spendLimit: bigint;
  };
}

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for GCM

/**
 * SecureSessionKeyManager handles encrypted storage of session keys.
 *
 * Usage:
 * 1. Initialize with a master key (from env var or KMS)
 * 2. Generate or import session keys (stored encrypted)
 * 3. Decrypt only when signing, then immediately discard
 */
export class SecureSessionKeyManager {
  private readonly encryptionKey: Buffer;
  private readonly encryptedKeys: Map<Address, EncryptedSessionKey> = new Map();

  /**
   * Create a new manager with a master encryption key.
   *
   * @param masterKey - 32-byte hex string or Buffer. In production, load from KMS/HSM.
   */
  constructor(masterKey: Hex | Buffer) {
    if (typeof masterKey === "string") {
      const keyBytes = hexToBytes(masterKey as Hex);
      if (keyBytes.length !== KEY_LENGTH) {
        throw new Error(`Master key must be ${KEY_LENGTH} bytes (got ${keyBytes.length})`);
      }
      this.encryptionKey = Buffer.from(keyBytes);
    } else {
      if (masterKey.length !== KEY_LENGTH) {
        throw new Error(`Master key must be ${KEY_LENGTH} bytes`);
      }
      this.encryptionKey = masterKey;
    }
  }

  /**
   * Generate a new session key and store it encrypted.
   */
  generateSessionKey(config: {
    validUntil: number;
    spendLimit: bigint;
  }): EncryptedSessionKey {
    // Generate random private key
    const privateKeyBytes = crypto.randomBytes(32);
    const privateKey = bytesToHex(privateKeyBytes) as Hex;

    // Derive address
    const account = privateKeyToAccount(privateKey);
    const address = account.address;

    // Encrypt the private key
    const encrypted = this.encrypt(privateKeyBytes);

    const encryptedKey: EncryptedSessionKey = {
      address,
      encryptedPrivateKey: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      config,
    };

    // Store encrypted version
    this.encryptedKeys.set(address, encryptedKey);

    // Zero out the plaintext key
    privateKeyBytes.fill(0);

    return encryptedKey;
  }

  /**
   * Import an existing private key and store it encrypted.
   */
  importSessionKey(
    privateKey: Hex,
    config: { validUntil: number; spendLimit: bigint }
  ): EncryptedSessionKey {
    const privateKeyBytes = Buffer.from(hexToBytes(privateKey));
    const account = privateKeyToAccount(privateKey);
    const address = account.address;

    const encrypted = this.encrypt(privateKeyBytes);

    const encryptedKey: EncryptedSessionKey = {
      address,
      encryptedPrivateKey: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      config,
    };

    this.encryptedKeys.set(address, encryptedKey);

    // Zero out the input
    privateKeyBytes.fill(0);

    return encryptedKey;
  }

  /**
   * Load an encrypted session key (e.g., from database).
   */
  loadEncryptedKey(encryptedKey: EncryptedSessionKey): void {
    this.encryptedKeys.set(encryptedKey.address, encryptedKey);
  }

  /**
   * Get an encrypted key by address (safe to log/store).
   */
  getEncryptedKey(address: Address): EncryptedSessionKey | undefined {
    return this.encryptedKeys.get(address);
  }

  /**
   * Decrypt a session key for signing.
   *
   * IMPORTANT: The returned key should be used immediately and then
   * allowed to go out of scope. Do not store the decrypted key.
   */
  decryptForSigning(address: Address): DecryptedSessionKey {
    const encrypted = this.encryptedKeys.get(address);
    if (!encrypted) {
      throw new Error(`No session key found for address ${address}`);
    }

    // Check expiry before decrypting
    if (Date.now() / 1000 > encrypted.config.validUntil) {
      throw new Error(`Session key ${address} has expired`);
    }

    const privateKeyBytes = this.decrypt(
      encrypted.encryptedPrivateKey,
      encrypted.iv,
      encrypted.authTag
    );

    const privateKey = bytesToHex(privateKeyBytes) as Hex;

    // Zero the buffer after converting to hex
    privateKeyBytes.fill(0);

    return {
      address: encrypted.address,
      privateKey,
      config: encrypted.config,
    };
  }

  /**
   * Revoke a session key (delete from memory).
   */
  revokeSessionKey(address: Address): boolean {
    return this.encryptedKeys.delete(address);
  }

  /**
   * List all session key addresses.
   */
  listSessionKeys(): Address[] {
    return Array.from(this.encryptedKeys.keys());
  }

  /**
   * Get all valid (non-expired) session keys.
   */
  getValidSessionKeys(): EncryptedSessionKey[] {
    const now = Date.now() / 1000;
    return Array.from(this.encryptedKeys.values()).filter(
      (k) => k.config.validUntil > now
    );
  }

  /**
   * Clean up expired session keys.
   */
  cleanupExpired(): number {
    const now = Date.now() / 1000;
    let removed = 0;

    for (const [address, key] of this.encryptedKeys) {
      if (key.config.validUntil <= now) {
        this.encryptedKeys.delete(address);
        removed++;
      }
    }

    return removed;
  }

  // ============ Encryption Helpers ============

  private encrypt(data: Buffer): {
    ciphertext: string;
    iv: string;
    authTag: string;
  } {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);

    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      ciphertext: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
    };
  }

  private decrypt(
    ciphertext: string,
    ivBase64: string,
    authTagBase64: string
  ): Buffer {
    const encrypted = Buffer.from(ciphertext, "base64");
    const iv = Buffer.from(ivBase64, "base64");
    const authTag = Buffer.from(authTagBase64, "base64");

    const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted;
  }
}

/**
 * Create a master key from a password/secret using PBKDF2.
 * Use this if you don't have a KMS-provided key.
 */
export function deriveMasterKey(
  secret: string,
  salt: string = "agentvault-session-keys"
): Buffer {
  return crypto.pbkdf2Sync(secret, salt, 100000, KEY_LENGTH, "sha256");
}

/**
 * Generate a random master key (store securely!).
 */
export function generateMasterKey(): Hex {
  const key = crypto.randomBytes(KEY_LENGTH);
  return bytesToHex(key) as Hex;
}
