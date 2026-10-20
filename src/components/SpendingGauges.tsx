/**
 * SpendingGauges — per-wallet and global remaining daily / per-call limits.
 */
import { useEffect, useState } from 'react';
import { TrendingUp, DollarSign } from 'lucide-react';

interface LimitStats {
  perCallLimit: string;
  dailyLimit: string;
  spentToday: string;
  remainingToday: string;
  percentUsed: string;
  killSwitch: boolean;
  requireAllowlist: boolean;
  allowlistEnabled: boolean;
  allowedAddresses: string[];
  allowedContracts: string[];
  agentMode: string;
  arcNetwork: string;
  enforceBinding: boolean;
}

function GaugeBar({ percent, danger }: { percent: number; danger: boolean }) {
  return (
    <div
      className="h-1.5 rounded-full overflow-hidden"
      style={{ background: 'var(--surface-strong)' }}
    >
      <div
        className="h-full rounded-full transition-all"
        style={{
          width: `${Math.min(percent, 100)}%`,
          background: danger ? 'var(--danger)' : percent > 70 ? '#f59e0b' : 'var(--success)',
        }}
      />
    </div>
  );
}

function StatRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between py-2" style={{ borderBottom: '1px solid var(--border)' }}>
      <span className="text-xs" style={{ color: 'var(--subtle)' }}>{label}</span>
      <div className="text-right">
        <span className="mono text-sm tabular-nums font-medium" style={{ color: 'var(--ink)' }}>{value}</span>
        {sub && <span className="text-xs ml-1" style={{ color: 'var(--subtle)' }}>{sub}</span>}
      </div>
    </div>
  );
}

export default function SpendingGauges() {
  const [stats, setStats] = useState<LimitStats | null>(null);

  useEffect(() => {
    const load = () => {
      fetch('/api/limits')
        .then((res) => (res.ok ? (res.json() as Promise<LimitStats>) : Promise.reject(new Error('fetch failed'))))
        .then(setStats)
        .catch(() => { /* backend offline */ });
    };
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, []);

  const pct = stats ? parseFloat(stats.percentUsed) : 0;
  const danger = stats?.killSwitch || pct >= 100;

  return (
    <div
      className="rounded-2xl p-5 flex flex-col gap-4"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <TrendingUp size={15} style={{ color: 'var(--accent)' }} />
          <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--accent)' }}>
            Spending
          </span>
        </div>
        <span
          className="text-xs px-2 py-0.5 rounded-full mono"
          style={{
            background: danger ? 'rgba(232,109,122,0.12)' : 'var(--surface-strong)',
            color: danger ? 'var(--danger)' : 'var(--muted)',
            border: `1px solid ${danger ? 'var(--danger)' : 'var(--border)'}`,
          }}
        >
          {stats ? `${stats.arcNetwork}` : '…'}
        </span>
      </div>

      {stats ? (
        <>
          {/* Daily gauge */}
          <div>
            <div className="flex justify-between mb-1.5">
              <span className="text-xs" style={{ color: 'var(--subtle)' }}>Daily budget</span>
              <span className="mono text-xs tabular-nums" style={{ color: 'var(--ink-2)' }}>
                {parseFloat(stats.spentToday).toFixed(4)} / {stats.dailyLimit} USDC
              </span>
            </div>
            <GaugeBar percent={pct} danger={danger} />
            <div className="flex justify-between mt-1">
              <span className="text-xs" style={{ color: 'var(--subtle)' }}>{pct.toFixed(1)}% used</span>
              <span className="text-xs" style={{ color: pct >= 90 ? 'var(--danger)' : 'var(--subtle)' }}>
                {parseFloat(stats.remainingToday).toFixed(4)} USDC remaining
              </span>
            </div>
          </div>

          {/* Stats rows */}
          <div>
            <StatRow label="Per-call cap" value={`${stats.perCallLimit} USDC`} />
            <StatRow label="Agent mode" value={stats.agentMode} />
            <StatRow
              label="Address allowlist"
              value={stats.allowlistEnabled
                ? `${stats.allowedAddresses.length} addresses`
                : stats.requireAllowlist ? 'required — empty' : 'disabled'}
            />
            <StatRow
              label="Contract allowlist"
              value={stats.allowedContracts.length > 0
                ? `${stats.allowedContracts.length} contracts`
                : 'empty — writes blocked'}
            />
            <div className="flex items-baseline justify-between py-2">
              <span className="text-xs" style={{ color: 'var(--subtle)' }}>Op binding</span>
              <span
                className="text-xs px-2 py-0.5 rounded-full"
                style={{
                  background: stats.enforceBinding ? 'rgba(141,216,159,0.12)' : 'var(--surface-strong)',
                  color: stats.enforceBinding ? 'var(--success)' : 'var(--muted)',
                  border: `1px solid ${stats.enforceBinding ? 'var(--success)' : 'var(--border)'}`,
                }}
              >
                {stats.enforceBinding ? 'enabled' : 'disabled'}
              </span>
            </div>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--subtle)' }}>
          <DollarSign size={13} />
          Start the API server to see live limits.
        </div>
      )}
    </div>
  );
}
