# Security Audit Report: AgentVault

**Date**: 2026-02-16
**Scope**: TypeScript agent code (`src/`) and smart contract spec (`docs/plans/`)
**Severity Levels**: Critical, High, Medium, Low, Informational

---

## Executive Summary

This audit identified **3 Critical**, **3 High**, **6 Medium**, and **4 Low** severity issues across the TypeScript agent code and smart contract specification. The most critical issues relate to session key security, rate manipulation vectors, and missing on-chain protections.

**Note**: Telegram webhook authentication is handled by OpenClaw and not in scope.

---

## Critical Severity

### C1: Session Key Private Key Stored in Memory [FIXED]

**File**: `src/types.ts:170-174`, `src/wallet-manager.ts:481`

**Status**: FIXED in `src/session-key-manager.ts`

**Original Issue**: Session key private keys were stored in plaintext in memory.

**Fix Applied**:
- Created `SecureSessionKeyManager` class that encrypts keys with AES-256-GCM
- Keys are only decrypted momentarily for signing, then discarded
- Master key can be loaded from KMS/HSM in production
- Old `SessionKey` interface marked as `@deprecated`

```typescript
// Before (vulnerable):
const sessionKey = { address, privateKey: '0x...', config };

// After (secure):
const manager = new SecureSessionKeyManager(masterKey);
const encrypted = manager.generateSessionKey(config);  // Stored encrypted
const decrypted = manager.decryptForSigning(address);  // Only when needed
```

---

### C2: No Cumulative Daily Limit for Session Keys (Plan Gap S2) [FIXED]

**File**: `contracts/src/AgentVault.sol`

**Status**: FIXED

**Original Issue**: Each session key has its own spend limit, but there's no global daily cap. An attacker who compromises the agent could create multiple session keys and drain funds up to `n * spendLimit`.

**Fix Applied**:
- Added `sessionKeyDailyCap` (uint128) - cumulative daily cap for ALL session keys
- Added `sessionKeyDailySpent` (uint128) - tracks cumulative spending today
- Added `sessionKeyLastResetDay` (uint64) - resets daily
- Added `setSessionKeyDailyCap()` owner function to configure
- Added `getAvailableSessionKeyDailyLimit()` view function
- `_updateSessionKeySpend()` now enforces cumulative cap with `SessionKeyDailyCapExceeded` error

```solidity
// In _updateSessionKeySpend:
if (sessionKeyDailySpent + amount > sessionKeyDailyCap) {
    revert SessionKeyDailyCapExceeded();
}
sessionKeyDailySpent += amount;
```

---

### C3: Amount Extraction Logic is Fragile [FIXED]

**File**: `contracts/src/AgentVault.sol`

**Status**: FIXED

**Original Issue**: Amount extraction assumed all protocols encode amount at bytes 36-68. Different protocols use different signatures:
- ERC-4626 `withdraw(assets, receiver, owner)` - amount is first
- Compound V3 `supply(asset, amount)` - amount is second
- Moonwell `mint(amount)` - amount is first and only

**Fix Applied**:
- Added protocol-specific function selectors as constants
- Rewrote `_extractAmountFromData()` to detect selector and extract amount correctly
- Reverts with `NotWhitelistedOperation` for unknown selectors (prevents bypass)

```solidity
// Protocol selectors
bytes4 private constant AAVE_SUPPLY_SELECTOR = 0x617ba037;
bytes4 private constant ERC4626_DEPOSIT_SELECTOR = 0x6e553f65;
bytes4 private constant CTOKEN_MINT_SELECTOR = 0xa0712d68;
// ... (10 selectors total)

function _extractAmountFromData(bytes memory data) internal pure returns (uint256 amount) {
    bytes4 selector = ...;

    // Aave/Compound: amount at position 2
    if (selector == AAVE_SUPPLY_SELECTOR) { amount = data[36:68]; }

    // ERC4626/Moonwell: amount at position 1
    if (selector == ERC4626_DEPOSIT_SELECTOR) { amount = data[4:36]; }

    // Unknown selector - revert to prevent bypass
    revert NotWhitelistedOperation();
}
```

---

## High Severity

### H1: No Slippage Protection in Protocol Encoders

**Files**: `src/protocols/aave.ts`, `compound.ts`, `morpho.ts`, `moonwell.ts`

**Impact**: Deposit/withdraw calls are encoded without slippage protection or deadlines. During the time between proposal creation and execution, rates could change or the vault could be sandwiched.

**Recommendation**: Add minimum amount out parameters:
```typescript
encodeWithdraw(amount: bigint, vault: Address, minAmountOut: bigint): Hex {
  // Include slippage protection
}
```

---

### H2: Approval URL Lacks Replay Protection

**File**: `src/approval-flow.ts:214-226`

```typescript
private generateApprovalUrl(proposalId: string, userOpHash: Hex, vaultAddress: Address): string {
    const params = new URLSearchParams({
      id: proposalId,
      hash: userOpHash,
      vault: vaultAddress,
    });
    return `${this.config.approvalUiBaseUrl}?${params.toString()}`;
}
```

**Impact**: The approval URL doesn't include:
1. A session nonce to prevent replay
2. An expiry timestamp in the URL itself
3. A signature to prevent tampering

An attacker could intercept and reuse URLs.

**Recommendation**: Add signed, time-bound URLs:
```typescript
const params = {
  id: proposalId,
  hash: userOpHash,
  vault: vaultAddress,
  exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
  nonce: crypto.randomBytes(16).toString('hex'),
};
const signature = signParams(params, SECRET_KEY);
```

---

### H3: DeFiLlama API Trust

**File**: `src/protocols/defillama.ts`

**Impact**: The agent trusts DeFiLlama API responses without additional verification. If DeFiLlama is compromised or returns manipulated data, the agent could make incorrect rebalancing decisions.

**Recommendation**:
1. Cross-reference with multiple data sources (e.g., on-chain reads as primary)
2. Implement sanity checks (rates within historical bounds)
3. Alert on significant discrepancies between on-chain and DeFiLlama

---

## Medium Severity

### M1: Rate History Lost on Restart

**File**: `src/rate-history.ts`

**Impact**: Rate history is stored in memory. On process restart:
1. TWAP calculations will be inaccurate
2. Anomaly detection won't catch rate spikes that occurred before restart
3. An attacker could time manipulation to coincide with restarts

**Recommendation**: Persist rate history to SQLite or Redis:
```typescript
export class PersistentRateHistory extends RateHistory {
  constructor(private db: Database) { super(); }

  record(entry: RateEntry): void {
    super.record(entry);
    this.db.insert('rate_history', entry);
  }

  async loadFromDb(): Promise<void> {
    const entries = await this.db.query('SELECT * FROM rate_history WHERE timestamp > ?', [Date.now() - 24*60*60*1000]);
    entries.forEach(e => super.record(e));
  }
}
```

---

### M2: Bundler URL Not Validated

**File**: `src/wallet-manager.ts:354, 557, 593`

**Impact**: The bundler URL is used directly in `fetch()` calls. A malicious bundler URL could:
1. Log all UserOperations (including signatures)
2. Return fake hashes while not submitting
3. Front-run transactions

**Recommendation**: Validate bundler URL against allowlist:
```typescript
const ALLOWED_BUNDLERS = [
  'https://bundler.base.org',
  'https://api.pimlico.io',
  'https://api.alchemy.com',
];

if (!ALLOWED_BUNDLERS.some(b => this.bundlerUrl.startsWith(b))) {
  throw new Error('Untrusted bundler URL');
}
```

---

### M3: No Reentrancy Guard in executeStrategy (Contract)

**File**: `docs/plans/...plan.md:441-454`

```solidity
function executeStrategy(address protocol, bytes calldata data) external onlyEntryPoint {
    require(whitelistedProtocols[protocol], "Protocol not whitelisted");
    _updateDailySpend(_extractAmountFromData(data));
    (bool success,) = protocol.call(data);  // External call before state finalized
    require(success, "Strategy execution failed");
}
```

**Impact**: While `onlyEntryPoint` provides some protection, if a whitelisted protocol has a callback, it could potentially re-enter during execution.

**Recommendation**: Use OpenZeppelin's ReentrancyGuard or Solady's equivalent.

---

### M4: Telegram Bot Token in Logs

**File**: `src/approval-flow.ts:257-258`

```typescript
await fetch(
  `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`,
```

**Impact**: If request logging is enabled or an error occurs, the bot token could be logged.

**Recommendation**:
1. Never log URLs containing secrets
2. Use environment variables validated at startup
3. Consider using webhook mode instead of polling

---

### M5: Pending Approvals Lost on Restart

**File**: `src/approval-flow.ts:54`

```typescript
private readonly pendingApprovals: Map<string, ApprovalRequest> = new Map();
```

**Impact**: If the server restarts while approvals are pending, users who signed will get no feedback and transactions won't execute.

**Recommendation**: Persist pending approvals to Redis or database.

---

### M6: Type Assertions on Contract Reads

**Files**: All protocol files

```typescript
const balance = await this.client.readContract({...}) as bigint;
```

**Impact**: If a protocol upgrades and changes return types, the assertion will silently produce incorrect values.

**Recommendation**: Validate return types at runtime:
```typescript
const result = await this.client.readContract({...});
if (typeof result !== 'bigint') {
  throw new Error(`Unexpected return type from ${protocol.name}.balanceOf`);
}
```

---

## Low Severity

### L1: Predictable Proposal IDs

**File**: `src/approval-flow.ts:78`

```typescript
id: nanoid(12),
```

**Impact**: While nanoid is cryptographically random, 12 characters provides ~62^12 entropy. For high-security applications, consider longer IDs.

**Recommendation**: Use `nanoid(21)` for ~128-bit security.

---

### L2: No Rate Limiting on Approval Processing

**File**: `src/approval-flow.ts:323`

**Impact**: An attacker could spam `processApproval` calls, causing resource exhaustion.

**Recommendation**: Implement rate limiting per proposal ID.

---

### L3: Console Logging in Production

**Files**: Multiple

**Impact**: `console.error` and `console.log` calls remain in production, potentially leaking sensitive data.

**Recommendation**: Use structured logger with appropriate log levels.

---

### L4: No Input Validation on Vault Address

**Files**: Multiple

**Impact**: Invalid addresses could cause unexpected behavior.

**Recommendation**: Validate addresses using viem's `isAddress()`.

---

## Informational

### I1: Different Signature Curves

Session keys use secp256k1 (Ethereum standard), while passkeys use P-256 (WebAuthn standard). This is intentional but worth documenting for security reviewers.

### I2: ERC-4626 Share Price Oracle Risk

For Morpho, APY is calculated from share price changes. This could be manipulated via flash loans in a single block.

### I3: No Emergency Pause in Agent

The smart contract has owner controls, but the agent has no emergency stop mechanism.

---

## Recommendations Summary

| Priority | Action |
|----------|--------|
| ~~Immediate~~ | ~~Fix C1 (session key storage), C2 (cumulative limits), C3 (amount extraction)~~ **ALL FIXED** |
| High | URL signing (H2), slippage protection (H1), DeFiLlama verification (H3) |
| Medium | Persist rate history (M1), validate bundler URL (M2) |
| Low | Increase ID entropy, add rate limiting |

### Critical Issues Status
- **C1**: FIXED - `SecureSessionKeyManager` with AES-256-GCM encryption
- **C2**: FIXED - Cumulative `sessionKeyDailyCap` across all keys
- **C3**: FIXED - Protocol-specific amount extraction with 10 selectors

---

## Files Changed for This Audit

This audit reviewed:
- `src/wallet-manager.ts`
- `src/approval-flow.ts`
- `src/audit-logger.ts`
- `src/types.ts`
- `src/yield-monitor.ts`
- `src/rate-history.ts`
- `src/protocols/*.ts`
- `docs/plans/2026-02-16-feat-agentvault-stablecoin-yield-optimizer-plan.md`
