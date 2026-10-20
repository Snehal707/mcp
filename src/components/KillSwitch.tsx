/**
 * KillSwitch — prominent toggle that blocks all write tools immediately.
 * Calls POST /api/kill-switch { active: boolean }.
 */
import { useEffect, useState } from 'react';
import { ShieldOff, Shield, AlertTriangle } from 'lucide-react';

export default function KillSwitch() {
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    fetch('/api/kill-switch')
      .then((r) => (r.ok ? (r.json() as Promise<{ active?: boolean }>) : Promise.reject(new Error('fetch failed'))))
      .then((d) => { setActive(d.active ?? false); })
      .catch(() => {})
      .finally(() => { setLoading(false); });
  }, []);

  const toggle = async () => {
    if (updating) return;
    const next = !active;
    setUpdating(true);
    try {
      const res = await fetch('/api/kill-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: next }),
      });
      if (res.ok) setActive(next);
    } catch { /* ignore */ }
    finally { setUpdating(false); }
  };

  const danger = active;

  return (
    <div
      className="rounded-2xl p-5 flex flex-col gap-4"
      style={{
        background: danger
          ? 'rgba(232, 109, 122, 0.08)'
          : 'var(--surface)',
        border: `1px solid ${danger ? 'var(--danger)' : 'var(--border)'}`,
        transition: 'all 0.25s',
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          {danger
            ? <ShieldOff size={15} style={{ color: 'var(--danger)' }} />
            : <Shield size={15} style={{ color: 'var(--accent)' }} />
          }
          <span
            className="text-xs font-semibold uppercase tracking-widest"
            style={{ color: danger ? 'var(--danger)' : 'var(--accent)' }}
          >
            Kill Switch
          </span>
        </div>

        {/* Toggle */}
        <button
          onClick={() => void toggle()}
          disabled={loading || updating}
          aria-label={`Kill switch is ${active ? 'active' : 'inactive'}, click to ${active ? 'deactivate' : 'activate'}`}
          className="relative w-12 h-6 rounded-full transition-all flex-shrink-0"
          style={{
            background: danger ? 'var(--danger)' : 'var(--surface-strong)',
            border: '1px solid var(--border-strong)',
            opacity: loading || updating ? 0.5 : 1,
            cursor: loading || updating ? 'wait' : 'pointer',
          }}
        >
          <span
            className="absolute top-0.5 w-5 h-5 rounded-full transition-all"
            style={{
              background: danger ? '#fff' : 'var(--subtle)',
              left: danger ? 'calc(100% - 1.375rem)' : '0.125rem',
            }}
          />
        </button>
      </div>

      {danger && (
        <div
          className="flex items-start gap-2 text-xs rounded-xl px-3 py-2.5"
          style={{
            background: 'rgba(232, 109, 122, 0.12)',
            border: '1px solid var(--danger)',
            color: 'var(--danger)',
          }}
        >
          <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
          <span>
            <strong>All write tools are blocked.</strong> Agents cannot transfer USDC, call contracts, fund jobs, or pay x402 services until the kill switch is deactivated.
          </span>
        </div>
      )}

      {!danger && !loading && (
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>
          Activating the kill switch immediately blocks all agent write tools — no transaction can be sent until you deactivate it.
        </p>
      )}

      {loading && (
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>Loading…</p>
      )}
    </div>
  );
}
