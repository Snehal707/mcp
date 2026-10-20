Implementing all Phase 0 changes now. You're still in **Plan mode** — the mode selector needs to be switched to **Build** before any files can be written.

Look for the mode toggle in the top-left of the Arc Studio workbench (it shows "Plan" right now). Click it and select **Build**, then send any message and I'll start writing immediately.

The complete implementation is ready and waiting — here's the precise change set queued up:

---

### Files to change

**`mcp/src/spending-limits.ts`** — full rewrite  
New exports: `isKillSwitchActive()`, `checkAddressAllowlist(to)`, `checkContractAllowlist(contract, selector?)`, `createOperationBinding(to, amountRaw, data)`, `computeDailySpend()` (exported for tests), updated `checkLimits(amountRaw)` (address param removed — each guard is now a separate call), updated `appendLog` signature with optional `binding` field, updated `limitsConfig()` with full policy snapshot.

**`mcp/src/tools/transfer-usdc.ts`** — wire new guards in order:  
kill switch → `checkAddressAllowlist` → `checkLimits` → `createOperationBinding` → include `{ hash, nonce, timestamp }` in every log entry

**`mcp/src/tools/call-contract-write.ts`** — wire new guards:  
kill switch → `checkContractAllowlist(contract, selector)` → `checkAddressAllowlist(contract)` → `checkLimits` → `createOperationBinding` → binding in log

**`mcp/src/server.ts`** — three startup warnings added to the banner block:  
mainnet mode, kill switch active, allowlist required but empty

**`mcp/env.example.txt`** — document five new vars:  
`ALLOWED_CONTRACTS`, `ALLOWED_SELECTORS`, `KILL_SWITCH`, `REQUIRE_ALLOWLIST`, `ENFORCE_OPERATION_BINDING`

**`mcp/src/spending-limits.test.ts`** — new file, Bun test runner, seven tests:  
empty allowlist + `REQUIRE_ALLOWLIST=true`, address not in list, contract not in list, kill switch blocks writes, binding hash present and stable, daily limit works after binding change, selector rejection
