# Arc MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that exposes Arc blockchain tools to AI agents — Claude, ChatGPT, Cursor, and any other MCP-compatible host.

## Tools

### Phase 0 — Core Tools

| Tool | Description |
|------|-------------|
| `get_usdc_balance` | Read USDC balance (6-decimal ERC-20) for any Arc address |
| `transfer_usdc` | Send USDC with per-call cap, daily limit, and address allowlist |
| `call_contract_read` | Execute view/pure functions on any Arc contract |
| `call_contract_write` | Execute state-changing contract calls with spending guards |
| `get_transaction_status` | Check tx confirmation via Arc RPC or Circle API |

### Phase 2 — ERC-8183 Job Tools

| Tool | Who calls it | Description |
|------|-------------|-------------|
| `job_get` | Anyone | Read job state (id, client, provider, budget, status, expiry) |
| `job_create` | Client | Create a job specifying provider, evaluator, expiry, and description |
| `job_set_budget` | Client | Set the USDC budget on an Open job |
| `job_approve_usdc` | Client | Approve the contract to pull USDC (required before fund) |
| `job_fund` | Client | Transfer the approved budget into the contract (Open → Funded) |
| `job_submit` | Provider | Submit a deliverable hash (Funded → Submitted) |
| `job_complete` | Evaluator | Accept the deliverable, release payment (Submitted → Completed) |
| `job_reject` | Evaluator | Reject the deliverable (Submitted → Rejected) |
| `job_claim_refund` | Client | Reclaim USDC from a Rejected or Expired job |

Contract: `0x0747EEf0706327138c69792bF28Cd525089e4583` (Arc Testnet, ERC-1967 proxy over `AgenticCommerce`)

### Phase 1 — Circle Agent Wallet Tools

| Tool | Description |
|------|-------------|
| `create_agent_wallet` | Create a new Circle Agent Wallet (2-of-2 MPC, user custody) |
| `list_agent_wallets` | List your Circle Agent Wallets with live USDC balances |
| `get_agent_policy` | Read current spending policies on an agent wallet |
| `set_agent_policy` | Set transfer limits and allow/block lists (mainnet only, OTP required) |
| `transfer_usdc_agent` | Transfer USDC from a Circle Agent Wallet with all Phase 0 guards applied |

## Safety Model

No private keys are stored on this server.

**`unsigned` mode (default):** The server builds a complete, ready-to-sign transaction and returns it as JSON. A human signs it with MetaMask, Frame, Rainbow, or `cast`. Zero key material on the server.

**`circle` mode:** Transactions are signed via [Circle Developer-Controlled Wallets](https://developers.circle.com/wallets/developer-controlled). Your encrypted entity secret authorises signing; Circle's infrastructure holds the actual key shards. Private keys never appear in plaintext on your server.

**`circle_agent` mode (Phase 1 — preferred for AI agents):** The server wraps the [Circle CLI](https://developers.circle.com/agent-stack/circle-cli) to operate [Circle Agent Wallets](https://developers.circle.com/agent-stack/agent-wallets). The wallet is built on 2-of-2 MPC — key shares never reach this server or the AI agent. The user retains custody. Policy changes require a human to complete an email OTP; the server never automates or bypasses this.

### Phase 0 guards (apply to ALL modes)

These run server-side before any Circle call:
1. **Kill switch** — `KILL_SWITCH=true` instantly blocks all writes
2. **Per-call cap** — rejects any single transfer above `PER_CALL_LIMIT_USDC`
3. **Daily rolling limit** — blocks when the 24-hour cumulative total exceeds `DAILY_LIMIT_USDC`
4. **Address allowlist** — rejects transfers to any address not in `ALLOWED_ADDRESSES`
5. **Contract allowlist** — rejects contract writes to any address not in `ALLOWED_CONTRACTS`
6. **Operation binding** — every write carries a keccak256 payload hash in the audit log

### Phase 1 additional guard (mainnet only)

7. **Circle policy check** — `transfer_usdc_agent` refuses to dispatch on mainnet if no spending policy is set on the source wallet (defense in depth on top of the Phase 0 guards).

## Setup

### 1. Configure environment

```bash
cp env.example.txt .env
# Edit .env with your settings
```

Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_MODE` | `unsigned` | `unsigned`, `circle`, or `circle_agent` |
| `MCP_TRANSPORT` | `both` | `stdio`, `http`, or `both` |
| `PER_CALL_LIMIT_USDC` | `10` | Max USDC per single call |
| `DAILY_LIMIT_USDC` | `100` | Max USDC per rolling 24-hour window |
| `ALLOWED_ADDRESSES` | _(empty — blocks all)_ | Comma-separated allowlist |
| `ARC_NETWORK` | `testnet` | `testnet` or `mainnet` |
| `KILL_SWITCH` | `false` | `true` to instantly block all writes |

For `circle` mode, also set:
- `CIRCLE_API_KEY` — from [console.circle.com](https://console.circle.com)
- `ENTITY_SECRET` — [register here](https://developers.circle.com/wallets/dev-controlled/register-entity-secret)
- `CIRCLE_WALLET_ID` — the agent wallet ID (create via Circle API)

### Phase 1: Circle Agent Wallets setup

```bash
# 1. Install Circle CLI
npm install -g @circle-fin/cli

# 2. Authenticate (use --testnet for testnet)
circle wallet login your@email.com --testnet
# Check your email for the OTP code and enter it

# 3. Verify authentication
circle wallet status --type agent

# 4. List existing agent wallets (created automatically on login)
circle wallet list --chain ARC-TESTNET --type agent

# 5. Fund a testnet wallet
circle wallet fund --address 0xYourWalletAddress --chain ARC-TESTNET
```

CLI sessions expire after 28 days. Re-run `circle wallet login` to renew.

> **Security:** Never give your AI agent access to your email inbox. Circle sends a one-time password (OTP) for policy changes. Always enter OTP codes yourself.

### 2. Build

```bash
bun install
bun run build
```

### 3. Get testnet USDC

Testnet USDC from the [Circle Faucet](https://faucet.circle.com) or the "Get test USDC" button in Arc Studio's sidebar.

---

## Connecting to AI Agents

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "arc": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/dist/server.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "ARC_NETWORK": "testnet",
        "AGENT_MODE": "unsigned",
        "PER_CALL_LIMIT_USDC": "10",
        "DAILY_LIMIT_USDC": "100"
      }
    }
  }
}
```

Restart Claude Desktop. The tools appear in Claude's tool list automatically.

### Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "arc": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/dist/server.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "ARC_NETWORK": "testnet",
        "AGENT_MODE": "unsigned"
      }
    }
  }
}
```

Reload Cursor's MCP config (Cmd/Ctrl+Shift+P → "MCP: Reload").

### HTTP + SSE (ChatGPT, remote agents)

Start in HTTP mode:

```bash
MCP_TRANSPORT=http MCP_PORT=3456 node dist/server.js
```

Endpoints:
- **SSE:** `http://localhost:3456/sse` — agents connect here for the event stream
- **Messages:** `http://localhost:3456/message` — agents POST JSON-RPC here
- **Health:** `http://localhost:3456/health` — liveness + tool list

---

## Phase 4 — Control Plane & Dashboard

The React dashboard (preview) is the human control layer over all agent activity.

### Dashboard tabs

| Tab | What it shows |
|-----|---------------|
| **Overview** | Live USDC balance, kill switch, spending gauges |
| **Activity** | Real-time tool-call log with filters (tool, status, client) and CSV/JSON export |
| **Clients** | Create, list, and revoke named agent integrations — each gets a one-time client key |
| **Grants** | Link a client to specific tools; set approval mode and optional tighter limits |
| **Setup** | Quick-start guide, copy-paste agent configs, tool reference |

### API endpoints (server/api.ts)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness + kill-switch state |
| GET | `/tool-log` | Last N log entries (filters: tool, status, clientId) |
| GET | `/limits` | Daily stats, allowlists, config snapshot |
| GET/POST | `/kill-switch` | Read or toggle the kill switch |
| GET/POST | `/clients` | List or create agent clients |
| DELETE | `/clients/:id` | Revoke a client |
| GET/POST | `/grants` | List or create grants |
| DELETE | `/grants/:id` | Revoke a grant |
| GET | `/export` | Download full log as JSON or CSV |

### Client + grant lifecycle

```
1. Human creates a client ("Research Bot") → gets one-time clientKey
2. Human creates a grant: clientId + tools + approvalMode + optional limits
3. Agent passes clientId on each tool call (optional — legacy callers pass through)
4. MCP server checks checkGrant(clientId, tool) before writes
5. Human revokes grant or client from dashboard → next request fails immediately
```

### Data files (project root)

- `agent-clients.json` — client registry
- `agent-grants.json` — grant registry
- `kill-switch.json` — persisted kill-switch state (survives server restart)
- `tool-calls.jsonl` — append-only audit log

## Phase 3 — x402 / Nanopayments

| Tool | Description |
|------|-------------|
| `discover_x402_services` | Search Circle's Agent Marketplace for x402-compatible services (read-only) |
| `pay_x402` | Pay an x402 endpoint using a Circle Agent Wallet — returns the response body |

### Guard stack for `pay_x402`

```
Kill switch → https:// URL check → X402_ALLOWED_ENDPOINTS prefix list →
X402_MAX_PRICE_USDC server ceiling → maxPriceUsdc per-call ceiling →
inspect actual price → per-call USDC cap → daily rolling limit →
operation binding → circle services pay (CLI)
```

Circle's wallet policy (Phase 1) enforces an additional cap at the network level on mainnet.

### Quick start

```bash
# In mcp/.env — tighten before use
X402_MAX_PRICE_USDC=0.10
X402_ALLOWED_ENDPOINTS=https://api.example.com,https://data.partner.io
PER_CALL_LIMIT_USDC=0.10    # also guards x402 payments
DAILY_LIMIT_USDC=1.00

# 1. Discover available services
discover_x402_services query="weather data"

# 2. Inspect price without paying
# (use circle services inspect <url> directly in CLI)

# 3. Pay and get the response
pay_x402 walletId="<your-agent-wallet-id>" endpoint="https://api.example.com/weather" maxPriceUsdc="0.01"

# 4. Check the log
tail -n5 tool-calls.jsonl | jq .binding.hash
```

### Example agent prompt

> "Find a data API on the Circle marketplace, pay for one call using my agent wallet (max 0.01 USDC), and summarise the result."

The agent will:
1. Call `discover_x402_services` to find listings
2. Call `pay_x402` on the chosen endpoint
3. Receive the response body and continue reasoning

## ERC-8183 Setup

Before using job write tools, add the contract and USDC addresses to your allowlists:

```bash
# In mcp/.env
ALLOWED_CONTRACTS=0x0747EEf0706327138c69792bF28Cd525089e4583,0x3600000000000000000000000000000000000000
ALLOWED_ADDRESSES=0x0747EEf0706327138c69792bF28Cd525089e4583,<your_wallet>,<provider_wallet>,<evaluator_wallet>
REQUIRE_ALLOWLIST=true
```

### End-to-end job lifecycle (testnet)

```bash
# 1. Client creates job
job_create provider=0xProvider evaluator=0xEval expiredAt=1800000000 description="Generate a market report"

# 2. Client sets budget
job_set_budget jobId=1 amount="5.0"

# 3. Client approves USDC then funds
job_approve_usdc amount="5.0"
job_fund jobId=1

# 4. Provider submits deliverable
job_submit jobId=1 deliverableHash="https://ipfs.io/ipfs/QmXxx..."

# 5. Evaluator completes
job_complete jobId=1 reason="Report meets requirements"

# 6. Check final state
job_get jobId=1
# → status: Completed, budget paid to provider
```

## Example Agent Prompts

### Core tools (all modes)

```
What's the USDC balance of 0x1234...abcd on Arc?
```
```
Transfer 5 USDC to 0xabcd...1234 on Arc.
```
```
Call the totalSupply() function on the contract at 0x3600...0000 on Arc.
```
```
What's the status of transaction 0xdeadbeef...?
```

### Phase 1: Agent Wallet flows

```
List my Circle Agent Wallets on Arc Testnet and show their USDC balances.
```
```
Create a new agent wallet on Arc Testnet.
```
```
What spending policies are set on my wallet 0xYourWalletAddress?
```
```
Set a spending policy on 0xYourWalletAddress: max 100 USDC per transaction, 500 USDC per day.
```
```
Transfer 2 USDC from my agent wallet 0xFrom... to 0xTo... on Arc Testnet.
```

### Example end-to-end agent flow (Phase 1)

1. Human runs `circle wallet login your@email.com --testnet` and completes OTP
2. Agent calls `list_agent_wallets` → gets wallet address
3. Human funds the wallet (faucet or `circle wallet fund`)
4. Agent calls `set_agent_policy` → Circle sends email OTP → human confirms
5. Agent calls `transfer_usdc_agent` → Phase 0 guards + Circle policy enforced → tx confirmed

---

## Arc Network Facts

| | Testnet | Mainnet |
|-|---------|---------|
| Chain ID | 5042002 | 5042 |
| RPC | `https://rpc.testnet.arc.io` | `https://rpc.mainnet.arc.io` |
| Explorer | `https://explorer.testnet.arc.io` | `https://explorer.arc.io` |
| USDC | `0x3600000000000000000000000000000000000000` | same |
| USDC decimals | 6 (ERC-20 view) | 6 |
| Native decimals | 18 (gas math only) | 18 |

On Arc, USDC IS the native gas token. The same pool of funds is exposed as both a 6-decimal ERC-20 and an 18-decimal native asset. The MCP server always uses the 6-decimal ERC-20 view for balances and amounts — never both at once.

---

## Phase 5 — Production Deployment

### HTTP Authentication

Set `API_AUTH_TOKEN` in `mcp/.env` to require a bearer token on all MCP HTTP requests. Generate a strong token:

```bash
openssl rand -hex 32
```

Agents must include the header:
```
Authorization: Bearer <API_AUTH_TOKEN>
```

The `/health` endpoint is always public. `/admin/*` routes use `ADMIN_AUTH_TOKEN` (falls back to `API_AUTH_TOKEN`).

### Rate Limiting

Per-IP sliding-window limits on all HTTP routes:

| Env var | Default | Route scope |
|---------|---------|-------------|
| `RATE_LIMIT_MAX` | 60 req/min | All routes |
| `RATE_LIMIT_WRITE_MAX` | 20 req/min | `/sse`, `/message` |
| `RATE_LIMIT_WINDOW_MS` | 60000 ms | Both |

Responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `Retry-After` headers.

### New Phase 5 Tools

| Tool | Description |
|------|-------------|
| `get_system_status` | Snapshot of network, kill-switch, daily spend, policy config, version |
| `export_audit_log` | Filtered audit log slice — time range, tool, client, status, JSON or CSV |

### Production Network Architecture

```
Agent ─── HTTPS ──► nginx/Caddy (TLS) ──► Arc MCP Server :3456
                                              │
Dashboard ◄── Vite proxy ──► Dashboard API :3001
```

Never expose port 3456 or 3001 directly to the internet without TLS and authentication.

### Mainnet Readiness

Review and complete the checklist in [docs/MAINNET.md](../docs/MAINNET.md) before switching to `ARC_NETWORK=mainnet`. Key requirements:

- All allowlists populated and tested
- Circle Agent Wallet policies set and verified
- API_AUTH_TOKEN and ADMIN_AUTH_TOKEN set
- Rate limiting tuned for expected agent volume
- Incident response runbook reviewed

The server emits a startup warning when `ARC_NETWORK=mainnet`. This warning cannot be suppressed.

---

## Security Notes

- Never commit `.env` or `recovery_file.dat` to version control
- The `ALLOWED_ADDRESSES` allowlist is the strongest transfer guardrail — set it for production
- Use `unsigned` mode until you have confirmed the agent's behaviour in testing
- Arc Testnet moves test USDC; Arc Mainnet moves real USDC — double-check `ARC_NETWORK`
- The entity secret recovery file must be stored offline; losing it means permanent loss of wallet access
- Set `API_AUTH_TOKEN` for any deployment reachable over a network — the unauthenticated HTTP endpoint is dev-only
- Review [docs/MAINNET.md](../docs/MAINNET.md) for the complete incident response runbook
