/**
 * ActivityLog — real-time tool-call log with filters.
 * Polls /api/tool-log every 3s. Supports filter by tool, status, clientId.
 */
import { useEffect, useState, useCallback } from 'react';
import { Activity, Download, RefreshCw, Filter } from 'lucide-react';

interface LogEntry {
  timestamp?: string;
  tool?: string;
  clientId?: string;
  status?: string;
  amountUsdc?: string;
  to?: string;
  txHash?: string;
  binding?: { hash?: string; nonce?: string; timestamp?: number };
  error?: string;
}

const STATUS_COLORS: Record<string, string> = {
  completed: 'var(--success)',
  blocked: 'var(--danger)',
  rejected: 'var(--danger)',
  error: 'var(--danger)',
  pending: 'var(--accent)',
  unsigned: '#f59e0b',
};

function statusDot(status?: string) {
  const color = STATUS_COLORS[status ?? ''] ?? 'var(--subtle)';
  return (
    <span
      className="inline-block w-2 h-2 rounded-full flex-shrink-0"
      style={{ background: color }}
    />
  );
}

function shortHash(h?: string) {
  if (!h) return '—';
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

function relTime(ts?: string) {
  if (!ts) return '—';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return new Date(ts).toLocaleTimeString();
}

const ALL_TOOLS = [
  'get_usdc_balance', 'transfer_usdc', 'call_contract_read', 'call_contract_write',
  'get_transaction_status', 'create_agent_wallet', 'list_agent_wallets',
  'get_agent_policy', 'set_agent_policy', 'transfer_usdc_agent', 'pay_x402',
  'discover_x402_services', 'job_create', 'job_fund', 'job_submit', 'job_complete',
  'job_reject', 'job_claim_refund', 'job_get', 'job_set_budget', 'job_approve_usdc',
];

export default function ActivityLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterTool, setFilterTool] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams({ limit: '200' });
    if (filterTool) params.set('tool', filterTool);
    if (filterStatus) params.set('status', filterStatus);
    fetch(`/api/tool-log?${params.toString()}`)
      .then((res) => (res.ok ? (res.json() as Promise<LogEntry[]>) : Promise.reject(new Error('fetch failed'))))
      .then((data) => { setEntries(data.reverse()); })
      .catch(() => { /* backend offline */ })
      .finally(() => { setLoading(false); });
  }, [filterTool, filterStatus]);

  useEffect(() => {
    load();
    const id = setInterval(load, 3_000);
    return () => clearInterval(id);
  }, [load]);

  const exportLog = () => {
    const params = new URLSearchParams({ format: 'csv' });
    if (filterTool) params.set('tool', filterTool);
    if (filterStatus) params.set('status', filterStatus);
    window.open(`/api/export?${params.toString()}`, '_blank');
  };

  return (
    <div
      className="rounded-2xl"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      {/* Header */}
      <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2.5">
          <Activity size={15} style={{ color: 'var(--accent)' }} />
          <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--accent)' }}>
            Live Activity
          </span>
          <span
            className="text-xs px-2 py-0.5 rounded-full"
            style={{ background: 'var(--surface-strong)', color: 'var(--muted)', border: '1px solid var(--border)' }}
          >
            {entries.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFilters((v) => !v)}
            className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg transition-all"
            style={{
              background: showFilters ? 'var(--surface-strong)' : 'transparent',
              color: 'var(--muted)',
              border: '1px solid var(--border)',
            }}
          >
            <Filter size={11} /> Filters
          </button>
          <button
            onClick={exportLog}
            className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg transition-all"
            style={{ background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)' }}
          >
            <Download size={11} /> Export
          </button>
          <button
            onClick={() => void load()}
            className="p-1.5 rounded-lg transition-all"
            style={{ background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)' }}
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="px-5 py-3 flex flex-wrap gap-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <select
            value={filterTool}
            onChange={(e) => setFilterTool(e.target.value)}
            className="text-xs px-2.5 py-1.5 rounded-lg"
            style={{ background: 'var(--surface-muted)', color: 'var(--ink-2)', border: '1px solid var(--border)' }}
          >
            <option value="">All tools</option>
            {ALL_TOOLS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="text-xs px-2.5 py-1.5 rounded-lg"
            style={{ background: 'var(--surface-muted)', color: 'var(--ink-2)', border: '1px solid var(--border)' }}
          >
            <option value="">All statuses</option>
            {['completed', 'blocked', 'rejected', 'error', 'pending', 'unsigned'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          {(filterTool || filterStatus) && (
            <button
              onClick={() => { setFilterTool(''); setFilterStatus(''); }}
              className="text-xs px-2.5 py-1.5 rounded-lg"
              style={{ background: 'transparent', color: 'var(--danger)', border: '1px solid var(--border)' }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        {loading && entries.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm" style={{ color: 'var(--subtle)' }}>
            Loading activity log…
          </div>
        ) : entries.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm" style={{ color: 'var(--subtle)' }}>
            No tool calls recorded yet. Start the MCP server and connect an agent.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Time', 'Tool', 'Client', 'Status', 'Amount', 'To', 'Binding'].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-2.5 text-left font-medium uppercase tracking-wider"
                    style={{ color: 'var(--subtle)' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr
                  key={i}
                  className="transition-colors"
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <td className="mono px-4 py-2.5 whitespace-nowrap" style={{ color: 'var(--muted)' }}>
                    {relTime(e.timestamp)}
                  </td>
                  <td className="mono px-4 py-2.5 whitespace-nowrap font-medium" style={{ color: 'var(--ink-2)' }}>
                    {e.tool ?? '—'}
                  </td>
                  <td className="mono px-4 py-2.5 whitespace-nowrap" style={{ color: 'var(--subtle)' }}>
                    {e.clientId ? shortHash(e.clientId) : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-1.5">
                      {statusDot(e.status)}
                      <span style={{ color: STATUS_COLORS[e.status ?? ''] ?? 'var(--muted)' }}>
                        {e.status ?? '—'}
                      </span>
                    </span>
                  </td>
                  <td className="mono px-4 py-2.5 tabular-nums" style={{ color: 'var(--ink-2)' }}>
                    {e.amountUsdc ? `${e.amountUsdc} USDC` : '—'}
                  </td>
                  <td className="mono px-4 py-2.5 whitespace-nowrap" style={{ color: 'var(--subtle)' }}>
                    {e.to ? shortHash(e.to) : '—'}
                  </td>
                  <td className="mono px-4 py-2.5 whitespace-nowrap" style={{ color: 'var(--subtle)' }}>
                    {e.binding?.hash ? shortHash(e.binding.hash) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
