/**
 * Lightweight Express backend that serves the tool-call log and spending-limit
 * stats to the React dashboard.
 *
 * Routes:
 *   GET /health       — liveness check
 *   GET /tool-log     — returns last 200 JSONL entries from TOOL_LOG_PATH
 *   GET /limits       — returns current daily stats + config
 *
 * Started separately from the MCP server. The Vite dev proxy forwards
 * /api/* to this process.
 */
import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

const app = express();
const PORT = 3001;

// ── Tool log path ─────────────────────────────────────────────────────────────
const LOG_PATH = process.env.TOOL_LOG_PATH
  ? path.resolve(process.env.TOOL_LOG_PATH)
  : path.resolve('/home/user/app/tool-calls.jsonl');

// ── Spending limit helpers ────────────────────────────────────────────────────
function parseUsdcEnv(name: string, def: string): number {
  const v = process.env[name]?.trim();
  return v ? parseFloat(v) : parseFloat(def);
}

function computeDailySpend(): number {
  if (!fs.existsSync(LOG_PATH)) return 0;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let total = 0;
  const raw = fs.readFileSync(LOG_PATH, 'utf-8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as Record<string, unknown>;
      if (
        rec.status === 'completed' &&
        typeof rec.amountUsdc === 'string' &&
        new Date(rec.timestamp as string).getTime() >= cutoff
      ) {
        total += parseFloat(rec.amountUsdc);
      }
    } catch { /* skip */ }
  }
  return total;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

app.get('/tool-log', (_req, res) => {
  if (!fs.existsSync(LOG_PATH)) {
    res.json([]);
    return;
  }
  const raw = fs.readFileSync(LOG_PATH, 'utf-8');
  const entries: unknown[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch { /* skip */ }
  }
  // Return last 200 entries
  res.json(entries.slice(-200));
});

app.get('/limits', (_req, res) => {
  const perCallLimit = parseUsdcEnv('PER_CALL_LIMIT_USDC', '10');
  const dailyLimit = parseUsdcEnv('DAILY_LIMIT_USDC', '100');
  const spentToday = computeDailySpend();
  const remaining = Math.max(0, dailyLimit - spentToday);

  const allowlistRaw = process.env.ALLOWED_ADDRESSES?.trim() ?? '';
  const allowedAddresses = allowlistRaw
    ? allowlistRaw.split(',').map((a) => a.trim()).filter(Boolean)
    : [];

  res.json({
    perCallLimit: perCallLimit.toString(),
    dailyLimit: dailyLimit.toString(),
    spentToday: spentToday.toFixed(6),
    remainingToday: remaining.toFixed(6),
    allowlistEnabled: allowedAddresses.length > 0,
    allowedAddresses,
  });
});

app.listen(PORT, () => {
  console.log(`[Arc MCP Dashboard API] Listening on http://localhost:${PORT}`);
});
