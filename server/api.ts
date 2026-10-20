/**
 * Arc MCP Dashboard API — Phase 5 expansion.
 *
 * Routes:
 *   GET  /health                — liveness (always public)
 *   GET  /tool-log              — last N JSONL entries
 *   GET  /limits                — daily stats + config
 *   GET  /status                — Phase 5: full system status snapshot
 *   GET  /clients               — list agent clients
 *   POST /clients               — create agent client
 *   DELETE /clients/:id         — revoke client
 *   GET  /grants                — list grants (optional ?clientId=)
 *   POST /grants                — create grant
 *   DELETE /grants/:id          — revoke grant
 *   POST /kill-switch           — { active: boolean }
 *   GET  /kill-switch           — { active: boolean }
 *   GET  /export                — download full log as JSON or CSV
 *   GET  /alerts                — Phase 5: recent alert events
 *
 * Phase 5 auth: when DASHBOARD_API_TOKEN is set, all routes except /health
 * require "Authorization: Bearer <token>". Separate from the MCP server token.
 *
 * The React dashboard proxies /api/* to this server via Vite dev proxy.
 * Polling: dashboard polls /tool-log every 3s for live activity.
 */
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';

// ── clients module lives inside mcp/src — import via relative path ────────────
// We compile with ts-node / bun, so .ts imports work directly.
import {
  createClient,
  listClients,
  revokeClient,
  createGrant,
  listGrants,
  revokeGrant,
  getKillSwitch,
  setKillSwitch,
  type CreateGrantInput,
} from '../mcp/src/clients.js';

const app = express();
app.use(express.json());
const PORT = 3001;

// ── Phase 5: dashboard API authentication ─────────────────────────────────────
// Separate token from MCP server token so the dashboard can be locked down
// independently. Set DASHBOARD_API_TOKEN in .env for production.
function dashboardAuth(req: Request, res: Response, next: NextFunction): void {
  const token = process.env['DASHBOARD_API_TOKEN']?.trim() ?? '';
  if (!token || req.path === '/health') { next(); return; }
  const h = req.headers['authorization'] ?? '';
  const presented = h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
  if (!presented) { res.status(401).json({ error: 'Authorization header required' }); return; }
  // Constant-time compare
  if (presented.length !== token.length) { res.status(403).json({ error: 'Invalid token' }); return; }
  let diff = 0;
  for (let i = 0; i < presented.length; i++) diff |= (presented.charCodeAt(i) ^ token.charCodeAt(i));
  if (diff !== 0) { res.status(403).json({ error: 'Invalid token' }); return; }
  next();
}
app.use(dashboardAuth);

// ── Phase 5: in-memory alert log ──────────────────────────────────────────────
// Alerts are lightweight structured events pushed when notable policy actions
// occur (kill switch toggled, limit approached, client revoked, etc.).
interface Alert { ts: string; level: 'warn' | 'critical'; event: string; detail?: string }
const alertLog: Alert[] = [];
const MAX_ALERTS = 500;

function pushAlert(level: Alert['level'], event: string, detail?: string): void {
  alertLog.push({ ts: new Date().toISOString(), level, event, detail });
  if (alertLog.length > MAX_ALERTS) alertLog.splice(0, alertLog.length - MAX_ALERTS);
  console.warn(`[Arc MCP ALERT] [${level.toUpperCase()}] ${event}${detail ? ` — ${detail}` : ''}`);
}

// ── Tool log path ─────────────────────────────────────────────────────────────
const LOG_PATH = process.env.TOOL_LOG_PATH
  ? path.resolve(process.env.TOOL_LOG_PATH)
  : path.resolve('/home/user/app/tool-calls.jsonl');

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseUsdcEnv(name: string, def: string): number {
  const v = process.env[name]?.trim();
  return v ? parseFloat(v) : parseFloat(def);
}

function readLog(limit = 500): unknown[] {
  if (!fs.existsSync(LOG_PATH)) return [];
  const raw = fs.readFileSync(LOG_PATH, 'utf-8');
  const entries: unknown[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch { /* skip */ }
  }
  return entries.slice(-limit);
}

function computeDailySpend(): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let total = 0;
  for (const rec of readLog(10_000)) {
    const r = rec as Record<string, unknown>;
    if (
      r.status === 'completed' &&
      typeof r.amountUsdc === 'string' &&
      new Date(r.timestamp as string).getTime() >= cutoff
    ) {
      total += parseFloat(r.amountUsdc);
    }
  }
  return total;
}

// ── CORS (allow dashboard origin) ─────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.options('*', (_req, res) => { res.sendStatus(204); });

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString(), killSwitch: getKillSwitch() });
});

// ── Phase 5: System status ────────────────────────────────────────────────────
app.get('/status', (_req, res) => {
  const perCallLimit = parseUsdcEnv('PER_CALL_LIMIT_USDC', '10');
  const dailyLimit   = parseUsdcEnv('DAILY_LIMIT_USDC', '100');
  const spentToday   = computeDailySpend();
  const pct          = dailyLimit > 0 ? (spentToday / dailyLimit) * 100 : 0;
  const ks           = getKillSwitch();

  // Fire alerts based on current state
  if (pct >= 90 && !ks) pushAlert('warn', 'daily_limit_approaching', `${pct.toFixed(1)}% of daily USDC limit used`);
  if (pct >= 100)       pushAlert('critical', 'daily_limit_reached', `${spentToday.toFixed(6)} USDC spent`);

  const allowlistRaw  = process.env['ALLOWED_ADDRESSES']?.trim() ?? '';
  const contractsRaw  = process.env['ALLOWED_CONTRACTS']?.trim() ?? '';

  res.json({
    version: '1.5.0',
    network: process.env['ARC_NETWORK'] ?? 'testnet',
    agentMode: process.env['AGENT_MODE'] ?? 'unsigned',
    killSwitch: ks,
    dailySpendUsdc: spentToday.toFixed(6),
    dailyLimitUsdc: dailyLimit.toFixed(2),
    percentUsed: pct.toFixed(1),
    perCallLimitUsdc: perCallLimit.toFixed(2),
    activeClients: listClients().filter((c) => !c.revoked).length,
    activeGrants:  listGrants().filter((g) => !g.revoked).length,
    policy: {
      requireAllowlist:    process.env['REQUIRE_ALLOWLIST'] !== 'false',
      allowlistEnabled:    allowlistRaw.length > 0,
      contractsEnabled:    contractsRaw.length > 0,
      enforceBinding:      process.env['ENFORCE_OPERATION_BINDING'] !== 'false',
      x402MaxPrice:        process.env['X402_MAX_PRICE_USDC'] ?? null,
      authEnabled:         Boolean(process.env['DASHBOARD_API_TOKEN']?.trim()),
    },
    alerts: alertLog.slice(-10),
    ts: new Date().toISOString(),
  });
});

// ── Phase 5: Alerts ───────────────────────────────────────────────────────────
app.get('/alerts', (req: Request, res: Response) => {
  const level = req.query['level'] as string | undefined;
  const limit = Math.min(parseInt((req.query['limit'] as string) ?? '100', 10), 500);
  let entries = alertLog;
  if (level) entries = entries.filter((a) => a.level === level);
  res.json(entries.slice(-limit).reverse());
});

// ── Tool log ──────────────────────────────────────────────────────────────────
app.get('/tool-log', (req: Request, res: Response) => {
  const limit = Math.min(parseInt((req.query['limit'] as string) ?? '200', 10), 1000);
  const tool = req.query['tool'] as string | undefined;
  const status = req.query['status'] as string | undefined;
  const clientId = req.query['clientId'] as string | undefined;

  let entries = readLog(limit * 4) as Record<string, unknown>[];

  if (tool) entries = entries.filter((e) => e['tool'] === tool);
  if (status) entries = entries.filter((e) => e['status'] === status);
  if (clientId) entries = entries.filter((e) => e['clientId'] === clientId);

  res.json(entries.slice(-limit));
});

// ── Limits ────────────────────────────────────────────────────────────────────
app.get('/limits', (_req, res) => {
  const perCallLimit = parseUsdcEnv('PER_CALL_LIMIT_USDC', '10');
  const dailyLimit = parseUsdcEnv('DAILY_LIMIT_USDC', '100');
  const spentToday = computeDailySpend();
  const remaining = Math.max(0, dailyLimit - spentToday);

  const allowlistRaw = process.env.ALLOWED_ADDRESSES?.trim() ?? '';
  const allowedAddresses = allowlistRaw.split(',').map((a) => a.trim()).filter(Boolean);

  const contractsRaw = process.env.ALLOWED_CONTRACTS?.trim() ?? '';
  const allowedContracts = contractsRaw.split(',').map((a) => a.trim()).filter(Boolean);

  res.json({
    perCallLimit: perCallLimit.toFixed(2),
    dailyLimit: dailyLimit.toFixed(2),
    spentToday: spentToday.toFixed(6),
    remainingToday: remaining.toFixed(6),
    percentUsed: dailyLimit > 0 ? ((spentToday / dailyLimit) * 100).toFixed(1) : '0',
    killSwitch: getKillSwitch(),
    requireAllowlist: process.env.REQUIRE_ALLOWLIST !== 'false',
    allowlistEnabled: allowedAddresses.length > 0,
    allowedAddresses,
    allowedContracts,
    agentMode: process.env.AGENT_MODE ?? 'unsigned',
    arcNetwork: process.env.ARC_NETWORK ?? 'testnet',
    enforceBinding: process.env.ENFORCE_OPERATION_BINDING !== 'false',
  });
});

// ── Kill switch ───────────────────────────────────────────────────────────────
app.get('/kill-switch', (_req, res) => {
  res.json({ active: getKillSwitch() });
});

app.post('/kill-switch', (req: Request, res: Response) => {
  const { active } = req.body as { active?: unknown };
  if (typeof active !== 'boolean') {
    res.status(400).json({ error: '{ "active": true | false } required' });
    return;
  }
  setKillSwitch(active);
  pushAlert(
    active ? 'critical' : 'warn',
    active ? 'kill_switch_activated' : 'kill_switch_deactivated',
    `Set by dashboard at ${new Date().toISOString()}`,
  );
  console.log(`[Control Plane] Kill switch set to: ${active}`);
  res.json({ killSwitch: active, ts: new Date().toISOString() });
});

// ── Agent clients ─────────────────────────────────────────────────────────────
app.get('/clients', (_req, res) => {
  res.json(listClients());
});

app.post('/clients', (req: Request, res: Response) => {
  const { name, description } = req.body as { name?: unknown; description?: unknown };
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: '"name" (string) is required' });
    return;
  }
  try {
    const result = createClient(name.trim(), typeof description === 'string' ? description : undefined);
    console.log(`[Control Plane] Client created: ${result.clientId} "${result.name}"`);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete('/clients/:id', (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const ok = revokeClient(id);
  if (!ok) {
    res.status(404).json({ error: 'Client not found' });
    return;
  }
  pushAlert('warn', 'client_revoked', `Client ${id} revoked at ${new Date().toISOString()}`);
  console.log(`[Control Plane] Client revoked: ${id}`);
  res.json({ status: 'revoked' });
});

// ── Grants ────────────────────────────────────────────────────────────────────
app.get('/grants', (req: Request, res: Response) => {
  const clientId = req.query['clientId'] as string | undefined;
  res.json(listGrants(clientId));
});

app.post('/grants', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const { clientId, walletId, tools, approvalMode, perCallLimit, dailyLimit } = body;

  if (typeof clientId !== 'string' || !clientId) {
    res.status(400).json({ error: '"clientId" required' });
    return;
  }
  if (!Array.isArray(tools) || tools.length === 0) {
    res.status(400).json({ error: '"tools" array required' });
    return;
  }
  const validModes = ['always', 'autonomous', 'above_limit'];
  if (typeof approvalMode !== 'string' || !validModes.includes(approvalMode)) {
    res.status(400).json({ error: `"approvalMode" must be one of: ${validModes.join(', ')}` });
    return;
  }

  try {
    const input: CreateGrantInput = {
      clientId,
      walletId: typeof walletId === 'string' ? walletId : undefined,
      tools: tools as string[],
      approvalMode: approvalMode as CreateGrantInput['approvalMode'],
      perCallLimit: typeof perCallLimit === 'number' ? perCallLimit : undefined,
      dailyLimit: typeof dailyLimit === 'number' ? dailyLimit : undefined,
    };
    const grant = createGrant(input);
    console.log(`[Control Plane] Grant created: ${grant.grantId} for client ${grant.clientId}`);
    res.status(201).json(grant);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.delete('/grants/:id', (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const ok = revokeGrant(id);
  if (!ok) {
    res.status(404).json({ error: 'Grant not found' });
    return;
  }
  pushAlert('warn', 'grant_revoked', `Grant ${id} revoked at ${new Date().toISOString()}`);
  console.log(`[Control Plane] Grant revoked: ${id}`);
  res.json({ status: 'revoked' });
});

// ── Audit export ──────────────────────────────────────────────────────────────
app.get('/export', (req: Request, res: Response) => {
  const format = (req.query['format'] as string) ?? 'json';
  const entries = readLog(10_000);

  if (format === 'csv') {
    const cols = ['timestamp', 'tool', 'clientId', 'status', 'amountUsdc', 'to', 'binding.hash'];
    const header = cols.join(',');
    const rows = entries.map((e) => {
      const r = e as Record<string, unknown>;
      const binding = r['binding'] as Record<string, unknown> | undefined;
      return cols.map((col) => {
        const val = col === 'binding.hash'
          ? (binding?.['hash'] ?? '')
          : (r[col] ?? '');
        const s = String(val).replace(/"/g, '""');
        return s.includes(',') || s.includes('"') ? `"${s}"` : s;
      }).join(',');
    });
    res.setHeader('Content-Disposition', 'attachment; filename="arc-mcp-audit.csv"');
    res.setHeader('Content-Type', 'text/csv');
    res.send([header, ...rows].join('\n'));
    return;
  }

  res.setHeader('Content-Disposition', 'attachment; filename="arc-mcp-audit.json"');
  res.setHeader('Content-Type', 'application/json');
  res.json(entries);
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Arc MCP Dashboard API] Listening on http://localhost:${PORT}`);
  console.log(`[Arc MCP Dashboard API] Kill switch: ${getKillSwitch()}`);
});
