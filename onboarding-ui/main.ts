/**
 * AgentVault Onboarding UI - Passkey Registration
 *
 * This frontend handles:
 * - Checking WebAuthn/passkey support
 * - Creating a new passkey (Face ID / fingerprint)
 * - Extracting P-256 public key coordinates (ownerX, ownerY)
 * - Computing the deterministic vault address
 * - Triggering vault deployment via factory
 */

// ============ Configuration ============

const CONFIG = {
  // Base mainnet
  chainId: 8453,
  rpcUrl: 'https://mainnet.base.org',

  // Factory address (deployed 2026-02-21)
  factoryAddress: '0x74fa96F0A20A2A863E0921beBB6B398D969e096C' as `0x${string}`,

  // Default vault configuration
  dailyLimit: 10000n * 10n ** 6n, // $10,000 USDC
  autoExecuteThreshold: 100n * 10n ** 6n, // $100 USDC
  sessionKeyDailyCap: 1000n * 10n ** 6n, // $1,000 USDC

  // Whitelisted protocols (Base mainnet)
  protocols: [
    '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', // Aave V3 Pool
    '0xb125E6687d4313864e53df431d5425969c15Eb2F', // Compound V3
    '0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A', // Morpho
    '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22', // Moonwell
  ] as `0x${string}`[],

  // Relying Party for WebAuthn
  rpName: 'AgentVault',
  rpId: typeof window !== 'undefined' ? window.location.hostname : 'localhost',
};

// ============ Types ============

interface PasskeyCredential {
  credentialId: Uint8Array;
  publicKey: {
    x: bigint;
    y: bigint;
  };
}

interface VaultCreationResult {
  vaultAddress: string;
  ownerX: string;
  ownerY: string;
  credentialId: string;
}

// ============ DOM Elements ============

const elements = {
  welcomeView: document.getElementById('welcome-view')!,
  creatingView: document.getElementById('creating-view')!,
  successView: document.getElementById('success-view')!,
  errorView: document.getElementById('error-view')!,
  notSupportedView: document.getElementById('not-supported-view')!,
  createBtn: document.getElementById('create-btn') as HTMLButtonElement,
  copyBtn: document.getElementById('copy-btn') as HTMLButtonElement,
  doneBtn: document.getElementById('done-btn') as HTMLButtonElement,
  retryBtn: document.getElementById('retry-btn') as HTMLButtonElement,
  vaultAddress: document.getElementById('vault-address')!,
  errorText: document.getElementById('error-text')!,
};

// ============ State ============

let currentCredential: PasskeyCredential | null = null;
let currentVaultAddress: string | null = null;

// ============ View Management ============

type View = 'welcome' | 'creating' | 'success' | 'error' | 'not-supported';

function showView(view: View): void {
  elements.welcomeView.classList.add('hidden');
  elements.creatingView.classList.add('hidden');
  elements.successView.classList.add('hidden');
  elements.errorView.classList.add('hidden');
  elements.notSupportedView.classList.add('hidden');

  switch (view) {
    case 'welcome':
      elements.welcomeView.classList.remove('hidden');
      break;
    case 'creating':
      elements.creatingView.classList.remove('hidden');
      break;
    case 'success':
      elements.successView.classList.remove('hidden');
      break;
    case 'error':
      elements.errorView.classList.remove('hidden');
      break;
    case 'not-supported':
      elements.notSupportedView.classList.remove('hidden');
      break;
  }
}

function showError(message: string): void {
  elements.errorText.textContent = message;
  showView('error');
}

// ============ WebAuthn Support Check ============

function isWebAuthnSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
  );
}

async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;

  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// ============ Passkey Creation ============

/**
 * Create a new passkey and extract the P-256 public key coordinates.
 * Returns the credential ID and public key (x, y) for smart contract initialization.
 */
async function createPasskey(): Promise<PasskeyCredential> {
  // Generate random challenge
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);

  // Generate random user ID
  const userId = new Uint8Array(16);
  crypto.getRandomValues(userId);

  // Create credential options
  const createOptions: CredentialCreationOptions = {
    publicKey: {
      challenge,
      rp: {
        name: CONFIG.rpName,
        id: CONFIG.rpId,
      },
      user: {
        id: userId,
        name: `agentvault-${Date.now()}`,
        displayName: 'AgentVault User',
      },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' }, // ES256 (P-256 / secp256r1)
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform', // Use device's built-in authenticator
        userVerification: 'required', // Require Face ID / fingerprint
        residentKey: 'required', // Discoverable credential (passkey)
      },
      timeout: 60000,
      attestation: 'none', // Don't need attestation for our use case
    },
  };

  // Create the credential
  const credential = (await navigator.credentials.create(createOptions)) as PublicKeyCredential;

  if (!credential) {
    throw new Error('Failed to create passkey');
  }

  // Extract the public key from the attestation response
  const response = credential.response as AuthenticatorAttestationResponse;
  const publicKey = extractPublicKey(response);

  return {
    credentialId: new Uint8Array(credential.rawId),
    publicKey,
  };
}

/**
 * Extract P-256 public key coordinates from the authenticator attestation response.
 * The public key is in COSE format within the attestation object.
 */
function extractPublicKey(response: AuthenticatorAttestationResponse): { x: bigint; y: bigint } {
  // The public key is in the authenticator data, which is part of the attestation object
  // For 'none' attestation, we can get the public key from getPublicKey() method

  const publicKeyDer = response.getPublicKey();
  if (!publicKeyDer) {
    throw new Error('Failed to get public key from credential');
  }

  // The public key is in SubjectPublicKeyInfo (SPKI) DER format
  // For P-256, the structure is:
  // SEQUENCE {
  //   SEQUENCE { OID ecPublicKey, OID prime256v1 }
  //   BIT STRING (uncompressed point: 04 || x || y)
  // }

  const publicKeyBytes = new Uint8Array(publicKeyDer);

  // Find the uncompressed point (starts with 0x04)
  // For P-256 SPKI, the point starts at offset 26 (after the header bytes)
  const pointStart = findUncompressedPoint(publicKeyBytes);

  if (pointStart === -1 || publicKeyBytes[pointStart] !== 0x04) {
    throw new Error('Invalid public key format: expected uncompressed point');
  }

  // Extract x and y coordinates (32 bytes each)
  const x = publicKeyBytes.slice(pointStart + 1, pointStart + 33);
  const y = publicKeyBytes.slice(pointStart + 33, pointStart + 65);

  return {
    x: bytesToBigInt(x),
    y: bytesToBigInt(y),
  };
}

/**
 * Find the start of the uncompressed point in a SPKI-encoded P-256 public key.
 */
function findUncompressedPoint(data: Uint8Array): number {
  // P-256 SPKI format has the point at a specific offset
  // The BIT STRING containing the point starts after the algorithm identifier
  // For P-256: 30 59 30 13 06 07 ... 03 42 00 04 [x] [y]
  //            ^^ SEQUENCE      ^^ BIT STRING ^^ uncompressed point marker

  // Look for 0x04 (uncompressed point marker) preceded by 0x00 (no unused bits in BIT STRING)
  for (let i = 0; i < data.length - 65; i++) {
    if (data[i] === 0x04) {
      // Verify this looks like a valid point (check preceding byte is 0x00)
      if (i > 0 && data[i - 1] === 0x00) {
        return i;
      }
    }
  }

  return -1;
}

/**
 * Convert a byte array to a BigInt.
 */
function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

/**
 * Convert a BigInt to a hex string with 0x prefix.
 */
function bigIntToHex(value: bigint): string {
  const hex = value.toString(16);
  return '0x' + hex.padStart(64, '0');
}

/**
 * Convert a Uint8Array to a hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  return (
    '0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

// ============ Vault Address Computation ============

/**
 * Compute the deterministic vault address from public key coordinates.
 * This mirrors the factory's getVaultAddress() function.
 */
async function computeVaultAddress(ownerX: bigint, ownerY: bigint): Promise<string> {
  // For a real implementation, we'd call the factory contract
  // For now, return a placeholder that will be replaced when actually deployed

  // If factory is configured, make an RPC call to get the predicted address
  if (CONFIG.factoryAddress !== '0x0000000000000000000000000000000000000000') {
    return await callGetVaultAddress(ownerX, ownerY);
  }

  // Return a placeholder address based on hash of public key
  // This is just for UI purposes - real address comes from factory
  const combined = bigIntToHex(ownerX) + bigIntToHex(ownerY).slice(2);
  const hashBytes = await crypto.subtle.digest('SHA-256', hexToBytes(combined));
  const hash = new Uint8Array(hashBytes);
  return (
    '0x' +
    Array.from(hash.slice(0, 20))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * Call the factory's getVaultAddress function via RPC.
 */
async function callGetVaultAddress(ownerX: bigint, ownerY: bigint): Promise<string> {
  // Encode the function call: getVaultAddress(uint256,uint256,bytes32)
  const selector = '0x' + keccak256('getVaultAddress(uint256,uint256,bytes32)').slice(0, 8);
  const encodedX = bigIntToHex(ownerX).slice(2).padStart(64, '0');
  const encodedY = bigIntToHex(ownerY).slice(2).padStart(64, '0');
  const encodedSalt = '0'.repeat(64); // bytes32(0)

  const calldata = selector + encodedX + encodedY + encodedSalt;

  const response = await fetch(CONFIG.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [
        {
          to: CONFIG.factoryAddress,
          data: calldata,
        },
        'latest',
      ],
    }),
  });

  const result = (await response.json()) as { result?: string; error?: { message: string } };

  if (result.error) {
    throw new Error(`RPC error: ${result.error.message}`);
  }

  // Result is the ABI-encoded address (32 bytes, address in last 20)
  const addressHex = result.result?.slice(-40);
  return '0x' + addressHex;
}

/**
 * Simple keccak256 implementation for function selector.
 * In production, use a proper library like viem or ethers.
 */
function keccak256(input: string): string {
  // This is a placeholder - in real implementation, use viem's keccak256
  // For now, we'll use a precomputed selector
  const selectors: Record<string, string> = {
    'getVaultAddress(uint256,uint256,bytes32)': 'a3c573eb',
  };
  return selectors[input] || '00000000';
}

function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ============ Main Flow ============

async function handleCreateWallet(): Promise<void> {
  try {
    showView('creating');

    // Create the passkey
    const credential = await createPasskey();
    currentCredential = credential;

    console.log('Passkey created:', {
      credentialId: bytesToHex(credential.credentialId),
      ownerX: bigIntToHex(credential.publicKey.x),
      ownerY: bigIntToHex(credential.publicKey.y),
    });

    // Compute the vault address
    const vaultAddress = await computeVaultAddress(credential.publicKey.x, credential.publicKey.y);
    currentVaultAddress = vaultAddress;

    // Update the UI
    elements.vaultAddress.textContent = vaultAddress;

    // Store credential info in localStorage for later use
    const result: VaultCreationResult = {
      vaultAddress,
      ownerX: bigIntToHex(credential.publicKey.x),
      ownerY: bigIntToHex(credential.publicKey.y),
      credentialId: bytesToHex(credential.credentialId),
    };
    localStorage.setItem('agentvault_credential', JSON.stringify(result));

    // Log the values needed for contract deployment
    console.log('\n=== Copy these values for vault deployment ===');
    console.log('PASSKEY_X=' + bigIntToHex(credential.publicKey.x));
    console.log('PASSKEY_Y=' + bigIntToHex(credential.publicKey.y));
    console.log('Predicted Vault Address:', vaultAddress);
    console.log('===============================================\n');

    showView('success');
  } catch (error) {
    console.error('Failed to create wallet:', error);

    if (error instanceof Error) {
      if (error.name === 'NotAllowedError') {
        showError('Passkey creation was cancelled or not allowed.');
      } else if (error.name === 'NotSupportedError') {
        showError('Your device does not support passkeys.');
      } else {
        showError(error.message);
      }
    } else {
      showError('An unexpected error occurred.');
    }
  }
}

async function handleCopyAddress(): Promise<void> {
  if (!currentVaultAddress) return;

  try {
    await navigator.clipboard.writeText(currentVaultAddress);
    elements.copyBtn.textContent = 'Copied!';
    setTimeout(() => {
      elements.copyBtn.textContent = 'Copy Address';
    }, 2000);
  } catch {
    // Fallback for older browsers
    const textArea = document.createElement('textarea');
    textArea.value = currentVaultAddress;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
    elements.copyBtn.textContent = 'Copied!';
    setTimeout(() => {
      elements.copyBtn.textContent = 'Copy Address';
    }, 2000);
  }
}

function handleDone(): void {
  // Could redirect to a dashboard or close the window
  window.close();
}

function handleRetry(): void {
  showView('welcome');
}

// ============ Initialization ============

async function init(): Promise<void> {
  // Check for WebAuthn support
  if (!isWebAuthnSupported()) {
    showView('not-supported');
    return;
  }

  // Check for platform authenticator
  const hasPlatformAuth = await isPlatformAuthenticatorAvailable();
  if (!hasPlatformAuth) {
    showView('not-supported');
    return;
  }

  // Check if user already has a credential
  const existingCredential = localStorage.getItem('agentvault_credential');
  if (existingCredential) {
    try {
      const data = JSON.parse(existingCredential) as VaultCreationResult;
      currentVaultAddress = data.vaultAddress;
      elements.vaultAddress.textContent = data.vaultAddress;
      showView('success');
      return;
    } catch {
      // Invalid stored data, proceed with fresh creation
      localStorage.removeItem('agentvault_credential');
    }
  }

  // Set up event listeners
  elements.createBtn.addEventListener('click', handleCreateWallet);
  elements.copyBtn.addEventListener('click', handleCopyAddress);
  elements.doneBtn.addEventListener('click', handleDone);
  elements.retryBtn.addEventListener('click', handleRetry);

  showView('welcome');
}

// Start the app
init().catch(console.error);
