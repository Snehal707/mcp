/**
 * MCP Tool: export_audit_log
 *
 * Returns a filtered slice of the operation log.
 * Entries carry Phase 0 operation binding hashes for integrity verification.
 *
 * This tool is read-only — no funds move. No spending-limit checks.
 */
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'export_audit_log';

export const description =
  'Exports a filtered slice of the Arc MCP audit log (tool-calls.jsonl). ' +
  'Supports filtering by time range, tool name, client ID, and status. ' +
  'Returns entries with Phase 0 binding hashes for integrity verification. ' +
  'Read-only — no funds move.';

export const inputSchema = z.object({
  from:     z.string().optional().describe('ISO-8601 start timestamp (inclusive). Omit for no lower bound.'),
  to:       z.string().optional().describe('ISO-8601 end timestamp (inclusive). Omit for no upper bound.'),
  tool:     z.string().optional().describe('Filter to a specific tool name, e.g. "transfer_usdc".'),
  clientId: z.string().optional().describe('Filter to a specific agent client ID.'),
  status:   z.enum(['completed', 'rejected', 'error', 'blocked']).optional().describe('Filter by status.'),
  limit:    z.number().int().min(1).max(5000).optional().default(500).describe('Max entries to return (default 500, max 5000).'),
  format:   z.enum(['json', 'csv']).optional().default('json').describe('Output format.'),
});

type Input = z.infer<typeof inputSchema>;

function logPath(): string {
  const env = process.env['TOOL_LOG_PATH'];
  if (env) return path.resolve(env);
  return path.resolve('/home/user/app/tool-calls.jsonl');
}

function readLog(): Record<string, unknown>[] {
  const p = logPath();
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf-8');
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t) as Record<string, unknown>); } catch { /* skip */ }
  }
  return out;
}

function toCsv(entries: Record<string, unknown>[]): string {
  const cols = ['timestamp', 'tool', 'clientId', 'status', 'amountUsdc', 'to', 'binding.hash', 'txHash'];
  const rows = [cols.join(',')];
  for (const e of entries) {
    const binding = e['binding'] as Record<string, unknown> | undefined;
    const row = cols.map((col) => {
      const val = col === 'binding.hash' ? (binding?.['hash'] ?? '') : (e[col] ?? '');
      const s = String(val).replace(/"/g, '""');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
    });
    rows.push(row.join(','));
  }
  return rows.join('\n');
}

export async function handler(input: Input): Promise<string> {
  const { from, to, tool, clientId, status, limit, format } = input;

  const fromMs = from ? new Date(from).getTime() : -Infinity;
  const toMs   = to   ? new Date(to).getTime()   :  Infinity;

  if (from && isNaN(fromMs)) return JSON.stringify({ error: `Invalid "from" timestamp: ${from}` });
  if (to   && isNaN(toMs))   return JSON.stringify({ error: `Invalid "to" timestamp: ${to}` });

  let entries = readLog();

  // Filter
  if (from || to) {
    entries = entries.filter((e) => {
      const ts = new Date(e['timestamp'] as string).getTime();
      return ts >= fromMs && ts <= toMs;
    });
  }
  if (tool)     entries = entries.filter((e) => e['tool'] === tool);
  if (clientId) entries = entries.filter((e) => e['clientId'] === clientId);
  if (status)   entries = entries.filter((e) => e['status'] === status);

  // Newest first, capped
  const sliced = entries.slice(-limit!).reverse();

  if (format === 'csv') {
    return toCsv(sliced);
  }

  return JSON.stringify({
    count:   sliced.length,
    total:   entries.length,
    entries: sliced,
  }, null, 2);
}
