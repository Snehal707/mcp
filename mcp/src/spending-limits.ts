/**
 * Spending-limit engine — Phase 0 hardened.
 *
 * Guards applied before every transfer_usdc or call_contract_write:
 *
 *   1. Kill switch         — KILL_SWITCH=true blocks all writes immediately
 *   2. Per-call cap        — reject single transfer above PER_CALL_LIMIT_USDC
 *   3. Daily rolling total — cumulative 24-hour spend; persisted via log scan
 *   4. Address allowlist   — REQUIRE_ALLOWLIST=true (default) makes empty list a hard reject
 *   5. Contract allowlist  — ALLOWED_CONTRACTS required for all contract writes
 *   6. Selector allowlist  — optional ALLOWED_SELECTORS restricts to specific 4-byte selectors
 *   7. Operation binding   — keccak256 payload hash stamped on every write log entry
 *
 * Daily-limit integrity: when ENFORCE_OPERATION_BINDING=true (default), only log
 * entries that carry a binding.hash count toward the rolling total. Entries written
 * by an older server version (no hash) are counted conservatively.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { keccak256, toBytes } from 'viem';
import { parseUsdc, formatUsdc } from './arc-chain.js';

// ── Config helpers ────────────────────────────────────────────────────────────

function envUsdc(name: string, defaultHuman: string): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return parseUsdc(defaultHuman);
  return parseUsdc(raw);
}

/** Parse a comma-separated list of 0x addresses into a lowercase string array. */
export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
}

/** Parse a comma-separated list of 4-byte selectors (0x + 8 hex chars). */
function parseSelectors(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{8}$/.test(s));
}

// Lazily evaluated per call so that process.env changes (e.g. in tests) take effect.
function getPerCallLimit(): bigint { return envUsdc('PER_CALL_LIMIT_USDC', '10'); }
function getDailyLimit(): bigint   { return envUsdc('DAILY_LIMIT_USDC', '100'); }

// ── Structured error ──────────────────────────────────────────────────────────

export class SpendingLimitError extends Error {
  constructor(
    public readonly code:
      | 'KILL_SWITCH_ACTIVE'
      | 'PER_CALL_EXCEEDED'
      | 'DAILY_LIMIT_EXCEEDED'
      | 'ADDRESS_NOT_ALLOWED'
      | 'CONTRACT_NOT_ALLOWED'
      | 'SELECTOR_NOT_ALLOWED'
      | 'ALLOWLIST_REQUIRED_EMPTY',
    message: string,
  ) {
    super(message);
    this.name = 'SpendingLimitError';
  }
}

// ── Kill switch ───────────────────────────────────────────────────────────────

/** Returns true when KILL_SWITCH=true — all write tools must check this first. */
export function isKillSwitchActive(): boolean {
  return process.env.KILL_SWITCH === 'true';
}

// ── Address allowlist ─────────────────────────────────────────────────────────

/**
 * Check that `to` is in the ALLOWED_ADDRESSES list.
 *
 * Behaviour:
 *   - REQUIRE_ALLOWLIST=true (default): an empty list is a hard reject.
 *   - REQUIRE_ALLOWLIST=false: an empty list means "allow any address".
 *   - Non-empty list: `to` must be present regardless of REQUIRE_ALLOWLIST.
 */
export function checkAddressAllowlist(to: string): void {
  const requireAllowlist = process.env.REQUIRE_ALLOWLIST !== 'false';
  const list = parseAllowlist(process.env.ALLOWED_ADDRESSES);

  if (requireAllowlist && list.length === 0) {
    throw new SpendingLimitError(
      'ALLOWLIST_REQUIRED_EMPTY',
      'REQUIRE_ALLOWLIST=true but ALLOWED_ADDRESSES is empty. ' +
        'Add recipient addresses to ALLOWED_ADDRESSES in .env, or set REQUIRE_ALLOWLIST=false to allow any address.',
    );
  }

  if (list.length > 0 && !list.includes(to.toLowerCase())) {
    throw new SpendingLimitError(
      'ADDRESS_NOT_ALLOWED',
      `Recipient ${to} is not in the ALLOWED_ADDRESSES list. ` +
        `Add it to ALLOWED_ADDRESSES in .env to permit transfers to this address.`,
    );
  }
}

// ── Contract + selector allowlist ────────────────────────────────────────────

/**
 * Check that `contract` is in ALLOWED_CONTRACTS and, if ALLOWED_SELECTORS is
 * set, that `selector` (0x + 8 hex chars) is also permitted.
 *
 * An empty ALLOWED_CONTRACTS list is always a hard reject for contract writes.
 */
export function checkContractAllowlist(contract: string, selector?: string): void {
  const contracts = parseAllowlist(process.env.ALLOWED_CONTRACTS);

  if (contracts.length === 0) {
    throw new SpendingLimitError(
      'CONTRACT_NOT_ALLOWED',
      'ALLOWED_CONTRACTS is empty. ' +
        'Add the target contract address to ALLOWED_CONTRACTS in .env before calling contract write tools.',
    );
  }

  if (!contracts.includes(contract.toLowerCase())) {
    throw new SpendingLimitError(
      'CONTRACT_NOT_ALLOWED',
      `Contract ${contract} is not in the ALLOWED_CONTRACTS list. ` +
        `Add it to ALLOWED_CONTRACTS in .env to permit calls to this contract.`,
    );
  }

  const allowedSelectors = parseSelectors(process.env.ALLOWED_SELECTORS);
  if (allowedSelectors.length > 0 && selector) {
    const sel = selector.toLowerCase().slice(0, 10); // ensure 0x + 8 hex
    if (!allowedSelectors.includes(sel)) {
      throw new SpendingLimitError(
        'SELECTOR_NOT_ALLOWED',
        `Function selector ${selector} is not in the ALLOWED_SELECTORS list. ` +
          `Add it to ALLOWED_SELECTORS in .env to permit this specific function call.`,
      );
    }
  }
}

// ── Operation binding ─────────────────────────────────────────────────────────

export interface OperationBinding {
  to: string;
  amountRaw: string;
  data: string;
  nonce: string;
  timestamp: number;
  /** keccak256 of "to|amountRaw|data|nonce|timestamp" */
  hash: string;
}

/**
 * Create a tamper-evident binding for a write operation.
 * The hash commits to the exact payload so the log entry can be audited.
 */
export function createOperationBinding(
  to: string,
  amountRaw: bigint,
  data: string,
): OperationBinding {
  const nonce = randomUUID();
  const timestamp = Date.now();
  const payload = `${to.toLowerCase()}|${amountRaw.toString()}|${data}|${nonce}|${timestamp}`;
  const hash = keccak256(toBytes(payload));
  return {
    to: to.toLowerCase(),
    amountRaw: amountRaw.toString(),
    data,
    nonce,
    timestamp,
    hash,
  };
}

// ── Log record types ──────────────────────────────────────────────────────────

export interface LogRecord {
  timestamp: string; // ISO-8601
  tool: string;
  amountUsdc?: string; // human-readable, present on transfer/write tools
  status: 'approved' | 'blocked' | 'completed' | 'failed';
  binding?: OperationBinding;
  [key: string]: unknown;
}

export function logPath(): string {
  return process.env.TOOL_LOG_PATH ?? '../tool-calls.jsonl';
}

// ── Daily rolling total ───────────────────────────────────────────────────────

/**
 * Sum USDC spent in the last 24 hours from the persisted log.
 *
 * When ENFORCE_OPERATION_BINDING=true (default):
 *   - Entries WITH a binding.hash count normally.
 *   - Entries WITHOUT a binding.hash (written by an older server) are counted
 *     conservatively (included) so they cannot be used to bypass the daily cap.
 */
export function computeDailySpend(): bigint {
  const path = logPath();
  if (!fs.existsSync(path)) return 0n;

  const enforceBinding = process.env.ENFORCE_OPERATION_BINDING !== 'false';
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let total = 0n;

  const raw = fs.readFileSync(path, 'utf-8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as LogRecord;
      if (rec.status !== 'completed') continue;
      if (!rec.amountUsdc) continue;
      if (new Date(rec.timestamp).getTime() < cutoff) continue;

      if (enforceBinding && rec.binding === undefined) {
        // Legacy entry without binding — count conservatively
        total += parseUsdc(rec.amountUsdc);
        continue;
      }

      total += parseUsdc(rec.amountUsdc);
    } catch {
      // skip malformed lines
    }
  }
  return total;
}

// ── Core check (amount + per-call + daily) ────────────────────────────────────

/**
 * Check per-call cap and daily rolling limit for a given raw USDC amount.
 *
 * Address and contract allowlist checks are intentionally separate so each
 * guard can be tested independently and short-circuited without side effects.
 *
 * Throws SpendingLimitError on any violation.
 */
export function checkLimits(amountRaw: bigint): void {
  const perCallLimit = getPerCallLimit();
  const dailyLimit = getDailyLimit();

  if (amountRaw > perCallLimit) {
    throw new SpendingLimitError(
      'PER_CALL_EXCEEDED',
      `Transfer of ${formatUsdc(amountRaw)} USDC exceeds the per-call limit of ${formatUsdc(perCallLimit)} USDC. ` +
        `Raise PER_CALL_LIMIT_USDC in .env to allow larger single transfers.`,
    );
  }

  const todaySpent = computeDailySpend();
  if (todaySpent + amountRaw > dailyLimit) {
    throw new SpendingLimitError(
      'DAILY_LIMIT_EXCEEDED',
      `This transfer would bring today's total to ${formatUsdc(todaySpent + amountRaw)} USDC, ` +
        `exceeding the daily limit of ${formatUsdc(dailyLimit)} USDC. ` +
        `Spent today: ${formatUsdc(todaySpent)} USDC. ` +
        `Remaining: ${formatUsdc(dailyLimit > todaySpent ? dailyLimit - todaySpent : 0n)} USDC. ` +
        `Raise DAILY_LIMIT_USDC in .env or wait for the 24-hour window to roll over.`,
    );
  }
}

// ── Log helpers ───────────────────────────────────────────────────────────────

/** Append a tool-call record to the persistent log. */
export function appendLog(record: LogRecord): void {
  const path = logPath();
  // Ensure parent directory exists
  const dir = path.replace(/\/[^/]+$/, '');
  if (dir && dir !== path && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(path, JSON.stringify(record) + '\n', 'utf-8');
}

// ── Dashboard helpers ─────────────────────────────────────────────────────────

/** Current daily spending stats (for the dashboard API). */
export function dailyStats(): { spent: string; limit: string; remaining: string } {
  const dailyLimit = getDailyLimit();
  const spent = computeDailySpend();
  const remaining = dailyLimit > spent ? dailyLimit - spent : 0n;
  return {
    spent: formatUsdc(spent),
    limit: formatUsdc(dailyLimit),
    remaining: formatUsdc(remaining),
  };
}

/** Policy config snapshot (included in every tool response for transparency). */
export function limitsConfig(): {
  perCallLimit: string;
  dailyLimit: string;
  requireAllowlist: boolean;
  allowlistEnabled: boolean;
  allowedAddresses: string[];
  contractAllowlistEnabled: boolean;
  allowedContracts: string[];
  selectorAllowlistEnabled: boolean;
  allowedSelectors: string[];
  killSwitchActive: boolean;
  enforceOperationBinding: boolean;
} {
  const addresses = parseAllowlist(process.env.ALLOWED_ADDRESSES);
  const contracts = parseAllowlist(process.env.ALLOWED_CONTRACTS);
  const selectors = parseSelectors(process.env.ALLOWED_SELECTORS);
  return {
    perCallLimit: formatUsdc(getPerCallLimit()),
    dailyLimit: formatUsdc(getDailyLimit()),
    requireAllowlist: process.env.REQUIRE_ALLOWLIST !== 'false',
    allowlistEnabled: addresses.length > 0,
    allowedAddresses: addresses,
    contractAllowlistEnabled: contracts.length > 0,
    allowedContracts: contracts,
    selectorAllowlistEnabled: selectors.length > 0,
    allowedSelectors: selectors,
    killSwitchActive: isKillSwitchActive(),
    enforceOperationBinding: process.env.ENFORCE_OPERATION_BINDING !== 'false',
  };
}
