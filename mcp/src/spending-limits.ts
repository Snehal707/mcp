/**
 * Spending-limit engine.
 *
 * Three independent guardrails applied before every transfer_usdc or
 * call_contract_write tool invocation:
 *
 *   1. Per-call cap   — reject any single transfer above PER_CALL_LIMIT_USDC
 *   2. Daily rolling  — track cumulative 24-hour spend and block when exceeded
 *   3. Address allowlist — block transfers to addresses not in ALLOWED_ADDRESSES
 *
 * In-memory state is written to TOOL_LOG_PATH so the dashboard can read it;
 * the rolling daily total survives across server restarts by scanning the log.
 */
import fs from 'node:fs';
import { parseUsdc, formatUsdc } from './arc-chain.js';

// ── Config (read from env) ────────────────────────────────────────────────────

function envUsdc(name: string, defaultHuman: string): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return parseUsdc(defaultHuman);
  return parseUsdc(raw);
}

function envAllowlist(): Set<string> | null {
  const raw = process.env.ALLOWED_ADDRESSES?.trim();
  if (!raw) return null; // null = allow any address
  const addrs = raw
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  return addrs.length > 0 ? new Set(addrs) : null;
}

const PER_CALL_LIMIT: bigint = envUsdc('PER_CALL_LIMIT_USDC', '10');
const DAILY_LIMIT: bigint = envUsdc('DAILY_LIMIT_USDC', '100');
const ALLOWLIST: Set<string> | null = envAllowlist();

// ── Structured error ──────────────────────────────────────────────────────────

export class SpendingLimitError extends Error {
  constructor(
    public readonly code:
      | 'PER_CALL_EXCEEDED'
      | 'DAILY_LIMIT_EXCEEDED'
      | 'ADDRESS_NOT_ALLOWED',
    message: string,
  ) {
    super(message);
    this.name = 'SpendingLimitError';
  }
}

// ── Daily rolling total (in-memory + persisted via log scan) ──────────────────

interface LogRecord {
  timestamp: string; // ISO-8601
  tool: string;
  amountUsdc?: string; // human-readable, present only on transfer/write tools
  status: 'approved' | 'blocked' | 'completed' | 'failed';
  [key: string]: unknown;
}

function logPath(): string {
  return process.env.TOOL_LOG_PATH ?? '../tool-calls.jsonl';
}

/** Sum the USDC spent in the last 24 hours from the persisted log. */
function computeDailySpend(): bigint {
  const path = logPath();
  if (!fs.existsSync(path)) return 0n;

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let total = 0n;

  const raw = fs.readFileSync(path, 'utf-8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as LogRecord;
      if (
        rec.status === 'completed' &&
        rec.amountUsdc &&
        new Date(rec.timestamp).getTime() >= cutoff
      ) {
        total += parseUsdc(rec.amountUsdc);
      }
    } catch {
      // skip malformed lines
    }
  }
  return total;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check all spending limits before dispatching a transfer.
 * Throws SpendingLimitError on any violation.
 * Does NOT record the spend — call recordSpend() on successful completion.
 *
 * @param to   recipient address (0x-prefixed, any case)
 * @param amountRaw  USDC amount as raw 6-decimal bigint
 */
export function checkLimits(to: string, amountRaw: bigint): void {
  // 1. Per-call cap
  if (amountRaw > PER_CALL_LIMIT) {
    throw new SpendingLimitError(
      'PER_CALL_EXCEEDED',
      `Transfer of ${formatUsdc(amountRaw)} USDC exceeds the per-call limit of ${formatUsdc(PER_CALL_LIMIT)} USDC. ` +
        `Raise PER_CALL_LIMIT_USDC in .env to allow larger single transfers.`,
    );
  }

  // 2. Daily rolling limit
  const todaySpent = computeDailySpend();
  if (todaySpent + amountRaw > DAILY_LIMIT) {
    throw new SpendingLimitError(
      'DAILY_LIMIT_EXCEEDED',
      `This transfer would bring today's total to ${formatUsdc(todaySpent + amountRaw)} USDC, ` +
        `exceeding the daily limit of ${formatUsdc(DAILY_LIMIT)} USDC. ` +
        `Spent today: ${formatUsdc(todaySpent)} USDC. Remaining: ${formatUsdc(DAILY_LIMIT - todaySpent)} USDC. ` +
        `Raise DAILY_LIMIT_USDC in .env or wait for the 24-hour window to roll over.`,
    );
  }

  // 3. Address allowlist
  if (ALLOWLIST !== null) {
    const normalized = to.toLowerCase();
    if (!ALLOWLIST.has(normalized)) {
      throw new SpendingLimitError(
        'ADDRESS_NOT_ALLOWED',
        `Recipient ${to} is not in the ALLOWED_ADDRESSES list. ` +
          `Add it to ALLOWED_ADDRESSES in .env to permit transfers to this address.`,
      );
    }
  }
}

/** Append a tool-call record to the persistent log. */
export function appendLog(record: LogRecord): void {
  const path = logPath();
  const dir = path.replace(/\/[^/]+$/, '');
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(path, JSON.stringify(record) + '\n', 'utf-8');
}

/** Current daily spending stats (for the dashboard). */
export function dailyStats(): { spent: string; limit: string; remaining: string } {
  const spent = computeDailySpend();
  const remaining = DAILY_LIMIT > spent ? DAILY_LIMIT - spent : 0n;
  return {
    spent: formatUsdc(spent),
    limit: formatUsdc(DAILY_LIMIT),
    remaining: formatUsdc(remaining),
  };
}

/** Config snapshot (for tools to include in their responses). */
export function limitsConfig(): {
  perCallLimit: string;
  dailyLimit: string;
  allowlistEnabled: boolean;
  allowedAddresses: string[];
} {
  return {
    perCallLimit: formatUsdc(PER_CALL_LIMIT),
    dailyLimit: formatUsdc(DAILY_LIMIT),
    allowlistEnabled: ALLOWLIST !== null,
    allowedAddresses: ALLOWLIST ? [...ALLOWLIST] : [],
  };
}
