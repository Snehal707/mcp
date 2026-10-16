/**
 * ToolCallLog — table of recent MCP tool invocations.
 * Data is polled from the /api/tool-log endpoint (served by the backend proxy).
 * Falls back to a demo state when the server is not running.
 */
import { useEffect, useState } from 'react';
import { Activity, CheckCircle, XCircle, Clock, Filter } from 'lucide-react';

interface LogEntry {
  timestamp: string;
  tool: string;
  status: 'approved' | 'blocked' | 'completed' | 'failed';
  to?: string;
  address?: string;
  contractAddress?: string;
  amountUsdc?: string;
  txHash?: string;
  limitCode?: string;
  mode?: string;
  error?: string;
  [key: string]: unknown;
}

type FilterStatus = 'all' | 'completed' | 'blocked' | 'failed';

const TOOL_LABELS: Record<string, string> = {
  get_usdc_balance: 'Balance check',
  transfer_usdc: 'USDC transfer',
  call_contract_read: 'Contract read',
  call_contract_write: 'Contract write',
  get_transaction_status: 'Tx status',
};

const TOOL_COLORS: Record<string, string> = {
  get_usdc_balance: '#acc6e9',
  transfer_usdc: '#fbbf24',
  call_contract_read: '#8dd89f',
  call_contract_write: '#fb923c',
  get_transaction_status: '#c084fc',
};

function StatusBadge({ status }: { status: LogEntry['status'] }) {
  const config = {
    completed: { icon: CheckCircle, color: 'var(--success)', label: 'completed' },
    approved: { icon: Clock, color: '#fbbf24', label: 'approved' },
    blocked: { icon: XCircle, color: 'var(--danger)', label: 'blocked' },
    failed: { icon: XCircle, color: 'var(--danger)', label: 'failed' },
  }[status] ?? { icon: Clock, color: 'var(--subtle)', label: status };

  const Icon = config.icon;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-medium"
      style={{ color: config.color }}
    >
      <Icon size={11} />
      {config.label}
    </span>
  );
}

function ToolBadge({ tool }: { tool: string }) {
  return (
    <span
      className="inline-flex items-center text-xs font-medium mono px-2 py-0.5 rounded-full"
      style={{
        background: `${TOOL_COLORS[tool] ?? '#94a3b8'}18`,
        color: TOOL_COLORS[tool] ?? 'var(--subtle)',
        border: `1px solid ${TOOL_COLORS[tool] ?? 'var(--border)'}40`,
      }}
    >
      {TOOL_LABELS[tool] ?? tool}
    </span>
  );
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function ToolCallLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/tool-log');
        if (!res.ok) throw new Error('API not available');
        const data = (await res.json()) as LogEntry[];
        setEntries(data.reverse()); // most recent first
      } catch {
        // Server not running — show empty state
        setEntries([]);
      } finally {
        setLoading(false);
      }
    };

    void load();
    const interval = setInterval(() => { void load(); }, 5000); // poll every 5s
    return () => clearInterval(interval);
  }, []);

  const filtered =
    filter === 'all' ? entries : entries.filter((e) => e.status === filter);

  return (
    <div
      className="rounded-2xl p-6"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <Activity size={16} style={{ color: 'var(--accent)' }} />
          <span
            className="text-xs font-semibold uppercase tracking-widest"
            style={{ color: 'var(--accent)' }}
          >
            Agent tool calls
          </span>
        </div>
        {/* Filter chips */}
        <div className="flex items-center gap-1.5">
          <Filter size={11} style={{ color: 'var(--subtle)' }} />
          {(['all', 'completed', 'blocked', 'failed'] as FilterStatus[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="text-xs px-2.5 py-1 rounded-full transition-all"
              style={{
                background: filter === f ? 'var(--surface-strong)' : 'transparent',
                color: filter === f ? 'var(--ink)' : 'var(--subtle)',
                border: `1px solid ${filter === f ? 'var(--border-strong)' : 'transparent'}`,
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-14 rounded-xl animate-pulse"
              style={{ background: 'var(--surface-muted)' }}
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-16 text-center">
          <Activity
            size={32}
            className="mx-auto mb-3 opacity-30"
            style={{ color: 'var(--subtle)' }}
          />
          <p className="text-sm" style={{ color: 'var(--subtle)' }}>
            {entries.length === 0
              ? 'No tool calls yet. Connect an AI agent to start.'
              : 'No calls match this filter.'}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
          {filtered.map((entry, i) => (
            <div
              key={i}
              className="rounded-xl px-4 py-3 flex items-start gap-3"
              style={{
                background: 'var(--surface-muted)',
                border: '1px solid var(--border)',
              }}
            >
              {/* Time */}
              <span
                className="mono text-xs tabular-nums flex-shrink-0 pt-0.5"
                style={{ color: 'var(--subtle)' }}
              >
                {formatTs(entry.timestamp)}
              </span>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <ToolBadge tool={entry.tool} />
                  <StatusBadge status={entry.status} />
                  {entry.mode && (
                    <span
                      className="text-xs"
                      style={{ color: 'var(--subtle)' }}
                    >
                      · {entry.mode}
                    </span>
                  )}
                </div>

                <div className="mt-1 text-xs space-x-3" style={{ color: 'var(--subtle)' }}>
                  {entry.amountUsdc && (
                    <span className="tabular-nums">{entry.amountUsdc} USDC</span>
                  )}
                  {(entry.to ?? entry.address ?? entry.contractAddress) && (
                    <span className="mono truncate max-w-[160px] inline-block align-bottom">
                      {(entry.to ?? entry.address ?? entry.contractAddress ?? '').slice(0, 14)}…
                    </span>
                  )}
                  {entry.limitCode && (
                    <span style={{ color: 'var(--danger)' }}>
                      Blocked: {entry.limitCode}
                    </span>
                  )}
                  {entry.txHash && (
                    <a
                      href={`https://explorer.testnet.arc.io/tx/${entry.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mono underline"
                      style={{ color: 'var(--accent)' }}
                    >
                      {entry.txHash.slice(0, 10)}…
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {entries.length > 0 && (
        <p className="mt-3 text-xs text-center" style={{ color: 'var(--subtle)' }}>
          Showing {filtered.length} of {entries.length} calls · Auto-refreshes every 5s
        </p>
      )}
    </div>
  );
}
