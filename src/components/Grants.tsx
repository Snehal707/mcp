/**
 * Grants — list, create, and revoke grants per agent client.
 */
import { useEffect, useState } from 'react';
import { Key, Plus, Trash2, ChevronDown } from 'lucide-react';

interface AgentClient {
  clientId: string;
  name: string;
  revoked: boolean;
}

interface AgentGrant {
  grantId: string;
  clientId: string;
  walletId?: string;
  tools: string[];
  approvalMode: string;
  perCallLimit?: number;
  dailyLimit?: number;
  createdAt: string;
  revoked: boolean;
}

const TOOL_GROUPS = {
  'Core transfers': ['transfer_usdc', 'transfer_usdc_agent', 'get_usdc_balance'],
  'Contracts': ['call_contract_read', 'call_contract_write', 'get_transaction_status'],
  'ERC-8183 Jobs': ['job_create', 'job_set_budget', 'job_approve_usdc', 'job_fund', 'job_submit', 'job_complete', 'job_reject', 'job_claim_refund', 'job_get'],
  'x402 Payments': ['pay_x402', 'discover_x402_services'],
  'Agent Wallets': ['create_agent_wallet', 'list_agent_wallets', 'get_agent_policy', 'set_agent_policy'],
};

const APPROVAL_MODES = [
  { value: 'autonomous', label: 'Autonomous', desc: 'Agent acts without approval' },
  { value: 'above_limit', label: 'Above limit', desc: 'Requires approval when over per-call cap' },
  { value: 'always', label: 'Always approve', desc: 'Every call pauses for human approval' },
];

function relTime(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export default function Grants() {
  const [clients, setClients] = useState<AgentClient[]>([]);
  const [grants, setGrants] = useState<AgentGrant[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [selClient, setSelClient] = useState('');
  const [selTools, setSelTools] = useState<string[]>([]);
  const [approvalMode, setApprovalMode] = useState<'autonomous' | 'always' | 'above_limit'>('autonomous');
  const [perCallLimit, setPerCallLimit] = useState('');
  const [dailyLimit, setDailyLimit] = useState('');
  const [walletId, setWalletId] = useState('');
  const [creating, setCreating] = useState(false);

  const load = () => {
    Promise.all([
      fetch('/api/clients').then((r) => (r.ok ? (r.json() as Promise<AgentClient[]>) : Promise.reject(new Error('fetch failed')))),
      fetch('/api/grants').then((r) => (r.ok ? (r.json() as Promise<AgentGrant[]>) : Promise.reject(new Error('fetch failed')))),
    ])
      .then(([cr, gr]) => { setClients(cr); setGrants(gr); })
      .catch(() => { /* offline */ })
      .finally(() => { setLoading(false); });
  };

  useEffect(() => { load(); }, []);

  const toggleTool = (tool: string) => {
    setSelTools((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool],
    );
  };

  const toggleAll = () => {
    if (selTools.includes('*')) {
      setSelTools([]);
    } else {
      setSelTools(['*']);
    }
  };

  const create = async () => {
    if (!selClient || selTools.length === 0) return;
    setCreating(true);
    try {
      const res = await fetch('/api/grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: selClient,
          tools: selTools,
          approvalMode,
          walletId: walletId.trim() || undefined,
          perCallLimit: perCallLimit ? parseFloat(perCallLimit) : undefined,
          dailyLimit: dailyLimit ? parseFloat(dailyLimit) : undefined,
        }),
      });
      if (res.ok) {
        setShowForm(false);
        setSelTools([]);
        setPerCallLimit('');
        setDailyLimit('');
        setWalletId('');
        void load();
      }
    } catch { /* ignore */ }
    finally { setCreating(false); }
  };

  const revoke = async (grantId: string) => {
    if (!confirm('Revoke this grant? The client will lose access to these tools immediately.')) return;
    try {
      const res = await fetch(`/api/grants/${grantId}`, { method: 'DELETE' });
      if (res.ok) void load();
    } catch { /* ignore */ }
  };

  const clientName = (id: string) => clients.find((c) => c.clientId === id)?.name ?? id.slice(0, 12);

  return (
    <div
      className="rounded-2xl"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      {/* Header */}
      <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2.5">
          <Key size={15} style={{ color: 'var(--accent)' }} />
          <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--accent)' }}>
            Grants
          </span>
          <span
            className="text-xs px-2 py-0.5 rounded-full"
            style={{ background: 'var(--surface-strong)', color: 'var(--muted)', border: '1px solid var(--border)' }}
          >
            {grants.filter((g) => !g.revoked).length} active
          </span>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-all"
          style={{ background: 'var(--accent)', color: '#0d1b2f' }}
        >
          <Plus size={12} />
          New grant
          <ChevronDown size={12} style={{ transform: showForm ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s' }} />
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="px-5 py-5 space-y-4" style={{ borderBottom: '1px solid var(--border)' }}>
          {/* Client selector */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--muted)' }}>
              Agent Client
            </label>
            <select
              value={selClient}
              onChange={(e) => setSelClient(e.target.value)}
              className="w-full text-sm px-3 py-2 rounded-lg outline-none"
              style={{ background: 'var(--surface-muted)', color: 'var(--ink)', border: '1px solid var(--border)' }}
            >
              <option value="">Select a client…</option>
              {clients.filter((c) => !c.revoked).map((c) => (
                <option key={c.clientId} value={c.clientId}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Tool selector */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Permitted tools</label>
              <button
                onClick={toggleAll}
                className="text-xs px-2 py-1 rounded"
                style={{ color: 'var(--accent)', background: 'transparent' }}
              >
                {selTools.includes('*') ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            {selTools.includes('*') ? (
              <div
                className="text-xs px-3 py-2 rounded-lg"
                style={{ background: 'rgba(172,198,233,0.10)', color: 'var(--accent)', border: '1px solid var(--border)' }}
              >
                All tools permitted
              </div>
            ) : (
              Object.entries(TOOL_GROUPS).map(([group, tools]) => (
                <div key={group} className="mb-3">
                  <p className="text-xs font-medium mb-1.5" style={{ color: 'var(--subtle)' }}>{group}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {tools.map((t) => (
                      <button
                        key={t}
                        onClick={() => toggleTool(t)}
                        className="mono text-xs px-2.5 py-1 rounded-lg transition-all"
                        style={{
                          background: selTools.includes(t) ? 'var(--accent)' : 'var(--surface-muted)',
                          color: selTools.includes(t) ? '#0d1b2f' : 'var(--ink-2)',
                          border: `1px solid ${selTools.includes(t) ? 'var(--accent)' : 'var(--border)'}`,
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Approval mode */}
          <div>
            <label className="block text-xs font-medium mb-2" style={{ color: 'var(--muted)' }}>Approval mode</label>
            <div className="flex flex-col gap-1.5">
              {APPROVAL_MODES.map((m) => (
                <label
                  key={m.value}
                  className="flex items-start gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-all"
                  style={{
                    background: approvalMode === m.value ? 'var(--surface-strong)' : 'var(--surface-muted)',
                    border: `1px solid ${approvalMode === m.value ? 'var(--border-strong)' : 'var(--border)'}`,
                  }}
                >
                  <input
                    type="radio"
                    name="approvalMode"
                    value={m.value}
                    checked={approvalMode === m.value}
                    onChange={() => setApprovalMode(m.value as typeof approvalMode)}
                    className="mt-0.5"
                  />
                  <div>
                    <p className="text-xs font-medium" style={{ color: 'var(--ink)' }}>{m.label}</p>
                    <p className="text-xs" style={{ color: 'var(--subtle)' }}>{m.desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Optional overrides */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>Per-call limit (USDC)</label>
              <input
                type="number"
                value={perCallLimit}
                onChange={(e) => setPerCallLimit(e.target.value)}
                placeholder="Default from env"
                className="w-full mono text-sm px-3 py-2 rounded-lg outline-none"
                style={{ background: 'var(--surface-muted)', color: 'var(--ink)', border: '1px solid var(--border)' }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>Daily limit (USDC)</label>
              <input
                type="number"
                value={dailyLimit}
                onChange={(e) => setDailyLimit(e.target.value)}
                placeholder="Default from env"
                className="w-full mono text-sm px-3 py-2 rounded-lg outline-none"
                style={{ background: 'var(--surface-muted)', color: 'var(--ink)', border: '1px solid var(--border)' }}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>Wallet ID (optional scope)</label>
            <input
              type="text"
              value={walletId}
              onChange={(e) => setWalletId(e.target.value)}
              placeholder="Restrict to specific agent wallet"
              className="w-full mono text-sm px-3 py-2 rounded-lg outline-none"
              style={{ background: 'var(--surface-muted)', color: 'var(--ink)', border: '1px solid var(--border)' }}
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => void create()}
              disabled={!selClient || selTools.length === 0 || creating}
              className="flex items-center gap-1.5 text-xs font-medium px-4 py-2 rounded-lg transition-all"
              style={{
                background: selClient && selTools.length > 0 && !creating ? 'var(--accent)' : 'var(--surface-strong)',
                color: selClient && selTools.length > 0 && !creating ? '#0d1b2f' : 'var(--subtle)',
                cursor: selClient && selTools.length > 0 && !creating ? 'pointer' : 'not-allowed',
              }}
            >
              {creating ? 'Creating…' : 'Create grant'}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="text-xs px-4 py-2 rounded-lg"
              style={{ background: 'transparent', color: 'var(--subtle)', border: '1px solid var(--border)' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Grant list */}
      <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
        {loading ? (
          <div className="px-5 py-8 text-center text-sm" style={{ color: 'var(--subtle)' }}>Loading grants…</div>
        ) : grants.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm" style={{ color: 'var(--subtle)' }}>
            No grants yet. Create one to give an agent client tool access.
          </div>
        ) : (
          grants.map((g) => (
            <div key={g.grantId} className="px-5 py-3.5 flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span
                    className="text-sm font-medium"
                    style={{ color: g.revoked ? 'var(--subtle)' : 'var(--ink)', textDecoration: g.revoked ? 'line-through' : undefined }}
                  >
                    {clientName(g.clientId)}
                  </span>
                  <span
                    className="text-xs px-2 py-0.5 rounded-full"
                    style={{
                      background: 'var(--surface-muted)',
                      color: g.approvalMode === 'always' ? '#f59e0b' : g.approvalMode === 'autonomous' ? 'var(--success)' : 'var(--accent)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {g.approvalMode}
                  </span>
                  {g.revoked && (
                    <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(232,109,122,0.12)', color: 'var(--danger)' }}>
                      revoked
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1 mb-1">
                  {(g.tools.includes('*') ? ['all tools'] : g.tools.slice(0, 5)).map((t) => (
                    <span
                      key={t}
                      className="mono text-xs px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--surface-muted)', color: 'var(--ink-2)', border: '1px solid var(--border)' }}
                    >
                      {t}
                    </span>
                  ))}
                  {!g.tools.includes('*') && g.tools.length > 5 && (
                    <span className="text-xs" style={{ color: 'var(--subtle)' }}>
                      +{g.tools.length - 5} more
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--subtle)' }}>
                  <span className="mono">{g.grantId.slice(0, 20)}</span>
                  <span>{relTime(g.createdAt)}</span>
                  {g.perCallLimit != null && <span>cap: {g.perCallLimit} USDC</span>}
                  {g.dailyLimit != null && <span>daily: {g.dailyLimit} USDC</span>}
                </div>
              </div>
              {!g.revoked && (
                <button
                  onClick={() => void revoke(g.grantId)}
                  className="flex-shrink-0 p-2 rounded-lg mt-0.5 transition-all"
                  style={{ background: 'transparent', color: 'var(--danger)', border: '1px solid var(--border)' }}
                  title="Revoke grant"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
