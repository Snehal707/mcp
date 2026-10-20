/**
 * Phase 4 — Agent Client + Grant registry.
 *
 * Clients: named integrations (e.g. "Claude Desktop", "Research Bot").
 *   - Each client gets a unique clientId and a one-time clientKey.
 *   - Clients can be revoked independently.
 *
 * Grants: link a client to a capability set.
 *   - Each grant specifies which tools the client may call.
 *   - Optional wallet scoping, per-call/daily limit overrides, and approval mode.
 *   - Revoking a grant immediately blocks that client from write tools.
 *
 * Storage: JSON flat file (clients.json + grants.json in the data dir).
 * Simple append-on-write, full rewrite on update/revoke.
 * Fine for a single-server control plane; replace with SQLite for multi-process.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── Data directory ────────────────────────────────────────────────────────────

const DATA_DIR = process.env.CLIENTS_DATA_DIR
  ? path.resolve(process.env.CLIENTS_DATA_DIR)
  : path.resolve('/home/user/app');

const CLIENTS_PATH = path.join(DATA_DIR, 'agent-clients.json');
const GRANTS_PATH = path.join(DATA_DIR, 'agent-grants.json');

// ── Types ─────────────────────────────────────────────────────────────────────

export type ApprovalMode = 'always' | 'autonomous' | 'above_limit';

export interface AgentClient {
  clientId: string;
  name: string;
  description?: string;
  /** SHA-256 hash of the raw clientKey — raw value is shown once at creation. */
  clientKeyHash: string;
  createdAt: string;
  revoked: boolean;
  revokedAt?: string;
}

export interface AgentGrant {
  grantId: string;
  clientId: string;
  walletId?: string;
  /** Tool names this grant permits. Use ["*"] for all tools. */
  tools: string[];
  approvalMode: ApprovalMode;
  perCallLimit?: number;
  dailyLimit?: number;
  createdAt: string;
  revoked: boolean;
  revokedAt?: string;
}

// ── Persistence helpers ───────────────────────────────────────────────────────

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(filePath: string, data: T): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ── Client CRUD ───────────────────────────────────────────────────────────────

export interface CreateClientResult extends AgentClient {
  /** Raw key — shown ONCE, not stored. */
  clientKey: string;
}

export function createClient(name: string, description?: string): CreateClientResult {
  const clients = readJson<AgentClient[]>(CLIENTS_PATH, []);

  const clientId = `client_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const clientKey = `mcp_${crypto.randomBytes(24).toString('hex')}`;
  const clientKeyHash = crypto.createHash('sha256').update(clientKey).digest('hex');

  const record: AgentClient = {
    clientId,
    name: name.slice(0, 80),
    description: description?.slice(0, 200),
    clientKeyHash,
    createdAt: new Date().toISOString(),
    revoked: false,
  };

  clients.push(record);
  writeJson(CLIENTS_PATH, clients);

  return { ...record, clientKey };
}

export function listClients(): AgentClient[] {
  return readJson<AgentClient[]>(CLIENTS_PATH, []);
}

export function getClient(clientId: string): AgentClient | undefined {
  return listClients().find((c) => c.clientId === clientId);
}

export function revokeClient(clientId: string): boolean {
  const clients = readJson<AgentClient[]>(CLIENTS_PATH, []);
  const idx = clients.findIndex((c) => c.clientId === clientId);
  if (idx === -1) return false;
  clients[idx] = { ...clients[idx], revoked: true, revokedAt: new Date().toISOString() };
  writeJson(CLIENTS_PATH, clients);
  return true;
}

/**
 * Verify a raw clientKey against the stored hash.
 * Returns the matching non-revoked client, or undefined.
 */
export function verifyClientKey(clientKey: string): AgentClient | undefined {
  const hash = crypto.createHash('sha256').update(clientKey).digest('hex');
  return listClients().find((c) => c.clientKeyHash === hash && !c.revoked);
}

// ── Grant CRUD ────────────────────────────────────────────────────────────────

export interface CreateGrantInput {
  clientId: string;
  walletId?: string;
  tools: string[];
  approvalMode: ApprovalMode;
  perCallLimit?: number;
  dailyLimit?: number;
}

export function createGrant(input: CreateGrantInput): AgentGrant {
  // Ensure the client exists and is not revoked
  const client = getClient(input.clientId);
  if (!client) throw new Error(`Client not found: ${input.clientId}`);
  if (client.revoked) throw new Error(`Client is revoked: ${input.clientId}`);

  const grants = readJson<AgentGrant[]>(GRANTS_PATH, []);

  const grant: AgentGrant = {
    grantId: `grant_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    clientId: input.clientId,
    walletId: input.walletId,
    tools: input.tools,
    approvalMode: input.approvalMode,
    perCallLimit: input.perCallLimit,
    dailyLimit: input.dailyLimit,
    createdAt: new Date().toISOString(),
    revoked: false,
  };

  grants.push(grant);
  writeJson(GRANTS_PATH, grants);
  return grant;
}

export function listGrants(clientId?: string): AgentGrant[] {
  const grants = readJson<AgentGrant[]>(GRANTS_PATH, []);
  return clientId ? grants.filter((g) => g.clientId === clientId) : grants;
}

export function getGrant(grantId: string): AgentGrant | undefined {
  return readJson<AgentGrant[]>(GRANTS_PATH, []).find((g) => g.grantId === grantId);
}

export function revokeGrant(grantId: string): boolean {
  const grants = readJson<AgentGrant[]>(GRANTS_PATH, []);
  const idx = grants.findIndex((g) => g.grantId === grantId);
  if (idx === -1) return false;
  grants[idx] = { ...grants[idx], revoked: true, revokedAt: new Date().toISOString() };
  writeJson(GRANTS_PATH, grants);
  return true;
}

// ── Grant enforcement ─────────────────────────────────────────────────────────

export class GrantError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GrantError';
  }
}

/**
 * Verify that a client has a non-revoked grant for the requested tool.
 * If clientId is absent, this is a legacy call (pre-Phase 4) — allow it through.
 *
 * Returns the matching grant (for limit overrides) or null (legacy pass-through).
 */
export function checkGrant(clientId: string | undefined, tool: string): AgentGrant | null {
  if (!clientId) return null; // pre-Phase 4 callers always pass through

  const client = getClient(clientId);
  if (!client) {
    throw new GrantError('CLIENT_NOT_FOUND', `Unknown agent client: ${clientId}`);
  }
  if (client.revoked) {
    throw new GrantError('CLIENT_REVOKED', `Agent client "${client.name}" has been revoked`);
  }

  const grants = listGrants(clientId).filter((g) => !g.revoked);
  const matching = grants.find(
    (g) => g.tools.includes('*') || g.tools.includes(tool),
  );

  if (!matching) {
    throw new GrantError(
      'NO_GRANT',
      `Client "${client.name}" has no active grant for tool "${tool}". ` +
        'Create a grant using the create_grant tool or dashboard.',
    );
  }

  return matching;
}

// ── Kill-switch persistence ───────────────────────────────────────────────────

const KILL_SWITCH_PATH = path.join(DATA_DIR, 'kill-switch.json');

export function getKillSwitch(): boolean {
  // Env var takes priority (Phase 0 unchanged)
  if (process.env.KILL_SWITCH === 'true') return true;
  try {
    const data = readJson<{ active: boolean }>(KILL_SWITCH_PATH, { active: false });
    return data.active;
  } catch {
    return false;
  }
}

export function setKillSwitch(active: boolean): void {
  writeJson(KILL_SWITCH_PATH, { active, updatedAt: new Date().toISOString() });
  // Also update the env var so the spending-limits module sees it immediately
  process.env.KILL_SWITCH = active ? 'true' : 'false';
}
