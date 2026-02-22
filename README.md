# AgentVault — Agentic Stablecoin Yield Optimizer

An autonomous agent that monitors DeFi yield rates across protocols on Base and rebalances USDC positions to maximize returns — secured by an ERC-4337 smart wallet with passkey (Face ID / fingerprint) authentication.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    AgentRunner (agent.ts)                │
│  Orchestrates the full loop: monitor → propose →        │
│  auto-execute or request approval → submit UserOp       │
└────────┬──────────┬──────────┬──────────┬───────────────┘
         │          │          │          │
    ┌────▼───┐ ┌────▼────┐ ┌──▼───┐ ┌───▼────────────┐
    │ Yield  │ │Approval │ │Wallet│ │  Session Key    │
    │Monitor │ │  Flow   │ │Mgr   │ │  Manager        │
    └────┬───┘ └────┬────┘ └──┬───┘ └───┬────────────┘
         │          │         │         │
    ┌────▼───┐      │    ┌────▼────┐    │
    │Protocol│      │    │ERC-4337 │    │
    │Adapters│      │    │Bundler  │    │
    │(4 DeFi)│      │    │(Pimlico)│    │
    └────┬───┘      │    └────┬────┘    │
         │          │         │         │
    ─────▼──────────▼─────────▼─────────▼─────
              Base L2 (mainnet / sepolia)
    ──────────────────────────────────────────
         │                    │
    ┌────▼────────┐    ┌─────▼──────────┐
    │ DeFi Pools  │    │  AgentVault    │
    │ Aave/Comp/  │    │  (ERC-4337     │
    │ Morpho/Moon │    │   Smart Wallet)│
    └─────────────┘    └────────────────┘
```

## How It Works

### 1. Yield Monitoring (`yield-monitor.ts`)

The agent polls yield rates from four protocols on Base:

| Protocol | Source | Method |
|---|---|---|
| **Aave V3** | On-chain `getReserveData()` | Supply rate from liquidity index |
| **Compound V3** | On-chain `getSupplyRate()` | Per-second rate → annualized |
| **Morpho Blue** | On-chain ERC-4626 `totalAssets/totalSupply` | Share price delta over time |
| **Moonwell** | On-chain `supplyRatePerTimestamp()` | Per-second rate → annualized |

**Rate protection:**
- **TWAP smoothing** — uses time-weighted average over a configurable window (default 1h) instead of spot rates to resist manipulation
- **Anomaly detection** — flags suspicious rate velocity (sudden spikes/drops) and TWAP deviation
- **DeFiLlama fallback** — if on-chain reads fail, falls back to DeFiLlama's yield API for rate data

### 2. Rebalance Decision

When the best available APY exceeds the current position's APY by ≥50 basis points (`MIN_APY_DIFFERENTIAL_BPS`), a `RebalanceProposal` is created.

The proposal includes: source/target protocols, amount, APY delta, estimated gas cost.

### 3. Execution Path (two lanes)

```
                    RebalanceProposal
                          │
              ┌───────────┴───────────┐
              │                       │
        amount ≤ threshold      amount > threshold
              │                       │
        ┌─────▼──────┐        ┌──────▼───────┐
        │ Auto-Execute│        │  Request     │
        │ Session Key │        │  Approval    │
        │ Signs UserOp│        │  (Passkey)   │
        └─────┬──────┘        └──────┬───────┘
              │                      │
              │               User opens URL,
              │               signs with Face ID
              │                      │
              └──────────┬───────────┘
                         │
                   ┌─────▼──────┐
                   │  Submit    │
                   │  UserOp to │
                   │  Bundler   │
                   └─────┬──────┘
                         │
                   ┌─────▼──────┐
                   │  EntryPoint│
                   │  executes  │
                   │  on Base   │
                   └────────────┘
```

**Auto-execute** (small amounts): The agent uses an encrypted session key to sign and submit the UserOp directly. No human interaction needed. Default threshold: $100 USDC.

**Approval required** (large amounts): The agent creates an approval request with a deep-link URL. The user opens it, reviews the proposal, and signs with their passkey (Face ID/fingerprint). The signed UserOp is then submitted.

### 4. Smart Wallet (`contracts/src/AgentVault.sol`)

An ERC-4337 v0.7 smart account with:

- **Passkey authentication** — P-256 signature verification via WebAuthn (RIP-7212 precompile on Base)
- **Session keys** — time-limited, spend-limited keys for agent auto-execution
- **Protocol whitelist** — only approved DeFi protocols can be called
- **Daily spending limits** — hard cap on total daily spend across all session keys
- **Dual signature types** — `0x00` for passkey (owner), `0x01` for session key (agent)

Factory contract (`AgentVaultFactory.sol`) deploys new vaults via `CREATE2` for deterministic addresses.

## Network & Data Flow

### On-chain reads (no gas)
```
Agent → RPC (Alchemy/Infura) → Base L2
  ├── Protocol supply rates (Aave, Compound, Morpho, Moonwell)
  ├── Vault USDC balance
  └── Session key config & spending state
```

### Off-chain fallback
```
Agent → DeFiLlama Yields API (https://yields.llama.fi/pools)
  └── APY data for Base USDC pools (when on-chain reads fail)
```

### Transaction submission
```
Agent → Pimlico Bundler → EntryPoint v0.7 → AgentVault → DeFi Protocol
  └── ERC-4337 UserOperation (signed by session key or passkey)
```

### Approval flow (large rebalances)
```
Agent → OpenClaw → Telegram notification → User clicks URL
  → Approval UI → WebAuthn passkey signature → Agent → Bundler
```

## Module Reference

| Module | Purpose |
|---|---|
| `agent.ts` | Main orchestrator — config, polling loop, execution |
| `yield-monitor.ts` | Rate fetching, TWAP, anomaly detection, comparison |
| `wallet-manager.ts` | UserOp building, gas estimation, bundler submission |
| `approval-flow.ts` | Proposal lifecycle, approval URLs, passkey processing |
| `session-key-manager.ts` | AES-256-GCM encrypted session key storage |
| `audit-logger.ts` | Structured audit trail (file or in-memory) |
| `rate-history.ts` | Time-series rate storage, TWAP calc, anomaly detection |
| `logger.ts` | Structured JSON logging |
| `config.ts` | Chain addresses, yield parameters |
| `types.ts` | All TypeScript types, enums, error classes |
| `protocols/` | Protocol adapters (Aave, Compound, Morpho, Moonwell, DeFiLlama) |

## Setup

### Prerequisites
- Node.js 18+
- An RPC URL for Base or Base Sepolia (e.g., [Alchemy](https://www.alchemy.com/))
- A bundler URL (e.g., [Pimlico](https://www.pimlico.io/))
- A deployed AgentVault contract

### Environment Variables

```bash
# Required
VAULT_ADDRESS=0x...        # Your deployed AgentVault address
RPC_URL=https://...        # Base RPC endpoint
BUNDLER_URL=https://...    # ERC-4337 bundler endpoint
SESSION_KEY_MASTER=0x...   # 32-byte hex key for AES-256-GCM encryption
SESSION_KEY_ADDRESS=0x...  # Address of the session key (granted on-chain)
SESSION_KEY_PRIVATE=0x...  # Private key of the session key

# Optional
CHAIN=base-sepolia         # "base" or "base-sepolia" (default: base-sepolia)
APPROVAL_UI_URL=http://... # Approval UI base URL (default: http://localhost:3000)
POLL_INTERVAL_MS=3600000   # Yield check interval (default: 1 hour)
AUTO_EXECUTE_THRESHOLD=100000000  # Auto-execute limit in USDC base units (default: $100)
```

### Install & Run

```bash
npm install
npm run build
npm run dev    # Development with hot-reload (tsx watch)
npm start      # Production (compiled JS)
```

### Testing

```bash
npm test                   # Unit tests (mocked, no network)
TESTNET=1 npm test         # Include integration tests (hits Base mainnet RPCs, read-only)
```

## Smart Contract Deployment

Contracts use [Foundry](https://book.getfoundry.sh/):

```bash
cd contracts
forge build
forge test

# Deploy to Base Sepolia
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
```

## Security Model

- **Owner keys never touch the agent** — passkey signatures happen in the browser via WebAuthn
- **Session keys are encrypted at rest** — AES-256-GCM with a master key, decrypted only for signing
- **On-chain guardrails** — protocol whitelist, daily limits, per-key spend limits, auto-execute threshold
- **Rate manipulation protection** — TWAP smoothing + anomaly detection prevent flash-loan-style APY manipulation from triggering bad rebalances
- **Audit trail** — every proposal, approval, and execution is logged with full context

## License

MIT
