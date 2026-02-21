---
title: "AgentVault: Agentic Stablecoin Yield Optimizer"
type: feat
status: active
date: 2026-02-16
---

# AgentVault: Agentic Stablecoin Yield Optimizer

## Overview

An ERC-4337 smart contract wallet on Base L2 that automatically routes USDC to the highest-yielding lending protocol. An off-chain agent monitors yields and proposes rebalancing transactions. Users approve via **passkeys (Face ID/fingerprint)** for a seamless 2FA experience without external wallet dependencies.

**Key Innovation**: Passkey-based 2FA where the agent proposes transactions and users approve with biometrics — no seed phrases, no Coinbase Wallet dependency, hardware-level security.

**Deployment**: Base mainnet from day 1. Start with small amounts ($20-50) to build confidence.

## Problem Statement / Motivation

1. **Yield fragmentation**: USDC yields vary significantly across Aave, Compound, Morpho, and Moonwell on Base. Manual monitoring and rebalancing is tedious.
2. **Agent trust problem**: Giving an AI agent full custody is risky. Current solutions require trusting hot wallets or complex multi-sig setups with wallet app dependencies.
3. **Poor UX for 2FA**: Traditional multi-sig requires opening a wallet app, navigating to the transaction, and signing. Passkeys enable one-tap Face ID approval.

## Proposed Solution

A two-component system:

1. **AgentVault Smart Contract** (ERC-4337): Holds USDC, enforces that the agent can ONLY move funds between whitelisted yield protocols, and requires passkey signature for execution.

2. **Yield Agent** (TypeScript/OpenClaw skill): Monitors rates hourly, proposes rebalancing when differential > 0.5% APY, sends approval requests, and submits signed UserOperations to bundler.

### Security Model

```
┌─────────────────────────────────────────────────────────────────┐
│                    WHAT THE AGENT CAN DO                        │
├─────────────────────────────────────────────────────────────────┤
│ ✅ Propose deposits to Aave, Compound, Morpho, Moonwell        │
│ ✅ Propose withdrawals FROM protocols TO the vault              │
│ ✅ Propose rebalancing between whitelisted protocols            │
│ ✅ Auto-execute moves under user-defined threshold (default $0) │
├─────────────────────────────────────────────────────────────────┤
│                   WHAT THE AGENT CANNOT DO                      │
├─────────────────────────────────────────────────────────────────┤
│ ❌ Withdraw to external addresses (owner passkey required)      │
│ ❌ Interact with non-whitelisted contracts                      │
│ ❌ Exceed daily transaction limits                              │
│ ❌ Execute above-threshold moves without passkey approval       │
└─────────────────────────────────────────────────────────────────┘
```

## Technical Approach

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      USER'S DEVICE                              │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │ OpenClaw    │◄───│ Approval UI  │◄───│ Secure Enclave   │   │
│  │ Notification│    │ (WebAuthn)   │    │ (Passkey P-256)  │   │
│  └─────────────┘    └──────────────┘    └──────────────────┘   │
└────────────────────────────┬────────────────────────────────────┘
                             │ Signed UserOperation
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      YIELD AGENT (Off-chain)                    │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │ Rate        │───▶│ Decision     │───▶│ UserOp Builder   │   │
│  │ Monitor     │    │ Engine       │    │ & Bundler Submit │   │
│  └─────────────┘    └──────────────┘    └──────────────────┘   │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      BASE L2 BLOCKCHAIN                         │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ EntryPoint v0.7 (0x0000000071727De22E5E9d8BAf0edAc6f37d) │  │
│  └────────────────────────────┬─────────────────────────────┘  │
│                               │                                 │
│  ┌────────────────────────────▼─────────────────────────────┐  │
│  │              AgentVault (ERC-4337 Account)               │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐   │  │
│  │  │ WebAuthn    │  │ Strategy     │  │ Spending       │   │  │
│  │  │ Verifier    │  │ Whitelist    │  │ Limits         │   │  │
│  │  │ (RIP-7212)  │  │ (4 protocols)│  │ ($100 auto)    │   │  │
│  │  └─────────────┘  └──────────────┘  └────────────────┘   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                               │                                 │
│      ┌───────────┬───────────┼───────────┬───────────┐         │
│      ▼           ▼           ▼           ▼           ▼         │
│  ┌───────┐  ┌─────────┐  ┌────────┐  ┌──────────┐  ┌──────┐   │
│  │ Aave  │  │Compound │  │ Morpho │  │ Moonwell │  │ USDC │   │
│  │ V3    │  │ V3      │  │ Blue   │  │          │  │      │   │
│  └───────┘  └─────────┘  └────────┘  └──────────┘  └──────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **2FA Method** | Passkeys (WebAuthn P-256) | No wallet app dependency, hardware security, Face ID UX |
| **P-256 Verification** | RIP-7212 precompile | Live on Base since Fjord (July 2024), only 3,450 gas vs 330k |
| **Fallback Verifier** | Base webauthn-sol | Auto-fallback to FreshCryptoLib if precompile unavailable |
| **EntryPoint Version** | v0.7 | Better paymaster gas accounting, current production standard |
| **Auto-execute Threshold** | $0 (user configurable) | Default requires approval for all transactions |
| **Yield Data** | On-chain reads | No API dependencies for critical path; DeFiLlama as backup |

### Implementation Phases

#### Phase 1: Smart Contract Foundation (Weekend 1)

**Goal**: Deploy a working passkey-enabled ERC-4337 wallet on Base Sepolia.

**Tasks**:

- [ ] **1.1** Scaffold Foundry project with dependencies
  ```bash
  forge install eth-infinitism/account-abstraction
  forge install base-org/webauthn-sol
  forge install vectorized/solady
  ```

- [ ] **1.2** Implement `AgentVault.sol` core contract
  - ERC-4337 BaseAccount implementation
  - Passkey owner storage (x, y coordinates as `bytes`)
  - WebAuthn signature validation using `webauthn-sol`
  - Protocol whitelist mapping
  - Daily spending limit tracking

- [ ] **1.3** Implement `AgentVaultFactory.sol`
  - CREATE2 deterministic deployment
  - Initialize with passkey public key

- [ ] **1.4** Write comprehensive tests
  - Unit tests for signature validation
  - Fork tests against Base mainnet EntryPoint
  - Gas benchmarks for P-256 verification

- [ ] **1.5** Deploy to Base Sepolia
  - Deploy factory
  - Create test vault
  - Verify on BaseScan

**Deliverables**:
- `contracts/src/AgentVault.sol`
- `contracts/src/AgentVaultFactory.sol`
- `contracts/test/AgentVault.t.sol`
- Deployed addresses on Base Sepolia

---

#### Phase 2: Yield Monitor & Protocol Integrations (Weekend 2)

**Goal**: Read live APY rates from all four protocols and identify the optimal one.

**Tasks**:

- [ ] **2.1** Implement protocol rate readers

  ```typescript
  // src/protocols/index.ts
  interface YieldProtocol {
    name: string;
    address: `0x${string}`;
    getAPY(): Promise<number>;
    getBalance(vault: `0x${string}`): Promise<bigint>;
    encodeDeposit(amount: bigint): `0x${string}`;
    encodeWithdraw(amount: bigint): `0x${string}`;
  }
  ```

- [ ] **2.2** Aave V3 integration
  - Read `currentLiquidityRate` from Pool (RAY units)
  - Encode `supply()` and `withdraw()` calls

- [ ] **2.3** Compound V3 integration
  - Read `getSupplyRate(getUtilization())`
  - Encode `supply()` and `withdraw()` calls

- [ ] **2.4** Morpho Blue integration
  - Track vault share price for APY calculation
  - Encode ERC-4626 `deposit()` and `withdraw()`

- [ ] **2.5** Moonwell integration
  - Read `supplyRatePerTimestamp()`
  - Encode `mint()` and `redeemUnderlying()`

- [ ] **2.6** Implement yield comparison logic
  - Poll rates every hour
  - Track historical rates for trend analysis
  - Determine optimal protocol with hysteresis (0.5% APY threshold)

- [ ] **2.7** Create basic OpenClaw skill
  - `/rates` command: Show current APYs across all protocols
  - `/positions` command: Show vault allocation

**Deliverables**:
- `src/protocols/aave.ts`
- `src/protocols/compound.ts`
- `src/protocols/morpho.ts`
- `src/protocols/moonwell.ts`
- `src/yield-monitor.ts`
- `SKILL.md` (basic version)

---

#### Phase 3: Agent Execution & Approval Flow (Weekend 3)

**Goal**: Agent can propose and execute yield optimization transactions with passkey approval.

**Tasks**:

- [ ] **3.1** Implement UserOperation builder
  - Build PackedUserOperation for v0.7 EntryPoint
  - Calculate gas limits (including L1 data fee for Base)
  - Sign with agent session key (for proposals)

- [ ] **3.2** Implement passkey approval frontend
  - Minimal web page for WebAuthn `navigator.credentials.get()`
  - Display transaction details (from protocol, to protocol, amount, APY delta)
  - Return signed UserOperation
  - During registration (`navigator.credentials.create()`), check `backupState` flag:
    - If `backupState === false`, warn user: "Enable iCloud Keychain / Google sync to back up your passkey"
    - If `backupEligible === false` (hardware key), require a second passkey or show strong warning

- [ ] **3.3** Implement Telegram approval flow
  - Send approval request with inline buttons
  - Deep link to approval web page
  - Handle timeout (24h expiry)

- [ ] **3.4** Add auto-execute for small amounts
  - If amount < $100, agent can execute with session key
  - Session key has limited permissions (whitelist only, spend limit)

- [ ] **3.5** Implement audit logging
  - Log every proposal with reasoning
  - Log every execution with tx hash
  - Log every rejection

- [ ] **3.6** Contract: Add session key support
  - `grantSessionKey(address, validUntil, allowedTargets, spendLimit)`
  - Validate session key in `_validateSignature`

**Deliverables**:
- `src/wallet-manager.ts`
- `src/approval-flow.ts`
- `src/approval-ui/` (minimal web app)
- `contracts/src/modules/SessionKeyModule.sol`
- Updated `SKILL.md`

---

#### Phase 4: Polish & Mainnet (Weekend 4)

**Goal**: Production-ready deployment with real funds.

**Tasks**:

- [ ] **4.1** Security hardening
  - Internal security review
  - Add emergency pause functionality
  - Add owner recovery mechanism (hardware key backup)

- [ ] **4.2** Gas optimization
  - Optimize contract for minimal gas
  - Use Solady where possible
  - Benchmark all operations

- [ ] **4.3** Deploy to Base mainnet
  - Deploy factory
  - Create personal vault
  - Whitelist all four protocols

- [ ] **4.4** Fund and test with real $50 USDC
  - Test deposit flow
  - Test rebalancing
  - Test approval flow
  - Test withdrawal

- [ ] **4.5** Finalize OpenClaw skill
  - `/deposit <amount>` command
  - `/withdraw <amount> <address>` command
  - `/rebalance` command (manual trigger)
  - `/status` command (full dashboard)
  - `/settings` command (thresholds, limits)

- [ ] **4.6** Documentation
  - README with setup instructions
  - Architecture diagram
  - Security model documentation

**Deliverables**:
- Deployed contracts on Base mainnet
- Complete OpenClaw skill
- Documentation

---

## Contract Specifications

### AgentVault.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4337} from "solady/accounts/ERC4337.sol";
import {WebAuthn} from "webauthn-sol/WebAuthn.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract AgentVault is ERC4337 {
    // ============ Storage ============

    // Passkey owner (P-256 public key coordinates)
    uint256 public ownerX;
    uint256 public ownerY;

    // Protocol whitelist
    mapping(address => bool) public whitelistedProtocols;

    // Session keys for agent
    struct SessionKey {
        uint48 validUntil;
        uint128 spendLimit;
        uint128 spent;
    }
    mapping(address => SessionKey) public sessionKeys;

    // Spending limits
    uint128 public dailyLimit;
    uint128 public dailySpent;
    uint64 public lastResetDay;

    // Auto-execute threshold (in USDC, 6 decimals)
    uint128 public autoExecuteThreshold; // Default: 100 * 1e6 = $100

    // ============ Events ============

    event ProtocolWhitelisted(address indexed protocol, bool status);
    event SessionKeyGranted(address indexed key, uint48 validUntil, uint128 spendLimit);
    event SessionKeyRevoked(address indexed key);
    event StrategyExecuted(address indexed protocol, bytes4 selector, uint256 amount);

    // ============ Initialization ============

    function initialize(
        uint256 _ownerX,
        uint256 _ownerY,
        address[] calldata _protocols,
        uint128 _dailyLimit,
        uint128 _autoExecuteThreshold
    ) external {
        require(ownerX == 0 && ownerY == 0, "Already initialized");
        ownerX = _ownerX;
        ownerY = _ownerY;
        dailyLimit = _dailyLimit;
        autoExecuteThreshold = _autoExecuteThreshold;

        for (uint i = 0; i < _protocols.length; i++) {
            whitelistedProtocols[_protocols[i]] = true;
            emit ProtocolWhitelisted(_protocols[i], true);
        }
    }

    // ============ Signature Validation ============

    function _validateSignature(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) internal view override returns (uint256 validationData) {
        // Decode signature type (0 = passkey, 1 = session key)
        uint8 sigType = uint8(userOp.signature[0]);

        if (sigType == 0) {
            // Passkey signature
            return _validatePasskeySignature(userOp.signature[1:], userOpHash);
        } else if (sigType == 1) {
            // Session key signature
            return _validateSessionKeySignature(userOp, userOpHash);
        }

        return 1; // Invalid signature type
    }

    function _validatePasskeySignature(
        bytes calldata signature,
        bytes32 userOpHash
    ) internal view returns (uint256) {
        WebAuthn.WebAuthnAuth memory auth = abi.decode(
            signature,
            (WebAuthn.WebAuthnAuth)
        );

        bool valid = WebAuthn.verify(
            abi.encodePacked(userOpHash),
            true, // requireUserVerification - CRITICAL
            auth,
            ownerX,
            ownerY
        );

        return valid ? 0 : 1;
    }

    function _validateSessionKeySignature(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) internal view returns (uint256) {
        // Extract session key address and ECDSA signature
        (address sessionKeyAddr, bytes memory sig) = abi.decode(
            userOp.signature[1:],
            (address, bytes)
        );

        SessionKey storage sk = sessionKeys[sessionKeyAddr];

        // Check validity
        if (block.timestamp > sk.validUntil) return 1;

        // Check spend limit (decode amount from calldata)
        uint256 amount = _extractAmount(userOp.callData);
        if (sk.spent + amount > sk.spendLimit) return 1;

        // Check it's a whitelisted operation
        if (!_isWhitelistedOperation(userOp.callData)) return 1;

        // Verify ECDSA signature
        bytes32 ethSignedHash = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n32",
            userOpHash
        ));

        (bytes32 r, bytes32 s, uint8 v) = _splitSignature(sig);
        if (ecrecover(ethSignedHash, v, r, s) != sessionKeyAddr) return 1;

        return 0;
    }

    // ============ Execution ============

    function executeStrategy(
        address protocol,
        bytes calldata data
    ) external onlyEntryPoint {
        require(whitelistedProtocols[protocol], "Protocol not whitelisted");

        // Update daily spending
        _updateDailySpend(_extractAmountFromData(data));

        (bool success,) = protocol.call(data);
        require(success, "Strategy execution failed");

        emit StrategyExecuted(protocol, bytes4(data[:4]), _extractAmountFromData(data));
    }

    // ============ Owner Functions (require passkey) ============

    function withdraw(
        address token,
        address to,
        uint256 amount
    ) external onlyEntryPoint {
        // This can only be called via UserOp signed by passkey
        IERC20(token).transfer(to, amount);
    }

    function grantSessionKey(
        address key,
        uint48 validUntil,
        uint128 spendLimit
    ) external onlyEntryPoint {
        sessionKeys[key] = SessionKey({
            validUntil: validUntil,
            spendLimit: spendLimit,
            spent: 0
        });
        emit SessionKeyGranted(key, validUntil, spendLimit);
    }

    function revokeSessionKey(address key) external onlyEntryPoint {
        delete sessionKeys[key];
        emit SessionKeyRevoked(key);
    }

    function setProtocolWhitelist(
        address protocol,
        bool status
    ) external onlyEntryPoint {
        whitelistedProtocols[protocol] = status;
        emit ProtocolWhitelisted(protocol, status);
    }

    // ============ Internal Helpers ============

    function _updateDailySpend(uint256 amount) internal {
        uint64 today = uint64(block.timestamp / 1 days);
        if (today > lastResetDay) {
            dailySpent = 0;
            lastResetDay = today;
        }
        dailySpent += uint128(amount);
        require(dailySpent <= dailyLimit, "Daily limit exceeded");
    }

    function _isWhitelistedOperation(bytes calldata callData) internal view returns (bool) {
        if (callData.length < 4) return false;
        bytes4 selector = bytes4(callData[:4]);

        // Only allow executeStrategy calls
        return selector == this.executeStrategy.selector;
    }

    function _extractAmount(bytes calldata callData) internal pure returns (uint256) {
        // Decode executeStrategy(address, bytes) and extract amount from inner call
        if (callData.length < 68) return 0;
        (, bytes memory data) = abi.decode(callData[4:], (address, bytes));
        return _extractAmountFromData(data);
    }

    function _extractAmountFromData(bytes memory data) internal pure returns (uint256) {
        // Common patterns: supply(asset,amount,...), deposit(amount,...), mint(amount)
        if (data.length < 36) return 0;
        // Most DeFi calls have amount in second parameter (after address)
        return abi.decode(data[36:68], (uint256));
    }

    function _splitSignature(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "Invalid signature length");
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }

    modifier onlyEntryPoint() {
        require(msg.sender == address(entryPoint()), "Only EntryPoint");
        _;
    }

    // ============ View Functions ============

    function getAvailableDailyLimit() external view returns (uint256) {
        uint64 today = uint64(block.timestamp / 1 days);
        if (today > lastResetDay) {
            return dailyLimit;
        }
        return dailyLimit - dailySpent;
    }
}
```

### Protocol Contract Addresses (Base Mainnet)

| Protocol | Contract | Address |
|----------|----------|---------|
| **USDC** | Token | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| **Aave V3** | Pool | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` |
| **Aave V3** | aUSDC | `0x4e65fE4DbA92790696d040ac24Aa414708F5c0Ab` |
| **Compound V3** | cUSDCv3 | `0xb125E6687d4313864e53df431d5425969c15Eb2F` |
| **Morpho Blue** | Spark Vault | `0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A` |
| **Moonwell** | mUSDC | `0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22` |
| **EntryPoint** | v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| **RIP-7212** | P-256 Precompile | `0x0000000000000000000000000000000000000100` |

## Alternative Approaches Considered

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Multi-sig (Gnosis Safe style)** | Battle-tested, well-understood | Requires wallet app, slower UX | Rejected for MVP |
| **MPC/TSS threshold signatures** | No on-chain multi-sig overhead | Complex setup, Lit Protocol dependency | Future consideration |
| **Session keys only (no 2FA)** | Simpler implementation | Lower security for large amounts | Used for auto-execute only |
| **EIP-7702 (native AA)** | No EntryPoint dependency | Not yet live on Base | Future migration path |

## Acceptance Criteria

### Functional Requirements

- [ ] User can create a new AgentVault by registering a passkey
- [ ] User can deposit USDC to their vault
- [ ] Agent monitors yields hourly and identifies optimal protocol
- [ ] Agent proposes rebalancing when APY differential > 0.5%
- [ ] User receives Telegram notification with approval link
- [ ] User can approve with Face ID/fingerprint via passkey
- [ ] Approved transactions execute within 1 minute
- [ ] Moves under $100 auto-execute without approval
- [ ] User can withdraw USDC to any address (requires passkey)
- [ ] User can view positions and historical performance

### Non-Functional Requirements

- [ ] P-256 signature verification < 10,000 gas (via RIP-7212)
- [ ] Total UserOp gas < 300,000 for rebalancing
- [ ] Approval flow completes in < 30 seconds (user action time)
- [ ] System handles RPC failures gracefully (retry with backoff)
- [ ] Audit log retained for 90 days

### Security Requirements

- [ ] Agent cannot withdraw to external addresses
- [ ] Agent cannot interact with non-whitelisted protocols
- [ ] Daily transaction limit enforced on-chain
- [ ] Session keys expire after 7 days
- [ ] Owner can revoke agent access at any time
- [ ] Passkey private key never leaves secure enclave

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Smart contract bug** | Medium | Critical | Extensive testing, start with $50, gradual increase |
| **Passkey loss/device loss** | Low | High | Support multiple passkeys, hardware key backup |
| **Protocol exploit (Aave, etc.)** | Low | High | Diversify across protocols, monitor for anomalies |
| **Agent key compromise** | Medium | Medium | Session keys with limited permissions, short expiry |
| **RIP-7212 unavailable** | Very Low | Low | Auto-fallback to Daimo P256Verifier |
| **Bundler downtime** | Low | Medium | Multiple bundler fallbacks (Alchemy, Pimlico) |
| **Oracle manipulation** | Low | Critical | Use Chainlink TWAP, not spot price |
| **Cumulative auto-exec abuse** | Medium | High | Enforce $500/day cumulative limit on-chain |

## Critical Gaps to Address (from SpecFlow Analysis)

### Security Gaps (Must Fix Before Mainnet)

| ID | Gap | Resolution |
|----|-----|------------|
| S1 | **Oracle for $100 threshold** | Use Chainlink USDC/USD with 1-hour TWAP to prevent manipulation |
| S2 | **Cumulative auto-exec limit** | Add on-chain daily cap of $500 for session key operations |
| S3 | **Rate gaming** | Add rate velocity checks - reject rebalance if rate changed >50% in 1 hour |
| S4 | **Recovery mechanism** | Rely on iCloud/Google passkey sync for primary recovery; detect `backupState` flag during onboarding and warn if not synced. Timelock escape hatch as Phase 5 follow-up. |

### UX Decisions Needed

| ID | Decision | Chosen Approach |
|----|----------|-----------------|
| U1 | Notification fatigue | Batch non-urgent notifications, priority levels for approvals |
| U2 | Multi-device passkey | Rely on iCloud Keychain / Google Password Manager sync |
| U3 | Withdrawal timing | Show estimated time based on protocol; most are instant on Base |
| U4 | Approval link expiry | 24 hours, single-use, tied to session |

### Error Handling (Implement in Phase 3)

| Scenario | Handling |
|----------|----------|
| Protocol paused during rebalance | Abort, notify user, funds remain in source |
| Telegram notification fails | Retry 3x, log for manual review |
| Passkey verification timeout | 60s timeout, allow retry |
| Rate API unavailable | Use last known rates, show staleness indicator |

## File Structure

```
agentvault/
├── SKILL.md                     # OpenClaw skill definition
├── contracts/
│   ├── foundry.toml
│   ├── remappings.txt
│   ├── src/
│   │   ├── AgentVault.sol       # Main wallet contract
│   │   ├── AgentVaultFactory.sol
│   │   └── interfaces/
│   │       ├── IAavePool.sol
│   │       ├── IComet.sol
│   │       ├── IERC4626.sol
│   │       └── IMToken.sol
│   ├── test/
│   │   ├── AgentVault.t.sol
│   │   ├── fork/
│   │   │   └── BaseFork.t.sol
│   │   └── helpers/
│   │       └── TestHelper.sol
│   └── script/
│       └── Deploy.s.sol
├── src/
│   ├── index.ts                 # Skill entry point
│   ├── yield-monitor.ts         # Rate polling & comparison
│   ├── wallet-manager.ts        # UserOp building & submission
│   ├── approval-flow.ts         # Telegram + passkey approval
│   ├── config.ts                # User settings
│   └── protocols/
│       ├── index.ts
│       ├── aave.ts
│       ├── compound.ts
│       ├── morpho.ts
│       └── moonwell.ts
├── approval-ui/                 # Minimal web app for passkey signing
│   ├── index.html
│   └── main.ts
├── config.json                  # Wallet address, limits, preferences
└── README.md
```

## Dependencies

### Smart Contracts

```toml
# foundry.toml dependencies
[dependencies]
account-abstraction = "eth-infinitism/account-abstraction"
webauthn-sol = "base-org/webauthn-sol"
solady = "vectorized/solady"
openzeppelin = "OpenZeppelin/openzeppelin-contracts"
```

### TypeScript

```json
{
  "dependencies": {
    "viem": "^2.x",
    "permissionless": "^0.2.x",
    "@simplewebauthn/server": "^10.x",
    "openclaw-sdk": "^1.x"
  }
}
```

## Success Metrics

1. **Yield capture**: Vault APY within 0.5% of best available protocol APY
2. **Rebalancing efficiency**: < $0.50 gas cost per rebalance on Base
3. **Approval latency**: < 30 seconds from notification to execution
4. **Uptime**: 99.9% yield monitoring availability
5. **Security**: Zero unauthorized transactions

## Future Considerations

Post-MVP enhancements (not in scope):

1. **Timelock Escape Hatch (Phase 5 - Priority)**: Recovery mechanism for users who lose all passkey access
   - User pre-registers a recovery address (hardware wallet) during onboarding
   - Recovery address can call `initiateRecovery()` starting a 7-day countdown
   - Owner can cancel anytime with passkey via `cancelRecovery()`
   - After 7 days, recovery address calls `executeRecovery()` to claim ownership
   - Implementation:
     ```solidity
     address public recoveryAddress;
     uint48 public recoveryInitiated;  // 0 = not active
     uint48 constant RECOVERY_DELAY = 7 days;

     function initiateRecovery() external;
     function cancelRecovery() external onlyEntryPoint;  // requires passkey
     function executeRecovery() external;  // after delay, transfers ownership
     ```
2. **Multi-sig fallback**: Add Coinbase Wallet as optional co-signer
3. **Cross-chain**: Extend to Arbitrum, Optimism via CCIP
4. **DCA**: Periodic swaps into ETH/other assets
5. **Tax optimization**: Harvest losses, optimize lot selection
6. **Multi-user**: SaaS model with per-user vaults
7. **RWA protocols**: Tokenized treasuries (Ondo, Backed)

---

## Agent-Native Web Integration (ERC-8128 + ERC-8004)

**Strategic Opportunity**: AgentVault is positioned at the intersection of smart wallet primitives and autonomous agents. The emerging ERC-8128 and ERC-8004 standards enable a fully agent-native web where AI agents authenticate, discover each other, and transact — all wallet-based.

### The Stack

| Layer | Standard | Purpose |
|-------|----------|---------|
| **Wallet** | ERC-4337 | Smart contract wallet (AgentVault already uses this) |
| **Auth** | ERC-8128 | Signed HTTP requests with Ethereum wallet |
| **Identity** | ERC-8004 | Trustless agent registry with on-chain reputation |
| **Payments** | x402 | HTTP 402 micropayments |

### ERC-8128: Signed HTTP Requests

**What it is**: Instead of API keys/bearer tokens, Ethereum wallets sign every HTTP request cryptographically. Built on RFC 9421 (HTTP Message Signatures) + ERC-191/ERC-1271.

**Why it matters for AgentVault**:
- AgentVault already has a signing key (session key) — add `@slicekit/erc8128` to sign all outbound API calls
- Every request is tamper-proof and non-replayable by default
- Works with smart contract wallets via ERC-1271 signature verification
- No API key management, no token rotation, no stored secrets

**Integration Path**:
```typescript
// Current: API key auth
const response = await fetch(defillamaUrl, {
  headers: { 'Authorization': `Bearer ${API_KEY}` }
});

// Future: ERC-8128 wallet auth
import { signRequest } from '@slicekit/erc8128';

const signedRequest = await signRequest({
  method: 'GET',
  url: defillamaUrl,
  signer: sessionKeyManager.decryptForSigning(address)
});
const response = await fetch(signedRequest);
```

### ERC-8004: Trustless Agent Registry

**What it is**: On-chain agent identity and reputation registry. Agents can discover each other, verify reputation scores, and delegate tasks.

**How AgentVault participates**:
1. **Register as agent**: AgentVault registers itself with capabilities ("yield-optimization", "stablecoin-management")
2. **Build reputation**: Successful rebalances, audit scores, TVL managed → on-chain reputation
3. **Discoverability**: Other agents or users find AgentVault via registry queries
4. **Delegation**: Users delegate "optimize my yield" to AgentVault's registered agent ID

### Implementation Roadmap

| Phase | Task | Description |
|-------|------|-------------|
| **P1** | ERC-8128 Outbound | Sign all DeFi API calls (DeFiLlama, protocol APIs) with session key |
| **P2** | ERC-8128 Inbound | Expose AgentVault status API with wallet auth (no API keys) |
| **P3** | ERC-8004 Registration | Register AgentVault in trustless agent registry |
| **P4** | Agent Discovery | Query registry for other yield agents, compare strategies |
| **P5** | x402 Data Monetization | Serve yield rate data behind micropayments |

### Build Opportunities

1. **First ERC-8128 Agent Wallet**: AgentVault becomes the first agent wallet that authenticates natively via ERC-8128 — a strong differentiator.

2. **DeFi Data MCP Server with ERC-8128 + x402**: Serve real-time yield rates/TVL data behind:
   - ERC-8128 auth (agents pay with their wallet)
   - x402 micropayments (per-query pricing)
   - Zero friction for other agents to consume

3. **OpenClaw `erc8128-auth` Skill**: Build a skill that lets any OpenClaw agent sign HTTP requests with its wallet. Every agent becomes a first-class web citizen.

4. **Cross-Agent Yield Arbitrage**: AgentVault discovers other yield agents via ERC-8004 registry, compares strategies, and routes funds to best performer.

### Why This Matters

Almost nobody is building at this intersection yet. The agent-native web stack is:

```
ERC-4337 (smart wallet) + ERC-8128 (auth) + ERC-8004 (identity) + x402 (payments)
```

AgentVault already has ERC-4337. Adding the remaining pieces positions it as foundational infrastructure for autonomous agents.

### References

- [ERC-8128 Draft](https://ethereum-magicians.org/t/erc-8128-signed-http-requests/16548) - HTTP Message Signatures for Ethereum
- [ERC-8004 Draft](https://ethereum-magicians.org/t/erc-8004-trustless-agents/15234) - Trustless Agent Registry
- [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html) - HTTP Message Signatures
- [x402 Protocol](https://x402.org) - HTTP 402 Micropayments
- [@slicekit/erc8128](https://github.com/slicekit/erc8128) - Reference implementation

## References

### Internal
- User requirements gathered in conversation

### External — Core
- [ERC-4337 Documentation](https://docs.erc4337.io/)
- [Base webauthn-sol](https://github.com/base-org/webauthn-sol)
- [RIP-7212 Specification](https://github.com/ethereum/RIPs/blob/master/RIPS/rip-7212.md)
- [Coinbase Smart Wallet](https://github.com/coinbase/smart-wallet)

### External — DeFi Protocols
- [Aave V3 Docs](https://docs.aave.com/)
- [Compound V3 Docs](https://docs.compound.finance/)
- [Morpho Blue Docs](https://docs.morpho.org/)
- [Moonwell Docs](https://docs.moonwell.fi/)

### External — Agent-Native Web (Future)
- [ERC-8128: Signed HTTP Requests](https://ethereum-magicians.org/t/erc-8128-signed-http-requests/16548)
- [ERC-8004: Trustless Agents](https://ethereum-magicians.org/t/erc-8004-trustless-agents/15234)
- [RFC 9421: HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421.html)
- [x402 Protocol](https://x402.org)
- [@slicekit/erc8128 Reference Implementation](https://github.com/slicekit/erc8128)
