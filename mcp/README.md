# Arc MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that exposes Arc blockchain tools to AI agents — Claude, ChatGPT, Cursor, and any other MCP-compatible host.

## Tools

| Tool | Description |
|------|-------------|
| `get_usdc_balance` | Read USDC balance (6-decimal ERC-20) for any Arc address |
| `transfer_usdc` | Send USDC with per-call cap, daily limit, and address allowlist |
| `call_contract_read` | Execute view/pure functions on any Arc contract |
| `call_contract_write` | Execute state-changing contract calls with spending guards |
| `get_transaction_status` | Check tx confirmation via Arc RPC or Circle API |

## Safety Model

No private keys are stored on this server.

**`unsigned` mode (default):** The server builds a complete, ready-to-sign transaction and returns it as JSON. A human signs it with MetaMask, Frame, Rainbow, or `cast`. Zero key material on the server.

**`circle` mode:** Transactions are signed via [Circle Developer-Controlled Wallets](https://developers.circle.com/wallets/developer-controlled). Your encrypted entity secret authorises signing; Circle's infrastructure holds the actual key shards. Private keys never appear in plaintext on your server.

Three spending-limit guardrails apply to every `transfer_usdc` and `call_contract_write`:
1. **Per-call cap** — rejects any single transfer above `PER_CALL_LIMIT_USDC`
2. **Daily rolling limit** — blocks when the 24-hour cumulative total exceeds `DAILY_LIMIT_USDC`
3. **Address allowlist** — rejects transfers to any address not in `ALLOWED_ADDRESSES`

## Setup

### 1. Configure environment

```bash
cp env.example.txt .env
# Edit .env with your settings
```

Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_MODE` | `unsigned` | `unsigned` (safe default) or `circle` (Circle wallets) |
| `MCP_TRANSPORT` | `both` | `stdio`, `http`, or `both` |
| `PER_CALL_LIMIT_USDC` | `10` | Max USDC per single call |
| `DAILY_LIMIT_USDC` | `100` | Max USDC per rolling 24-hour window |
| `ALLOWED_ADDRESSES` | _(any)_ | Comma-separated allowlist, leave blank to allow all |
| `ARC_NETWORK` | `testnet` | `testnet` or `mainnet` |

For `circle` mode, also set:
- `CIRCLE_API_KEY` — from [console.circle.com](https://console.circle.com)
- `ENTITY_SECRET` — [register here](https://developers.circle.com/wallets/dev-controlled/register-entity-secret)
- `CIRCLE_WALLET_ID` — the agent wallet ID (create via Circle API)

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

## Example Agent Prompts

Once connected, agents can use natural language:

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

## Security Notes

- Never commit `.env` or `recovery_file.dat` to version control
- The `ALLOWED_ADDRESSES` allowlist is the strongest transfer guardrail — set it for production
- Use `unsigned` mode until you have confirmed the agent's behaviour in testing
- Arc Testnet moves test USDC; Arc Mainnet moves real USDC — double-check `ARC_NETWORK`
- The entity secret recovery file must be stored offline; losing it means permanent loss of wallet access
