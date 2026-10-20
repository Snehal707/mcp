/**
 * Arc MCP Control Plane — Phase 4 dashboard.
 *
 * Tabs:
 *   Overview  — WalletInfo + SpendingGauges + KillSwitch
 *   Activity  — Live tool-call log with filters + export
 *   Clients   — Agent client management (create / revoke)
 *   Grants    — Tool-capability grants per client
 *   Setup     — Quick-start guide for connecting AI agents
 */
import { useState } from 'react';
import { ConnectKitButton } from 'connectkit';
import {
  Zap, LayoutDashboard, Activity, Users, Key, Terminal, BookOpen,
} from 'lucide-react';
import WalletInfo from './components/WalletInfo';
import SpendingGauges from './components/SpendingGauges';
import KillSwitch from './components/KillSwitch';
import ActivityLog from './components/ActivityLog';
import Clients from './components/Clients';
import Grants from './components/Grants';

// ── Setup tab content ─────────────────────────────────────────────────────────

const CONFIG_SNIPPETS = [
  {
    label: 'Claude Desktop',
    file: '~/Library/Application Support/Claude/claude_desktop_config.json',
    code: `{
  "mcpServers": {
    "arc": {
      "command": "node",
      "args": ["/path/to/mcp/dist/server.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "ARC_NETWORK": "testnet",
        "AGENT_MODE": "unsigned",
        "PER_CALL_LIMIT_USDC": "10",
        "DAILY_LIMIT_USDC": "100"
      }
    }
  }
}`,
  },
  {
    label: 'Cursor',
    file: '~/.cursor/mcp.json',
    code: `{
  "mcpServers": {
    "arc": {
      "command": "node",
      "args": ["/path/to/mcp/dist/server.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "ARC_NETWORK": "testnet",
        "AGENT_MODE": "unsigned"
      }
    }
  }
}`,
  },
  {
    label: 'HTTP / ChatGPT',
    file: 'Any agent with SSE support',
    code: `# Start in HTTP mode
MCP_TRANSPORT=http MCP_PORT=3456 node dist/server.js

# SSE endpoint:  http://localhost:3456/sse
# Health check:  curl http://localhost:3456/health`,
  },
];

const ALL_TOOLS = [
  { tool: 'get_usdc_balance', desc: 'Check USDC balance for any Arc address', phase: 0 },
  { tool: 'transfer_usdc', desc: 'Send USDC with per-call + daily limits', phase: 0 },
  { tool: 'call_contract_read', desc: 'Read-only view/pure contract calls', phase: 0 },
  { tool: 'call_contract_write', desc: 'State-changing contract calls', phase: 0 },
  { tool: 'get_transaction_status', desc: 'Check tx confirmation on Arc', phase: 0 },
  { tool: 'create_agent_wallet', desc: 'Create a Circle Agent Wallet', phase: 1 },
  { tool: 'list_agent_wallets', desc: 'List your Circle Agent Wallets', phase: 1 },
  { tool: 'get_agent_policy', desc: 'Read wallet spending policy', phase: 1 },
  { tool: 'set_agent_policy', desc: 'Set wallet spending policy (mainnet only)', phase: 1 },
  { tool: 'transfer_usdc_agent', desc: 'Transfer via Circle Agent Wallet', phase: 1 },
  { tool: 'pay_x402', desc: 'Pay an x402/nanopayment endpoint', phase: 3 },
  { tool: 'discover_x402_services', desc: 'Search Circle Agent Marketplace', phase: 3 },
  { tool: 'job_create', desc: 'Create an ERC-8183 agent job', phase: 2 },
  { tool: 'job_fund', desc: 'Fund a job with USDC', phase: 2 },
  { tool: 'job_submit', desc: 'Submit deliverable hash', phase: 2 },
  { tool: 'job_complete', desc: 'Complete job, release payment', phase: 2 },
  { tool: 'job_get', desc: 'Read job state (read-only)', phase: 2 },
];

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre
        className="mono text-xs rounded-xl p-4 overflow-x-auto leading-relaxed"
        style={{ background: 'var(--surface-muted)', color: 'var(--ink-2)', border: '1px solid var(--border)' }}
      >
        {code}
      </pre>
      <button
        onClick={() => {
          navigator.clipboard.writeText(code).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="absolute top-2 right-2 text-xs px-2.5 py-1 rounded-lg transition-all"
        style={{
          background: 'var(--surface-strong)',
          color: copied ? 'var(--success)' : 'var(--muted)',
          border: '1px solid var(--border)',
        }}
      >
        {copied ? 'copied!' : 'copy'}
      </button>
    </div>
  );
}

// ── Tab definitions ───────────────────────────────────────────────────────────

type TabId = 'overview' | 'activity' | 'clients' | 'grants' | 'setup';

const TABS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={14} /> },
  { id: 'activity', label: 'Activity', icon: <Activity size={14} /> },
  { id: 'clients', label: 'Clients', icon: <Users size={14} /> },
  { id: 'grants', label: 'Grants', icon: <Key size={14} /> },
  { id: 'setup', label: 'Setup', icon: <Terminal size={14} /> },
];

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState<TabId>('overview');
  const [activeSnippet, setActiveSnippet] = useState(0);

  return (
    <div className="min-h-dvh" style={{ background: 'var(--bg-gradient)' }}>
      {/* Header */}
      <header
        className="sticky top-0 z-20 px-6 py-3.5 flex items-center justify-between"
        style={{
          background: 'rgba(13, 27, 47, 0.85)',
          backdropFilter: 'blur(16px)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--accent)', color: '#0d1b2f' }}
          >
            <Zap size={15} />
          </div>
          <div>
            <h1 className="display text-sm font-semibold leading-tight" style={{ color: 'var(--ink)' }}>
              Arc MCP Control Plane
            </h1>
            <p className="text-xs leading-tight" style={{ color: 'var(--subtle)' }}>
              AI agent tooling · Arc Testnet · USDC as gas
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="https://docs.arc.io"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:flex items-center gap-1.5 text-xs opacity-70 hover:opacity-100 transition-opacity"
            style={{ color: 'var(--accent)' }}
          >
            <BookOpen size={12} />
            Arc Docs
          </a>
          <ConnectKitButton />
        </div>
      </header>

      {/* Tab nav */}
      <div
        className="sticky top-[57px] z-10 px-6 flex items-center gap-1 overflow-x-auto"
        style={{
          background: 'rgba(13, 27, 47, 0.75)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        {TABS.map(({ id, label, icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-3 whitespace-nowrap border-b-2 transition-all"
            style={{
              color: tab === id ? 'var(--ink)' : 'var(--subtle)',
              borderBottomColor: tab === id ? 'var(--accent)' : 'transparent',
            }}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {/* ── Overview ─────────────────────────────────────── */}
        {tab === 'overview' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              <div className="lg:col-span-2">
                <WalletInfo />
              </div>
              <div className="space-y-5">
                <KillSwitch />
                <SpendingGauges />
              </div>
            </div>
            {/* Mini activity preview */}
            <ActivityLog />
          </div>
        )}

        {/* ── Activity ─────────────────────────────────────── */}
        {tab === 'activity' && <ActivityLog />}

        {/* ── Clients ──────────────────────────────────────── */}
        {tab === 'clients' && (
          <div className="space-y-5">
            <Clients />
            <div
              className="rounded-xl px-5 py-4 text-xs"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--subtle)' }}
            >
              <strong style={{ color: 'var(--ink-2)' }}>How clients work:</strong> Each client represents one integration (e.g. "Claude Desktop" or "Research Bot"). When you create a client, you get a one-time client key. Pass that key as the <code className="mono">clientId</code> argument in your agent config. Revoking a client immediately blocks all its grants.
            </div>
          </div>
        )}

        {/* ── Grants ───────────────────────────────────────── */}
        {tab === 'grants' && (
          <div className="space-y-5">
            <Grants />
            <div
              className="rounded-xl px-5 py-4 text-xs"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--subtle)' }}
            >
              <strong style={{ color: 'var(--ink-2)' }}>How grants work:</strong> A grant links a client to specific tools and optionally narrows the per-call or daily spending limit. Approval mode "above limit" pauses calls that would exceed the grant's per-call cap. "Always approve" requires human confirmation for every write tool call. Revoking a grant stops those tools immediately without affecting the client or other grants.
            </div>
          </div>
        )}

        {/* ── Setup ────────────────────────────────────────── */}
        {tab === 'setup' && (
          <div
            className="rounded-2xl p-6"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-2 mb-6">
              <Terminal size={15} style={{ color: 'var(--accent)' }} />
              <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--accent)' }}>
                Connect an AI agent
              </span>
            </div>

            {/* Steps */}
            <ol className="text-sm space-y-3 mb-7" style={{ color: 'var(--muted)' }}>
              {[
                <>Copy <code className="mono text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--surface-muted)' }}>mcp/env.example.txt</code> to <code className="mono text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--surface-muted)' }}>mcp/.env</code> and fill in your limits.</>,
                <>Build: <code className="mono text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--surface-muted)' }}>cd mcp && bun install && bun run build</code></>,
                <>Get test USDC from the "Get test USDC" button in the Arc Studio sidebar.</>,
                <>Create a client in the Clients tab, then a grant in the Grants tab.</>,
                <>Paste the config below into your agent and restart it.</>,
              ].map((step, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span
                    className="display flex-shrink-0 w-5 h-5 rounded-full text-xs font-bold flex items-center justify-center mt-0.5"
                    style={{ background: 'var(--surface-strong)', color: 'var(--accent)', border: '1px solid var(--border-strong)' }}
                  >
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>

            {/* Config tabs */}
            <div className="flex gap-1.5 mb-4 flex-wrap">
              {CONFIG_SNIPPETS.map((s, i) => (
                <button
                  key={i}
                  onClick={() => setActiveSnippet(i)}
                  className="text-xs px-3 py-1.5 rounded-full transition-all"
                  style={{
                    background: activeSnippet === i ? 'var(--surface-strong)' : 'transparent',
                    color: activeSnippet === i ? 'var(--ink)' : 'var(--subtle)',
                    border: `1px solid ${activeSnippet === i ? 'var(--border-strong)' : 'var(--border)'}`,
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <p className="text-xs mb-3" style={{ color: 'var(--subtle)' }}>
              File: <code className="mono px-1.5 py-0.5 rounded" style={{ background: 'var(--surface-muted)' }}>
                {CONFIG_SNIPPETS[activeSnippet].file}
              </code>
            </p>
            <CodeBlock code={CONFIG_SNIPPETS[activeSnippet].code} />

            {/* Tool reference */}
            <div className="mt-7">
              <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--subtle)' }}>
                Available tools ({ALL_TOOLS.length})
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {ALL_TOOLS.map(({ tool, desc, phase }) => (
                  <div
                    key={tool}
                    className="rounded-xl p-3"
                    style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      <code className="mono text-xs font-medium" style={{ color: 'var(--accent)' }}>{tool}</code>
                      <span
                        className="text-xs px-1.5 py-0.5 rounded mono"
                        style={{ background: 'var(--surface-strong)', color: 'var(--subtle)' }}
                      >
                        P{phase}
                      </span>
                    </div>
                    <p className="text-xs" style={{ color: 'var(--subtle)' }}>{desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
