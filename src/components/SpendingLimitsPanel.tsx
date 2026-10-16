/**
 * SpendingLimitsPanel — displays current spending-limit configuration
 * and daily usage progress read from the tool-call log.
 */
import { ShieldCheck, AlertTriangle, Info } from 'lucide-react';

interface LimitStats {
  perCallLimit: string;
  dailyLimit: string;
  spentToday: string;
  remainingToday: string;
  allowlistEnabled: boolean;
  allowedAddresses: string[];
}

interface Props {
  stats: LimitStats;
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const isWarning = pct > 75;
  const isDanger = pct > 95;

  return (
    <div
      className="h-2 rounded-full overflow-hidden"
      style={{ background: 'var(--surface-muted)' }}
    >
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{
          width: `${pct}%`,
          background: isDanger
            ? 'var(--danger)'
            : isWarning
              ? '#f59e0b'
              : 'var(--success)',
        }}
      />
    </div>
  );
}

function LimitRow({
  label,
  value,
  secondary,
}: {
  label: string;
  value: string;
  secondary?: string;
}) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-sm" style={{ color: 'var(--muted)' }}>
        {label}
      </span>
      <div className="text-right">
        <span
          className="mono text-sm font-medium"
          style={{ color: 'var(--ink)' }}
        >
          {value} USDC
        </span>
        {secondary && (
          <span className="text-xs ml-2" style={{ color: 'var(--subtle)' }}>
            {secondary}
          </span>
        )}
      </div>
    </div>
  );
}

export default function SpendingLimitsPanel({ stats }: Props) {
  const spentNum = parseFloat(stats.spentToday);
  const dailyNum = parseFloat(stats.dailyLimit);
  const spentPct = dailyNum > 0 ? (spentNum / dailyNum) * 100 : 0;

  return (
    <div
      className="rounded-2xl p-6"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <div className="flex items-center gap-2 mb-5">
        <ShieldCheck size={16} style={{ color: 'var(--success)' }} />
        <span
          className="text-xs font-semibold uppercase tracking-widest"
          style={{ color: 'var(--success)' }}
        >
          Spending Limits
        </span>
      </div>

      {/* Daily progress */}
      <div className="mb-5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm" style={{ color: 'var(--muted)' }}>
            Today's spend
          </span>
          <span className="mono text-sm tabular-nums" style={{ color: 'var(--ink)' }}>
            {stats.spentToday} / {stats.dailyLimit} USDC
          </span>
        </div>
        <ProgressBar value={spentNum} max={dailyNum} />
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>
            Resets every 24 hours
          </span>
          <span
            className="text-xs tabular-nums"
            style={{
              color: spentPct > 75 ? 'var(--danger)' : 'var(--subtle)',
            }}
          >
            {stats.remainingToday} remaining
          </span>
        </div>
      </div>

      {/* Limits table */}
      <div
        className="divide-y"
        style={{ borderColor: 'var(--border)' }}
      >
        <LimitRow label="Per-call cap" value={stats.perCallLimit} />
        <LimitRow label="Daily rolling limit" value={stats.dailyLimit} />
      </div>

      {/* Allowlist */}
      <div
        className="mt-4 rounded-xl p-3.5"
        style={{ background: 'var(--surface-muted)' }}
      >
        <div className="flex items-start gap-2.5">
          {stats.allowlistEnabled ? (
            <ShieldCheck
              size={14}
              className="mt-0.5 flex-shrink-0"
              style={{ color: 'var(--success)' }}
            />
          ) : (
            <AlertTriangle
              size={14}
              className="mt-0.5 flex-shrink-0"
              style={{ color: '#f59e0b' }}
            />
          )}
          <div>
            <p className="text-xs font-medium" style={{ color: 'var(--ink-2)' }}>
              Address allowlist{' '}
              {stats.allowlistEnabled ? (
                <span style={{ color: 'var(--success)' }}>enabled</span>
              ) : (
                <span style={{ color: '#f59e0b' }}>disabled</span>
              )}
            </p>
            {stats.allowlistEnabled ? (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {stats.allowedAddresses.slice(0, 3).map((a) => (
                  <code
                    key={a}
                    className="mono text-xs px-2 py-0.5 rounded"
                    style={{
                      background: 'var(--surface)',
                      color: 'var(--ink-2)',
                    }}
                  >
                    {a.slice(0, 10)}…
                  </code>
                ))}
                {stats.allowedAddresses.length > 3 && (
                  <span
                    className="text-xs px-2 py-0.5 rounded"
                    style={{
                      background: 'var(--surface)',
                      color: 'var(--subtle)',
                    }}
                  >
                    +{stats.allowedAddresses.length - 3} more
                  </span>
                )}
              </div>
            ) : (
              <p className="text-xs mt-1" style={{ color: 'var(--subtle)' }}>
                Set <code className="mono">ALLOWED_ADDRESSES</code> in{' '}
                <code className="mono">mcp/env.txt</code> to restrict recipients.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Config hint */}
      <div className="mt-4 flex items-start gap-2">
        <Info size={13} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--subtle)' }} />
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>
          Edit limits in{' '}
          <code className="mono">mcp/env.txt</code> and restart the server to apply changes.
        </p>
      </div>
    </div>
  );
}
