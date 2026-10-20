# Arc MCP Server — Mainnet Readiness & Incident Response

> **This document must be reviewed and signed off before any real USDC is moved.**
> Transactions on mainnet are irreversible. Arc Studio may help you build and test,
> but all mainnet operations are your responsibility.

---

## Mainnet Readiness Checklist

Complete every item before switching `ARC_NETWORK=mainnet`.

### Phase 0 — Server-side guards
- [ ] Kill switch tested: set `KILL_SWITCH=true`, confirm all write tools return an error immediately
- [ ] Kill switch reachable from dashboard (Phase 4 UI toggle) and via `POST /kill-switch`
- [ ] `ALLOWED_ADDRESSES` populated with only production recipient addresses (no test wallets)
- [ ] `ALLOWED_CONTRACTS` populated with only audited, production contract addresses
- [ ] `ALLOWED_SELECTORS` set to the minimum required function selectors (optional but recommended)
- [ ] `PER_CALL_LIMIT_USDC` set to the lowest value consistent with your use case
- [ ] `DAILY_LIMIT_USDC` set conservatively (start 10× below expected daily volume)
- [ ] `ENFORCE_OPERATION_BINDING=true` (default — do not disable on mainnet)
- [ ] `REQUIRE_ALLOWLIST=true` (default — do not disable on mainnet)

### Phase 1 — Circle Agent Wallet policies
- [ ] Mainnet Agent Wallet created and funded with a small amount for initial testing
- [ ] Spending policies set via `set_agent_policy` (requires OTP — do this before agents run)
- [ ] Policy verified with `get_agent_policy` — confirm per-tx cap, daily/weekly limits
- [ ] Circle CLI session renewed (`circle wallet login`) — sessions expire after 28 days
- [ ] Testnet wallet and mainnet wallet are distinct — never reuse testnet wallet IDs on mainnet

### Phase 3 — x402 / Nanopayments
- [ ] `X402_MAX_PRICE_USDC` set to your maximum acceptable single payment
- [ ] `X402_ALLOWED_ENDPOINTS` populated with the exact service URL prefixes you trust
- [ ] Wallet x402Cap policy confirmed on mainnet

### Phase 4 — Human control plane
- [ ] At least one Agent Client created for each agent/integration that will run on mainnet
- [ ] Each client has a Grant limited to the exact tools it needs (principle of least privilege)
- [ ] Approval mode reviewed: prefer `above_limit` over `autonomous` for high-value tools
- [ ] Client/grant revocation tested in a staging run — confirmed it stops writes immediately

### Phase 5 — Transport hardening
- [ ] `API_AUTH_TOKEN` set to a strong random value (`openssl rand -hex 32`)
- [ ] `ADMIN_AUTH_TOKEN` set separately from API_AUTH_TOKEN
- [ ] `DASHBOARD_API_TOKEN` set for the dashboard API server
- [ ] `RATE_LIMIT_MAX` and `RATE_LIMIT_WRITE_MAX` tuned for expected agent call volume
- [ ] MCP server not exposed on a public IP without a reverse proxy (nginx/Caddy) and TLS
- [ ] stdio transport disabled or restricted in production (`MCP_TRANSPORT=http`)
- [ ] No secrets in git history, environment logs, or container image layers

### Final verification
- [ ] Testnet end-to-end: transfer + job (create → fund → submit → complete) + x402 all pass
- [ ] `get_system_status` returns correct network, policy, and kill-switch state
- [ ] Audit log export (`export_audit_log`) produces a bounded JSON/CSV file
- [ ] Recovery runbook reviewed (see below)
- [ ] Incident response checklist reviewed (see below)

---

## Configuration for Mainnet

```bash
# mcp/.env — mainnet settings (never commit this file)

ARC_NETWORK=mainnet
AGENT_MODE=circle_agent         # or "unsigned" for human-signed flows

# Hardened limits (tighten after initial testing)
PER_CALL_LIMIT_USDC=50
DAILY_LIMIT_USDC=500

# Allowlists (must be non-empty on mainnet)
ALLOWED_ADDRESSES=0xYourRecipient1,0xYourRecipient2
ALLOWED_CONTRACTS=0xYourContract1

# Kill switch (off by default, toggle from dashboard)
KILL_SWITCH=false

# Phase 5: authentication
API_AUTH_TOKEN=<openssl rand -hex 32>
ADMIN_AUTH_TOKEN=<openssl rand -hex 32>
RATE_LIMIT_MAX=30
RATE_LIMIT_WRITE_MAX=10
RATE_LIMIT_WINDOW_MS=60000

# Phase 3: x402 (tightest possible ceiling)
X402_MAX_PRICE_USDC=0.10
X402_ALLOWED_ENDPOINTS=https://api.yourservice.com

# Phase 4: data directory (use a persistent volume in production)
CLIENTS_DATA_DIR=/var/arc-mcp/data
TOOL_LOG_PATH=/var/arc-mcp/data/tool-calls.jsonl

# Dashboard API
DASHBOARD_API_TOKEN=<openssl rand -hex 32>
```

---

## Wallet and Key Management

### Circle Agent Wallets (recommended)
- Keys are held by Circle's 2-of-2 MPC infrastructure — no private key ever touches your server.
- Each wallet is tied to your Circle account's email via OTP. Rotate login sessions every 28 days.
- **Recovery**: if you lose access to your Circle account email, follow Circle's account recovery process at https://app.circle.com. Agent Wallets cannot be self-recovered — Circle support is required.
- **Backup**: export your wallet list with `circle wallet list --output json > wallet-backup.json` before every major change.

### Developer-Controlled Wallets (AGENT_MODE=circle)
- Entity secret encrypted via Circle's public key. The recovery file at `.circle/recovery_file.dat` is the **only** way to re-register a new entity secret if your current one is lost.
- Store the recovery file in a separate, offline location (encrypted USB, hardware security module, or printed and stored in a safe).
- **Never** share the entity secret or recovery file over chat, email, or any networked service.
- Rotate the entity secret and re-register if you suspect it was exposed.

### Unsigned mode (AGENT_MODE=unsigned)
- The server holds no keys. Transactions are assembled and returned unsigned.
- Agents cannot move funds without human signing in MetaMask, Frame, or `cast`.
- Use this mode for human-in-the-loop approval of all mainnet writes.

---

## Recovery Procedures

### Kill switch
```bash
# Via dashboard: toggle the kill switch on the Overview tab.

# Via API (requires ADMIN_AUTH_TOKEN or API_AUTH_TOKEN):
curl -X POST http://localhost:3001/kill-switch \
  -H "Authorization: Bearer $ADMIN_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"active": true}'

# Via env var (requires server restart):
echo "KILL_SWITCH=true" >> mcp/.env
pkill -f arc-mcp-server && bun run mcp/src/server.ts
```

**Effect**: all write tools (`transfer_usdc`, `call_contract_write`, `transfer_usdc_agent`,
`pay_x402`, all job write tools) return an error on the next request. No in-flight
transaction is cancelled — only future requests are blocked.

### Revoking a client
```bash
# Via dashboard: Clients tab → Revoke.

# Via API:
curl -X DELETE http://localhost:3001/clients/<clientId> \
  -H "Authorization: Bearer $DASHBOARD_API_TOKEN"
```

Effect: the client's `clientId` is marked revoked in `agent-clients.json`. All subsequent
`checkGrant(clientId, tool)` calls return false, blocking all write tools for that client.

### Revoking a grant
```bash
curl -X DELETE http://localhost:3001/grants/<grantId> \
  -H "Authorization: Bearer $DASHBOARD_API_TOKEN"
```

### Reducing limits without restart
`PER_CALL_LIMIT_USDC` and `DAILY_LIMIT_USDC` are read from `process.env` on every call.
Update them in `mcp/.env` and restart the MCP server to pick up the new values.
The dashboard API server reads limits the same way.

### Restoring from backup
```bash
# Restore spend log
cp /backup/tool-calls.jsonl /var/arc-mcp/data/tool-calls.jsonl

# Restore client/grant registry
cp /backup/agent-clients.json /var/arc-mcp/data/agent-clients.json
cp /backup/agent-grants.json  /var/arc-mcp/data/agent-grants.json
```

---

## Incident Response Checklist

Use this checklist when you observe unexpected transactions, policy violations, or
anomalous agent behaviour.

### Step 1 — Contain (do immediately)
- [ ] **Activate kill switch** (dashboard or `curl -X POST /kill-switch -d '{"active":true}'`)
- [ ] **Revoke the suspected client** (dashboard Clients tab or `DELETE /clients/<id>`)
- [ ] If a Circle Agent Wallet is compromised, contact Circle support to freeze the wallet

### Step 2 — Assess
- [ ] Export the audit log: `GET /export?format=json` or use `export_audit_log` MCP tool
- [ ] Filter by the suspected client: `GET /tool-log?clientId=<id>&status=completed`
- [ ] Identify the first anomalous entry — note timestamp, tool, `to` address, `amountUsdc`
- [ ] Check `binding.hash` in each suspicious entry — a missing hash means the entry was
      written by a pre-Phase-0 server version or a log injection attempt
- [ ] Verify on the Arc Testnet/Mainnet explorer: https://explorer.arc.io

### Step 3 — Investigate
- [ ] Which agent initiated the calls (clientId, grant tool list)?
- [ ] Was the allowlist bypassed? (Check `ALLOWED_ADDRESSES` and `REQUIRE_ALLOWLIST`)
- [ ] Did the daily limit fail to stop the flow? (Check `binding.hash` on all entries within window)
- [ ] Was a Phase 1 wallet policy violated? Run `get_agent_policy` to confirm current limits.

### Step 4 — Communicate
- [ ] If real USDC was moved unexpectedly: notify your Circle account manager
- [ ] If Circle infrastructure was involved: file a support ticket at https://support.circle.com
- [ ] Document the incident timeline and root cause

### Step 5 — Restore
- [ ] Fix the root cause (tighten limits, remove compromised client, patch code)
- [ ] Test the fix on testnet
- [ ] Deactivate kill switch only after root cause is resolved
- [ ] Re-create a new client key for legitimate agents (old key is revoked)
- [ ] Update allowlists if recipients were added without approval

---

## Backup Strategy

| What | Where | Frequency |
|------|-------|-----------|
| `tool-calls.jsonl` | `/var/arc-mcp/data/` → offsite | Daily (cron or log-shipper) |
| `agent-clients.json` + `agent-grants.json` | same | On every change |
| `kill-switch.json` | same | On every change |
| `.circle/recovery_file.dat` | Encrypted offline storage | Once (never changes) |
| Entity secret value | Hardware security module or encrypted vault | Once (never changes) |
| `mcp/.env` (without secrets) | Git (redact secrets before commit) | On every config change |

---

## Network Architecture (Production)

```
Agent (Claude / Cursor / ChatGPT)
      │
      │  HTTPS  (TLS terminated by reverse proxy)
      ▼
[nginx / Caddy]  ─── TLS cert from Let's Encrypt
      │
      │  Authorization: Bearer $API_AUTH_TOKEN
      ▼
[Arc MCP Server]  :3456  (MCP_TRANSPORT=http)
      │                │
      │                └── /admin/*  (ADMIN_AUTH_TOKEN)
      │
      ▼
[Dashboard API]  :3001  (DASHBOARD_API_TOKEN)
      ▲
      │
[React Dashboard]  (proxied via Vite / served as static build)
```

**Do not** expose port 3456 or 3001 directly on a public IP without TLS and authentication.

---

## Mainnet Explorer Links

- Arc Mainnet explorer: https://explorer.arc.io
- Arc Testnet explorer: https://testnet.explorer.arc.io
- USDC contract (mainnet): `0x3600000000000000000000000000000000000000`
- USDC contract (testnet): `0x3600000000000000000000000000000000000000`
- AgenticCommerce contract: `0x0747EEf0706327138c69792bF28Cd525089e4583`
