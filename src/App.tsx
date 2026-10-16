/**
 * Arc MCP Server Dashboard
 *
 * Infra-style management UI for the Arc MCP server:
 *   - Live agent wallet USDC balance on Arc Testnet
 *   - Spending-limit status with daily rolling progress
 *   - Real-time tool-call log
 *   - Quick-start guide for connecting AI agents
 */
import { useEffect, useState } from 'react';
import { ConnectKitButton } from 'connectkit';
import { Terminal, Zap, BookOpen, ExternalLink } from 'lucide-react';
import WalletInfo from './components/WalletInfo';
import SpendingLimitsPanel from './components/SpendingLimitsPanel';
import ToolCallLog from './components/ToolCallLog';

interface LimitStats {
  perCallLimit: string;
  dailyLimit: string;
  spentToday: string;
  remainingToday: string;
  allowlistEnabled: boolean;
  allowedAddresses: string[];
}

const DEFAULT_STATS: LimitStats = {
  perCallLimit: '10',
  dailyLimit: '100',
  spentToday: '0',
  remainingToday: '100',
  allowlistEnabled: false,
  allowedAddresses: [],
};

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
    label: 'HTTP (remote / ChatGPT)',
    file: 'Any agent with SSE support',
    code: `# Start the server in HTTP mode
MCP_TRANSPORT=http MCP_PORT=3456 node dist/server.js

# SSE endpoint for agents:
# http://localhost:3456/sse

# Health check:
# curl http://localhost:3456/health`,
  },
];

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre
        className="mono text-xs rounded-xl p-4 overflow-x-auto leading-relaxed"
        style={{
          background: 'var(--surface-muted)',
          color: 'var(--ink-2)',
          border: '1px solid var(--border)',
        }}
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

export default function App() {
  const [stats, setStats] = useState<LimitStats>(DEFAULT_STATS);
  const [activeSnippet, setActiveSnippet] = useState(0);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/limits');
        if (!res.ok) return;
        const data = (await res.json()) as LimitStats;
        setStats(data);
      } catch {
        // backend not running, show defaults
      }
    };
    void load();
    const interval = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className="min-h-dvh"
      style={{ background: 'var(--bg-gradient)' }}
    >
      {/* Header */}
      <header
        className="sticky top-0 z-20 px-6 py-4 flex items-center justify-between"
        style={{
          background: 'rgba(13, 27, 47, 0.80)',
          backdropFilter: 'blur(16px)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: 'var(--accent)', color: '#0d1b2f' }}
          >
            <Zap size={16} />
          </div>
          <div>
            <h1 className="display text-base font-semibold" style={{ color: 'var(--ink)' }}>
              Arc MCP Server
            </h1>
            <p className="text-xs" style={{ color: 'var(--subtle)' }}>
              AI agent tooling for Arc Testnet · USDC as gas
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="https://docs.arc.io"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs transition-opacity opacity-70 hover:opacity-100"
            style={{ color: 'var(--accent)' }}
          >
            <BookOpen size={13} />
            Arc Docs
          </a>
          <ConnectKitButton />
        </div>
      </header>

      {/* Main layout */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Top row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          <div className="lg:col-span-2">
            <WalletInfo />
          </div>
          <div>
            <SpendingLimitsPanel stats={stats} />
          </div>
        </div>

        {/* Tool call log */}
        <div className="mb-6">
          <ToolCallLog />
        </div>

        {/* Quick-start */}
        <div
          className="rounded-2xl p-6"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            backdropFilter: 'blur(12px)',
          }}
        >
          <div className="flex items-center gap-2 mb-5">
            <Terminal size={16} style={{ color: 'var(--accent)' }} />
            <span
              className="text-xs font-semibold uppercase tracking-widest"
              style={{ color: 'var(--accent)' }}
            >
              Connect an AI agent
            </span>
          </div>

          {/* Setup steps */}
          <ol
            className="text-sm space-y-3 mb-6"
            style={{ color: 'var(--muted)' }}
          >
            {[
              <>
                Copy{' '}
                <code
                  className="mono text-xs px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--surface-muted)' }}
                >
                  mcp/env.example.txt
                </code>{' '}
                to{' '}
                <code
                  className="mono text-xs px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--surface-muted)' }}
                >
                  mcp/.env
                </code>{' '}
                and fill in your limits.
              </>,
              <>
                Install and build:{' '}
                <code
                  className="mono text-xs px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--surface-muted)' }}
                >
                  cd mcp && bun install && bun run build
                </code>
              </>,
              <>
                Get testnet USDC from the{' '}
                <a
                  href="https://faucet.circle.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                  style={{ color: 'var(--accent)' }}
                >
                  Circle Faucet
                  <ExternalLink size={10} className="inline ml-0.5 -mt-0.5" />
                </a>
                .
              </>,
              'Add the config below to your AI agent and restart it.',
            ].map((step, i) => (
              <li key={i} className="flex items-start gap-3">
                <span
                  className="display flex-shrink-0 w-5 h-5 rounded-full text-xs font-bold flex items-center justify-center mt-0.5"
                  style={{
                    background: 'var(--surface-strong)',
                    color: 'var(--accent)',
                    border: '1px solid var(--border-strong)',
                  }}
                >
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>

          {/* Agent config tabs */}
          <div className="flex gap-1.5 mb-4 flex-wrap">
            {CONFIG_SNIPPETS.map((s, i) => (
              <button
                key={i}
                onClick={() => setActiveSnippet(i)}
                className="text-xs px-3 py-1.5 rounded-full transition-all"
                style={{
                  background:
                    activeSnippet === i
                      ? 'var(--surface-strong)'
                      : 'transparent',
                  color:
                    activeSnippet === i ? 'var(--ink)' : 'var(--subtle)',
                  border: `1px solid ${activeSnippet === i ? 'var(--border-strong)' : 'var(--border)'}`,
                }}
              >
                {s.label}
              </button>
            ))}
          </div>

          <p className="text-xs mb-3" style={{ color: 'var(--subtle)' }}>
            File:{' '}
            <code
              className="mono px-1.5 py-0.5 rounded"
              style={{ background: 'var(--surface-muted)' }}
            >
              {CONFIG_SNIPPETS[activeSnippet].file}
            </code>
          </p>

          <CodeBlock code={CONFIG_SNIPPETS[activeSnippet].code} />

          {/* Tools list */}
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {[
              {
                tool: 'get_usdc_balance',
                desc: 'Check USDC balance for any Arc address',
                safe: true,
              },
              {
                tool: 'transfer_usdc',
                desc: 'Send USDC with per-call + daily limits',
                safe: true,
              },
              {
                tool: 'call_contract_read',
                desc: 'Read-only view/pure contract calls',
                safe: true,
              },
              {
                tool: 'call_contract_write',
                desc: 'State-changing contract calls with limit guards',
                safe: true,
              },
              {
                tool: 'get_transaction_status',
                desc: 'Check tx confirmation on Arc or via Circle API',
                safe: true,
              },
            ].map(({ tool, desc }) => (
              <div
                key={tool}
                className="rounded-xl p-3.5"
                style={{
                  background: 'var(--surface-muted)',
                  border: '1px solid var(--border)',
                }}
              >
                <code
                  className="mono text-xs font-medium"
                  style={{ color: 'var(--accent)' }}
                >
                  {tool}
                </code>
                <p className="text-xs mt-1" style={{ color: 'var(--subtle)' }}>
                  {desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
