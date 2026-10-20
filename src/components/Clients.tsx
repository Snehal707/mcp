/**
 * Clients — list, create, and revoke agent clients.
 */
import { useEffect, useState } from 'react';
import { Users, Plus, Trash2, Copy, CheckCircle } from 'lucide-react';

interface AgentClient {
  clientId: string;
  name: string;
  description?: string;
  createdAt: string;
  revoked: boolean;
  revokedAt?: string;
}

interface NewClientResult extends AgentClient {
  clientKey: string;
}

function relTime(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export default function Clients() {
  const [clients, setClients] = useState<AgentClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [newClient, setNewClient] = useState<NewClientResult | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => {
    fetch('/api/clients')
      .then((res) => (res.ok ? (res.json() as Promise<AgentClient[]>) : Promise.reject(new Error('fetch failed'))))
      .then(setClients)
      .catch(() => { /* backend offline */ })
      .finally(() => { setLoading(false); });
  };

  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined }),
      });
      if (res.ok) {
        const data = (await res.json()) as NewClientResult;
        setNewClient(data);
        setName('');
        setDescription('');
        void load();
      }
    } catch { /* ignore */ }
    finally { setCreating(false); }
  };

  const revoke = async (clientId: string) => {
    if (!confirm('Revoke this client? All its grants will stop working immediately.')) return;
    try {
      const res = await fetch(`/api/clients/${clientId}`, { method: 'DELETE' });
      if (res.ok) void load();
    } catch { /* ignore */ }
  };

  const copyKey = (key: string) => {
    navigator.clipboard.writeText(key).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="rounded-2xl"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      {/* Header */}
      <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2.5">
          <Users size={15} style={{ color: 'var(--accent)' }} />
          <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--accent)' }}>
            Agent Clients
          </span>
          <span
            className="text-xs px-2 py-0.5 rounded-full"
            style={{ background: 'var(--surface-strong)', color: 'var(--muted)', border: '1px solid var(--border)' }}
          >
            {clients.filter((c) => !c.revoked).length} active
          </span>
        </div>
      </div>

      {/* New-client key reveal */}
      {newClient && (
        <div
          className="mx-5 mt-5 rounded-xl p-4"
          style={{ background: 'rgba(141,216,159,0.08)', border: '1px solid var(--success)' }}
        >
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle size={13} style={{ color: 'var(--success)' }} />
            <span className="text-xs font-semibold" style={{ color: 'var(--success)' }}>
              Client created — copy the key now (shown once)
            </span>
          </div>
          <div
            className="mono text-xs rounded-lg p-3 break-all select-all mb-2"
            style={{ background: 'var(--surface-muted)', color: 'var(--ink-2)', border: '1px solid var(--border)' }}
          >
            {newClient.clientKey}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => copyKey(newClient.clientKey)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all"
              style={{ background: 'var(--success)', color: '#0d1b2f' }}
            >
              {copied ? <CheckCircle size={11} /> : <Copy size={11} />}
              {copied ? 'Copied!' : 'Copy key'}
            </button>
            <button
              onClick={() => setNewClient(null)}
              className="text-xs px-3 py-1.5 rounded-lg"
              style={{ background: 'transparent', color: 'var(--subtle)', border: '1px solid var(--border)' }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Create form */}
      <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
            placeholder="Client name (e.g. Research Bot)"
            maxLength={80}
            className="flex-1 text-sm px-3 py-2 rounded-lg outline-none"
            style={{
              background: 'var(--surface-muted)',
              color: 'var(--ink)',
              border: '1px solid var(--border)',
            }}
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            maxLength={200}
            className="flex-1 text-sm px-3 py-2 rounded-lg outline-none"
            style={{
              background: 'var(--surface-muted)',
              color: 'var(--ink)',
              border: '1px solid var(--border)',
            }}
          />
          <button
            onClick={() => void create()}
            disabled={!name.trim() || creating}
            className="flex items-center gap-1.5 text-xs font-medium px-4 py-2 rounded-lg transition-all flex-shrink-0"
            style={{
              background: name.trim() && !creating ? 'var(--accent)' : 'var(--surface-strong)',
              color: name.trim() && !creating ? '#0d1b2f' : 'var(--subtle)',
              cursor: name.trim() && !creating ? 'pointer' : 'not-allowed',
            }}
          >
            <Plus size={12} />
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>

      {/* List */}
      <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
        {loading ? (
          <div className="px-5 py-8 text-center text-sm" style={{ color: 'var(--subtle)' }}>
            Loading clients…
          </div>
        ) : clients.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm" style={{ color: 'var(--subtle)' }}>
            No agent clients yet. Create one to get started.
          </div>
        ) : (
          clients.map((c) => (
            <div key={c.clientId} className="px-5 py-3.5 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span
                    className="text-sm font-medium"
                    style={{ color: c.revoked ? 'var(--subtle)' : 'var(--ink)', textDecoration: c.revoked ? 'line-through' : undefined }}
                  >
                    {c.name}
                  </span>
                  {c.revoked && (
                    <span
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(232,109,122,0.12)', color: 'var(--danger)' }}
                    >
                      revoked
                    </span>
                  )}
                </div>
                {c.description && (
                  <p className="text-xs truncate" style={{ color: 'var(--subtle)' }}>{c.description}</p>
                )}
                <p className="mono text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                  {c.clientId} · {relTime(c.createdAt)}
                </p>
              </div>
              {!c.revoked && (
                <button
                  onClick={() => void revoke(c.clientId)}
                  className="flex-shrink-0 p-2 rounded-lg transition-all"
                  style={{ background: 'transparent', color: 'var(--danger)', border: '1px solid var(--border)' }}
                  title="Revoke client"
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
