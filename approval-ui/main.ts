/**
 * AgentVault Approval UI - WebAuthn Passkey Signing
 *
 * This frontend handles:
 * - Parsing approval request parameters from URL
 * - Displaying transaction details
 * - Triggering WebAuthn passkey signing (Face ID / fingerprint)
 * - Sending the signature back to the approval service
 */

// ============ Types ============

interface ApprovalParams {
  proposalId: string;
  userOpHash: string;
  vaultAddress: string;
}

interface ProposalDetails {
  action: string;
  fromProtocol: string;
  toProtocol: string;
  amount: string;
  currentAPY: string;
  newAPY: string;
  apyGain: string;
  estimatedGas: string;
  expiresAt: string;
}

interface WebAuthnSignature {
  authenticatorData: string;
  clientDataJSON: string;
  challengeIndex: number;
  typeIndex: number;
  r: string;
  s: string;
}

// ============ DOM Elements ============

const elements = {
  loadingState: document.getElementById('loading-state')!,
  approvalView: document.getElementById('approval-view')!,
  successState: document.getElementById('success-state')!,
  errorState: document.getElementById('error-state')!,
  rejectedState: document.getElementById('rejected-state')!,
  expiredState: document.getElementById('expired-state')!,
  errorContainer: document.getElementById('error-container')!,
  errorText: document.getElementById('error-text')!,
  amount: document.getElementById('amount')!,
  fromProtocol: document.getElementById('from-protocol')!,
  fromApy: document.getElementById('from-apy')!,
  toProtocol: document.getElementById('to-protocol')!,
  toApy: document.getElementById('to-apy')!,
  apyGain: document.getElementById('apy-gain')!,
  gasCost: document.getElementById('gas-cost')!,
  vaultAddress: document.getElementById('vault-address')!,
  expiryText: document.getElementById('expiry-text')!,
  approveBtn: document.getElementById('approve-btn') as HTMLButtonElement,
  rejectBtn: document.getElementById('reject-btn') as HTMLButtonElement,
  retryBtn: document.getElementById('retry-btn') as HTMLButtonElement,
};

// ============ State ============

let currentParams: ApprovalParams | null = null;
let proposalDetails: ProposalDetails | null = null;

// ============ View Management ============

function showView(view: 'loading' | 'approval' | 'success' | 'error' | 'rejected' | 'expired') {
  elements.loadingState.classList.add('hidden');
  elements.approvalView.classList.add('hidden');
  elements.successState.classList.add('hidden');
  elements.errorState.classList.add('hidden');
  elements.rejectedState.classList.add('hidden');
  elements.expiredState.classList.add('hidden');

  switch (view) {
    case 'loading':
      elements.loadingState.classList.remove('hidden');
      break;
    case 'approval':
      elements.approvalView.classList.remove('hidden');
      break;
    case 'success':
      elements.successState.classList.remove('hidden');
      break;
    case 'error':
      elements.errorState.classList.remove('hidden');
      break;
    case 'rejected':
      elements.rejectedState.classList.remove('hidden');
      break;
    case 'expired':
      elements.expiredState.classList.remove('hidden');
      break;
  }
}

function showError(message: string) {
  elements.errorContainer.textContent = message;
  elements.errorContainer.classList.remove('hidden');
}

function hideError() {
  elements.errorContainer.classList.add('hidden');
}

// ============ URL Parameter Parsing ============

function parseUrlParams(): ApprovalParams | null {
  const params = new URLSearchParams(window.location.search);

  const proposalId = params.get('id');
  const userOpHash = params.get('hash');
  const vaultAddress = params.get('vault');

  if (!proposalId || !userOpHash || !vaultAddress) {
    return null;
  }

  return { proposalId, userOpHash, vaultAddress };
}

// ============ API Communication ============

const API_BASE_URL = import.meta.env?.VITE_API_URL || '/api';

async function fetchProposalDetails(proposalId: string): Promise<ProposalDetails> {
  const response = await fetch(`${API_BASE_URL}/proposals/${proposalId}`);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Proposal not found or has expired');
    }
    throw new Error('Failed to fetch proposal details');
  }

  return response.json();
}

async function submitApproval(proposalId: string, signature: WebAuthnSignature): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/proposals/${proposalId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      approved: true,
      webAuthnAuth: signature,
      timestamp: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || 'Failed to submit approval');
  }
}

async function submitRejection(proposalId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/proposals/${proposalId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      approved: false,
      timestamp: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    console.error('Failed to submit rejection');
  }
}

// ============ UI Updates ============

function updateUI(details: ProposalDetails) {
  elements.amount.textContent = details.amount;
  elements.fromProtocol.textContent = details.fromProtocol;
  elements.fromApy.textContent = `${details.currentAPY} APY`;
  elements.toProtocol.textContent = details.toProtocol;
  elements.toApy.textContent = `${details.newAPY} APY`;
  elements.apyGain.textContent = details.apyGain;
  elements.gasCost.textContent = details.estimatedGas;

  // Format vault address (0x1234...5678)
  if (currentParams) {
    const addr = currentParams.vaultAddress;
    elements.vaultAddress.textContent = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }

  // Calculate expiry text
  const expiresAt = new Date(details.expiresAt);
  const now = new Date();
  const hoursRemaining = Math.max(0, Math.round((expiresAt.getTime() - now.getTime()) / 3600000));

  if (hoursRemaining === 0) {
    elements.expiryText.textContent = 'Expires soon';
  } else if (hoursRemaining === 1) {
    elements.expiryText.textContent = 'Expires in 1 hour';
  } else {
    elements.expiryText.textContent = `Expires in ${hoursRemaining} hours`;
  }
}

// ============ WebAuthn Passkey Signing ============

/**
 * Sign the userOpHash using WebAuthn (passkey)
 * This triggers Face ID / fingerprint authentication
 */
async function signWithPasskey(userOpHash: string): Promise<WebAuthnSignature> {
  // Convert hex hash to bytes for challenge
  const challenge = hexToBytes(userOpHash);

  // Get credential - this will trigger Face ID / fingerprint
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge,
      timeout: 60000,
      userVerification: 'required',
      rpId: window.location.hostname,
      allowCredentials: [], // Empty for discoverable credentials
    },
  })) as PublicKeyCredential;

  if (!credential) {
    throw new Error('No credential received');
  }

  const response = credential.response as AuthenticatorAssertionResponse;

  // Extract signature components
  const authenticatorData = bytesToHex(new Uint8Array(response.authenticatorData));
  const clientDataJSON = new TextDecoder().decode(response.clientDataJSON);

  // Parse the P-256 signature (DER encoded)
  const signatureData = new Uint8Array(response.signature);
  const { r, s } = parseDerSignature(signatureData);

  // Find challenge and type indices in clientDataJSON
  const challengeIndex = clientDataJSON.indexOf('"challenge"');
  const typeIndex = clientDataJSON.indexOf('"type"');

  return {
    authenticatorData,
    clientDataJSON,
    challengeIndex,
    typeIndex,
    r: bigintToHex(r),
    s: bigintToHex(s),
  };
}

/**
 * Parse DER-encoded P-256 signature into r and s components
 */
function parseDerSignature(sig: Uint8Array): { r: bigint; s: bigint } {
  // DER format: 0x30 [total-length] 0x02 [r-length] [r] 0x02 [s-length] [s]
  let offset = 0;

  // Skip sequence tag and length
  if (sig[offset] !== 0x30) throw new Error('Invalid signature format');
  offset += 2;

  // Parse r
  if (sig[offset] !== 0x02) throw new Error('Invalid r tag');
  offset++;
  const rLength = sig[offset];
  offset++;
  let r = sig.slice(offset, offset + rLength);
  offset += rLength;

  // Parse s
  if (sig[offset] !== 0x02) throw new Error('Invalid s tag');
  offset++;
  const sLength = sig[offset];
  offset++;
  let s = sig.slice(offset, offset + sLength);

  // Remove leading zero bytes (DER padding)
  if (r[0] === 0) r = r.slice(1);
  if (s[0] === 0) s = s.slice(1);

  // Ensure canonical s (s <= n/2 for secp256r1)
  const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  let sBigInt = bytesToBigInt(s);
  if (sBigInt > n / 2n) {
    sBigInt = n - sBigInt;
  }

  return {
    r: bytesToBigInt(r),
    s: sBigInt,
  };
}

// ============ Utility Functions ============

function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return (
    '0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

function bigintToHex(value: bigint): string {
  return '0x' + value.toString(16).padStart(64, '0');
}

// ============ Event Handlers ============

async function handleApprove() {
  if (!currentParams || !proposalDetails) return;

  elements.approveBtn.disabled = true;
  hideError();

  try {
    // Sign with passkey (triggers Face ID)
    const signature = await signWithPasskey(currentParams.userOpHash);

    // Submit to backend
    await submitApproval(currentParams.proposalId, signature);

    // Show success
    showView('success');
  } catch (error) {
    console.error('Signing error:', error);

    if (error instanceof Error) {
      if (error.name === 'NotAllowedError') {
        showError('Authentication cancelled. Please try again.');
      } else if (error.name === 'SecurityError') {
        showError('Security error. Please ensure you are using a secure context (HTTPS).');
      } else {
        elements.errorText.textContent = error.message;
        showView('error');
      }
    } else {
      showView('error');
    }

    elements.approveBtn.disabled = false;
  }
}

async function handleReject() {
  if (!currentParams) return;

  await submitRejection(currentParams.proposalId);
  showView('rejected');
}

function handleRetry() {
  elements.approveBtn.disabled = false;
  hideError();
  showView('approval');
}

// ============ Initialization ============

async function initialize() {
  // Parse URL parameters
  currentParams = parseUrlParams();

  if (!currentParams) {
    elements.errorText.textContent = 'Invalid approval link. Missing required parameters.';
    showView('error');
    return;
  }

  // Check WebAuthn support
  if (!window.PublicKeyCredential) {
    elements.errorText.textContent =
      'WebAuthn is not supported in this browser. Please use Safari or Chrome.';
    showView('error');
    return;
  }

  try {
    // For demo/development: use mock data if API is not available
    try {
      proposalDetails = await fetchProposalDetails(currentParams.proposalId);
    } catch {
      // Use mock data for development
      proposalDetails = {
        action: 'Rebalance USDC',
        fromProtocol: 'Compound V3',
        toProtocol: 'Aave V3',
        amount: '$1,000.00',
        currentAPY: '4.50%',
        newAPY: '5.25%',
        apyGain: '+0.75%',
        estimatedGas: '<$0.01',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
    }

    // Check if expired
    const expiresAt = new Date(proposalDetails.expiresAt);
    if (expiresAt < new Date()) {
      showView('expired');
      return;
    }

    // Update UI and show approval view
    updateUI(proposalDetails);
    showView('approval');
  } catch (error) {
    console.error('Initialization error:', error);
    elements.errorText.textContent =
      error instanceof Error ? error.message : 'Failed to load approval details';
    showView('error');
  }
}

// ============ Event Listeners ============

elements.approveBtn.addEventListener('click', handleApprove);
elements.rejectBtn.addEventListener('click', handleReject);
elements.retryBtn.addEventListener('click', handleRetry);

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
