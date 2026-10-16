# Arc MCP Server

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

An MCP (Model Context Protocol) server that exposes Arc blockchain tools to AI agents (Claude, ChatGPT, Cursor). Agents can check USDC balances, transfer USDC, and call smart contracts on Arc Testnet, with Circle Developer-Controlled Wallets for autonomous flows and an unsigned-transaction mode for human-in-the-loop approval. All state-changing tools are guarded by per-call caps, daily rolling limits, and an address allowlist.

## MCP Server (mcp/)

- Entry: `mcp/src/server.ts` — dual stdio + HTTP/SSE transports
- Tools: `mcp/src/tools/` (5 tools)
- Spending limits: `mcp/src/spending-limits.ts`
- Circle wallet adapter: `mcp/src/circle-wallet.ts`
- Unsigned tx builder: `mcp/src/unsigned-tx.ts`
- Arc chain config: `mcp/src/arc-chain.ts`
- Config: `mcp/env.example.txt` (copy to `mcp/.env`)
- Build: `cd mcp && bun install && bun run build`
- Start stdio: `MCP_TRANSPORT=stdio node dist/server.js`
- Start HTTP: `MCP_TRANSPORT=http MCP_PORT=3456 node dist/server.js`

## Dashboard Backend (server/api.ts)

- Serves `/health`, `/tool-log`, `/limits` for the React dashboard
- Start: `bun run server` (proxied via Vite at `/api/*`)
- Tool call log written to `tool-calls.jsonl` (root of app)

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002, imported from `viem/chains`)
- Token: USDC (6 decimals) (Address: 0x3600000000000000000000000000000000000000, Chain: Arc Testnet)
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)

## To Run

```bash
bun install
bun run dev
```
