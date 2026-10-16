The user's plan answers are already in the turn context. Let me read the relevant skills and workspace files to generate the plan. Good. Now I have everything I need. Let me generate the plan.

---

## Implementation Plan: Arc MCP Server

### Summary
A TypeScript MCP (Model Context Protocol) server that exposes Arc blockchain tools to AI agents (Claude, ChatGPT, Cursor). Agents can check USDC balances, transfer USDC, and call smart contracts on Arc Testnet, with Circle Developer-Controlled Wallets for autonomous flows and an unsigned-transaction mode for human-in-the-loop approval — both guarded by per-call caps, daily rolling limits, and an address allowlist.

### Architecture

- **Blockchain:** Arc Testnet (chain ID 5042002). USDC is the native gas token — no separate ETH needed for fees. Sub-second finality makes it ideal for agent workflows.
- **Contract:** No custom contract deployed. The server interacts with the USDC ERC-20 predeploy at `0x3600000000000000000000000000000000000000` and with arbitrary user-supplied contract ABIs.
- **Frontend:** A React + Tailwind management dashboard in the existing Vite app. Shows wallet address, USDC balance, spending-limit config, recent agent calls, and a log of all tool invocations.
- **MCP Server:** A standalone Node/TypeScript process (`mcp/`) using the `@modelcontextprotocol/sdk` package. Dual transport: stdio (for local Claude Desktop / Cursor) and HTTP + SSE (for remote agents via a `/sse` endpoint).
- **Wallet:** Two modes controlled by the `AGENT_MODE` env var:
  - `circle` — Circle Developer-Controlled Wallets SDK. The server holds an encrypted entity secret; Circle's API executes transactions. Private keys never touch the server.
  - `unsigned` — The server builds a viem transaction object and returns it unsigned. The human operator pastes it into their wallet (MetaMask, Frame, etc.) to sign. No key material on server at all.

### Files to Create / Modify

**MCP server package**
1. `mcp/package.json` — MCP server dependencies: `@modelcontextprotocol/sdk`, `@circle-fin/developer-controlled-wallets`, `viem`, `zod`, `express`, `uuid`.
2. `mcp/tsconfig.json` — TypeScript config for the server package.
3. `mcp/src/arc-chain.ts` — Arc Testnet chain config for viem (`createPublicClient`, RPC URL, USDC address).
4. `mcp/src/spending-limits.ts` — In-memory (and file-persisted) spending-limit engine: per-call cap, daily rolling total, address allowlist. Exports `checkLimits(to, amountUsdc)` that throws a structured error on violation.
5. `mcp/src/circle-wallet.ts` — Circle Developer-Controlled Wallets adapter: initialises SDK from env, exposes `sendUsdc(to, amountRaw)` and `executeContract(address, abi, fn, args, value)`. Polls via `getTransaction` until terminal state.
6. `mcp/src/unsigned-tx.ts` — Unsigned-tx builder: uses viem `encodeFunctionData` to assemble a ready-to-sign tx object returned as JSON. No signing, no keys.
7. `mcp/src/tools/get-usdc-balance.ts` — MCP tool: accepts `address` (defaults to agent wallet address), returns formatted USDC balance read via viem `publicClient.readContract`.
8. `mcp/src/tools/transfer-usdc.ts` — MCP tool: validates inputs, runs `checkLimits`, dispatches via `circle-wallet` or `unsigned-tx` depending on `AGENT_MODE`. Returns tx hash or unsigned tx object.
9. `mcp/src/tools/call-contract-read.ts` — MCP tool: accepts `contractAddress`, `abi` (JSON string), `functionName`, `args`. Executes a view call via `publicClient.readContract`. No spending-limit check needed.
10. `mcp/src/tools/call-contract-write.ts` — MCP tool: same inputs plus optional `valueUsdc`. Runs `checkLimits` on value, dispatches via `circle-wallet` or `unsigned-tx`.
11. `mcp/src/tools/get-transaction-status.ts` — MCP tool: accepts a tx hash, calls the Arc Testnet RPC via viem for receipt status and block number; for Circle-mode tx IDs also calls the Circle SDK.
12. `mcp/src/server.ts` — Registers all five tools with `McpServer`, wires stdio transport and HTTP/SSE transport (Express). Reads `MCP_TRANSPORT=stdio|http|both` env var.
13. `mcp/.env.example` — Documents all required env vars with no real values: `CIRCLE_API_KEY`, `ENTITY_SECRET`, `AGENT_MODE`, `MCP_TRANSPORT`, `PER_CALL_LIMIT_USDC`, `DAILY_LIMIT_USDC`, `ALLOWED_ADDRESSES`, `MCP_PORT`.
14. `mcp/README.md` — Setup guide: entity secret registration link, Claude Desktop config snippet, Cursor MCP config snippet, ChatGPT plugin config snippet, faucet link.

**Frontend dashboard (existing Vite app)**
15. `src/App.tsx` — Replace stub with the dashboard: wallet address display, live USDC balance, spending-limit status (used today / daily cap), recent tool-call log (read from a shared JSON log file the MCP server appends to), and a "Configure Limits" panel.
16. `src/components/SpendingLimitsPanel.tsx` — Form to view and update `PER_CALL_LIMIT_USDC`, `DAILY_LIMIT_USDC`, and `ALLOWED_ADDRESSES`. Writes to `.env` via a local dev API endpoint (dev-only; not exposed in production).
17. `src/components/ToolCallLog.tsx` — Table of recent MCP tool calls: timestamp, tool name, caller agent, amount, status (approved / blocked / pending).
18. `src/components/WalletInfo.tsx` — Shows agent wallet address, USDC balance (live via wagmi `useReadContract`), and a link to the Arc Testnet Explorer.

### Build Sequence

1. **Scaffold MCP package** — Create `mcp/package.json`, `mcp/tsconfig.json`, `mcp/.env.example`. Install dependencies.
2. **Arc chain config + USDC client** — Write `mcp/src/arc-chain.ts` with viem `publicClient` pointed at Arc Testnet RPC.
3. **Spending-limit engine** — Write `mcp/src/spending-limits.ts` with all three guardrails. Unit-test the per-call and daily-limit logic.
4. **Circle wallet adapter** — Write `mcp/src/circle-wallet.ts` (SDK init, `sendUsdc`, `executeContract`, tx status polling via `onchain-wait` patterns).
5. **Unsigned-tx builder** — Write `mcp/src/unsigned-tx.ts`.
6. **Five MCP tools** — Write each tool file, wiring inputs through Zod schemas, spending-limit checks, and the appropriate wallet adapter.
7. **MCP server entry point** — Write `mcp/src/server.ts` with dual stdio + HTTP/SSE transports. Confirm `npx ts-node mcp/src/server.ts` starts without error.
8. **Frontend dashboard** — Build `WalletInfo`, `ToolCallLog`, `SpendingLimitsPanel`, and wire into `src/App.tsx`. Connect wagmi to Arc Testnet for live balance reads.
9. **MCP README** — Write setup and Claude Desktop / Cursor / ChatGPT config snippets.

### Done When

- [ ] `get_usdc_balance` returns the correct 6-decimal USDC balance for a given Arc Testnet address
- [ ] `transfer_usdc` in `circle` mode completes and returns a tx hash; in `unsigned` mode returns a valid unsigned tx object
- [ ] `transfer_usdc` is blocked (structured error) when the amount exceeds `PER_CALL_LIMIT_USDC`, when the daily total is exceeded, and when the recipient is not in `ALLOWED_ADDRESSES`
- [ ] `call_contract_read` executes a view function and returns decoded results
- [ ] `call_contract_write` dispatches correctly in both `circle` and `unsigned` modes with spending-limit guards
- [ ] `get_transaction_status` returns confirmation status for a tx hash
- [ ] MCP server starts in stdio mode and can be configured in Claude Desktop's `mcpServers` block
- [ ] MCP server starts in HTTP mode with a `/sse` endpoint reachable over the network
- [ ] No private keys or entity secrets appear in any log, response payload, or committed file
- [ ] Dashboard shows live USDC balance, spending-limit usage, and tool-call log

---

Ready to build? Approve this plan and switch to Build mode to start. Plan saved to `arc-studio-plans/PLAN.md`.

Here's what this will build and why each decision was made:

**Two wallet modes, zero stored keys.** `circle` mode uses Circle's Developer-Controlled Wallets API — the entity secret is encrypted, Circle's infrastructure handles signing, and private key material never exists on your server process. `unsigned` mode goes further: the server only assembles the transaction bytes and returns them; a human pastes them into MetaMask or Frame to sign. No secrets, no custody.

**Three-layer spending guardrails.** Every `transfer_usdc` and `call_contract_write` call runs through `spending-limits.ts` before touching any wallet:
- Per-call ceiling: rejects a single oversized transfer immediately
- Daily rolling total: accumulates across all agent calls and blocks when the day's budget is spent
- Address allowlist: hard-rejects any recipient not explicitly pre-approved

All three are configurable via env vars so you can tighten or loosen them without a code change.

**Dual transport.** The same tool registry is exposed over stdio (for Claude Desktop and Cursor — just point their `mcpServers` config at the process) and over HTTP + SSE (for remote agents or ChatGPT plugins that need a URL).

**Five tools, Arc-native.** `get_usdc_balance` reads the USDC ERC-20 predeploy directly (6-decimal view, never the native 18-decimal view). `call_contract_read` and `call_contract_write` accept arbitrary ABIs so agents can interact with any deployed contract on Arc. `get_transaction_status` works for both raw tx hashes and Circle SDK transaction IDs.

Switch to Build mode to start.
