/**
 * Arc MCP Server entry point.
 *
 * Registers five tools and exposes them over stdio (for Claude Desktop / Cursor)
 * and/or HTTP + SSE (for remote agents and ChatGPT plugins), controlled by
 * the MCP_TRANSPORT environment variable.
 *
 * Usage:
 *   MCP_TRANSPORT=stdio  node dist/server.js   # Claude Desktop / Cursor
 *   MCP_TRANSPORT=http   node dist/server.js   # Remote agents
 *   MCP_TRANSPORT=both   node dist/server.js   # Dev (default)
 */
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import { isKillSwitchActive } from './spending-limits.js';
import { authMiddleware, rateLimiter, adminAuthMiddleware } from './auth.js';

// ── Tool imports ──────────────────────────────────────────────────────────────
import * as getUsdcBalance from './tools/get-usdc-balance.js';
import * as transferUsdc from './tools/transfer-usdc.js';
import * as callContractRead from './tools/call-contract-read.js';
import * as callContractWrite from './tools/call-contract-write.js';
import * as getTransactionStatus from './tools/get-transaction-status.js';
// Phase 1: Circle Agent Wallet tools
import * as createAgentWallet from './tools/create-agent-wallet.js';
import * as listAgentWallets from './tools/list-agent-wallets.js';
import * as getAgentPolicy from './tools/get-agent-policy.js';
import * as setAgentPolicy from './tools/set-agent-policy.js';
import * as transferUsdcAgent from './tools/transfer-usdc-agent.js';
// Phase 3: x402 / nanopayment tools
import * as payX402 from './tools/pay-x402.js';
import * as discoverX402Services from './tools/discover-x402-services.js';
// Phase 5: system status + audit export tools
import * as getSystemStatus from './tools/get-system-status.js';
import * as exportAuditLog from './tools/export-audit-log.js';
// Phase 2: ERC-8183 job tools
import * as jobGet from './tools/jobs/job-get.js';
import * as jobCreate from './tools/jobs/job-create.js';
import * as jobSetBudget from './tools/jobs/job-set-budget.js';
import * as jobApproveUsdc from './tools/jobs/job-approve-usdc.js';
import * as jobFund from './tools/jobs/job-fund.js';
import * as jobSubmit from './tools/jobs/job-submit.js';
import * as jobComplete from './tools/jobs/job-complete.js';
import * as jobReject from './tools/jobs/job-reject.js';
import * as jobClaimRefund from './tools/jobs/job-claim-refund.js';

// ── Config ────────────────────────────────────────────────────────────────────
const TRANSPORT = (process.env.MCP_TRANSPORT ?? 'both').toLowerCase();
const HTTP_PORT = parseInt(process.env.MCP_PORT ?? '3456', 10);
const AGENT_MODE = (process.env.AGENT_MODE ?? 'unsigned').toLowerCase();
const ARC_NETWORK = (process.env.ARC_NETWORK ?? 'testnet').toLowerCase();

// ── Phase 0 startup warnings ──────────────────────────────────────────────────
// Always emit to stderr regardless of transport so operators see policy state.

if (ARC_NETWORK === 'mainnet') {
  console.error(
    'WARNING: MAINNET MODE — real USDC will be moved. ' +
      'All transactions are irreversible. Ensure allowlists and limits are correctly configured.',
  );
}

if (isKillSwitchActive()) {
  console.error('KILL SWITCH ACTIVE — all write operations (transfer_usdc, call_contract_write) are blocked.');
}

if (process.env.REQUIRE_ALLOWLIST !== 'false' && !process.env.ALLOWED_ADDRESSES?.trim()) {
  console.error(
    'WARNING: Address allowlist is required (REQUIRE_ALLOWLIST=true) but ALLOWED_ADDRESSES is empty. ' +
      'All transfer_usdc calls will be rejected until ALLOWED_ADDRESSES is populated or REQUIRE_ALLOWLIST=false.',
  );
}

// ── Banner ────────────────────────────────────────────────────────────────────
if (TRANSPORT !== 'stdio') {
  console.error(`
╔══════════════════════════════════════════════════════════════════╗
║          Arc MCP Server — Circle + Viem + Arc Testnet           ║
╠══════════════════════════════════════════════════════════════════╣
║  Network    : Arc ${ARC_NETWORK.padEnd(45)}║
║  Agent mode : ${AGENT_MODE.padEnd(50)}║
║  Transport  : ${TRANSPORT.padEnd(50)}║
${TRANSPORT !== 'stdio' ? `║  HTTP port  : ${String(HTTP_PORT).padEnd(50)}║\n` : ''}╚══════════════════════════════════════════════════════════════════╝

  Phase 0 policy (all enforced server-side):
    • Kill switch       : ${isKillSwitchActive() ? 'ACTIVE — writes blocked' : 'inactive'}
    • AGENT_MODE        : ${AGENT_MODE} ${AGENT_MODE === 'unsigned' ? '(no keys stored — human signs)' : AGENT_MODE === 'circle_agent' ? '(Circle Agent Wallets via CLI)' : '(Circle Dev-Controlled Wallets)'}
    • Per-call cap      : ${process.env.PER_CALL_LIMIT_USDC ?? '10'} USDC
    • Daily limit       : ${process.env.DAILY_LIMIT_USDC ?? '100'} USDC
    • Address allowlist : ${process.env.ALLOWED_ADDRESSES ? 'enabled' : process.env.REQUIRE_ALLOWLIST === 'false' ? 'disabled (REQUIRE_ALLOWLIST=false)' : 'REQUIRED — empty — writes blocked'}
    • Contract allowlist: ${process.env.ALLOWED_CONTRACTS ? 'enabled' : 'empty — contract writes blocked'}
    • Selector allowlist: ${process.env.ALLOWED_SELECTORS ? 'enabled' : 'disabled (all selectors allowed)'}
    • Op binding        : ${process.env.ENFORCE_OPERATION_BINDING !== 'false' ? 'enabled' : 'disabled'}

  Register entity secret (circle mode): https://developers.circle.com/wallets/dev-controlled/register-entity-secret
`);
}

// ── MCP server factory ────────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'arc-mcp-server',
    version: '1.0.0',
  });

  // get_usdc_balance
  server.tool(
    getUsdcBalance.name,
    getUsdcBalance.description,
    getUsdcBalance.inputSchema.shape,
    async (input) => {
      const text = await getUsdcBalance.handler(input as Parameters<typeof getUsdcBalance.handler>[0]);
      return { content: [{ type: 'text', text }] };
    },
  );

  // transfer_usdc
  server.tool(
    transferUsdc.name,
    transferUsdc.description,
    transferUsdc.inputSchema.shape,
    async (input) => {
      const text = await transferUsdc.handler(input as Parameters<typeof transferUsdc.handler>[0]);
      return { content: [{ type: 'text', text }] };
    },
  );

  // call_contract_read
  server.tool(
    callContractRead.name,
    callContractRead.description,
    callContractRead.inputSchema.shape,
    async (input) => {
      const text = await callContractRead.handler(input as Parameters<typeof callContractRead.handler>[0]);
      return { content: [{ type: 'text', text }] };
    },
  );

  // call_contract_write
  server.tool(
    callContractWrite.name,
    callContractWrite.description,
    callContractWrite.inputSchema.shape,
    async (input) => {
      const text = await callContractWrite.handler(input as Parameters<typeof callContractWrite.handler>[0]);
      return { content: [{ type: 'text', text }] };
    },
  );

  // get_transaction_status
  server.tool(
    getTransactionStatus.name,
    getTransactionStatus.description,
    getTransactionStatus.inputSchema.shape,
    async (input) => {
      const text = await getTransactionStatus.handler(input as Parameters<typeof getTransactionStatus.handler>[0]);
      return { content: [{ type: 'text', text }] };
    },
  );

  // ── Phase 1: Circle Agent Wallet tools ────────────────────────────────────

  // create_agent_wallet
  server.tool(
    createAgentWallet.name,
    createAgentWallet.description,
    createAgentWallet.inputSchema.shape,
    async (input) => {
      const text = await createAgentWallet.handler(input as Parameters<typeof createAgentWallet.handler>[0]);
      return { content: [{ type: 'text', text }] };
    },
  );

  // list_agent_wallets
  server.tool(
    listAgentWallets.name,
    listAgentWallets.description,
    listAgentWallets.inputSchema.shape,
    async (input) => {
      const text = await listAgentWallets.handler(input as Parameters<typeof listAgentWallets.handler>[0]);
      return { content: [{ type: 'text', text }] };
    },
  );

  // get_agent_policy
  server.tool(
    getAgentPolicy.name,
    getAgentPolicy.description,
    getAgentPolicy.inputSchema.shape,
    async (input) => {
      const text = await getAgentPolicy.handler(input as Parameters<typeof getAgentPolicy.handler>[0]);
      return { content: [{ type: 'text', text }] };
    },
  );

  // set_agent_policy
  server.tool(
    setAgentPolicy.name,
    setAgentPolicy.description,
    setAgentPolicy.inputSchema.shape,
    async (input) => {
      const text = await setAgentPolicy.handler(input as Parameters<typeof setAgentPolicy.handler>[0]);
      return { content: [{ type: 'text', text }] };
    },
  );

  // transfer_usdc_agent
  server.tool(
    transferUsdcAgent.name,
    transferUsdcAgent.description,
    transferUsdcAgent.inputSchema.shape,
    async (input) => {
      const text = await transferUsdcAgent.handler(input as Parameters<typeof transferUsdcAgent.handler>[0]);
      return { content: [{ type: 'text', text }] };
    },
  );

  // ── Phase 5: system status + audit export ────────────────────────────────

  server.tool(
    getSystemStatus.name,
    getSystemStatus.description,
    getSystemStatus.inputSchema.shape,
    async (input) => {
      const text = await getSystemStatus.handler(input as Parameters<typeof getSystemStatus.handler>[0]);
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    exportAuditLog.name,
    exportAuditLog.description,
    exportAuditLog.inputSchema.shape,
    async (input) => {
      const text = await exportAuditLog.handler(input as Parameters<typeof exportAuditLog.handler>[0]);
      return { content: [{ type: 'text', text }] };
    },
  );

  // ── Phase 3: x402 / nanopayment tools ────────────────────────────────────

  // pay_x402
  server.tool(
    payX402.name,
    payX402.description,
    payX402.inputSchema.shape,
    async (input) => {
      const text = await payX402.handler(input as Parameters<typeof payX402.handler>[0]);
      return { content: [{ type: 'text', text }] };
    },
  );

  // discover_x402_services
  server.tool(
    discoverX402Services.name,
    discoverX402Services.description,
    discoverX402Services.inputSchema.shape,
    async (input) => {
      const text = await discoverX402Services.handler(
        input as Parameters<typeof discoverX402Services.handler>[0],
      );
      return { content: [{ type: 'text', text }] };
    },
  );

  // ── Phase 2: ERC-8183 job tools ───────────────────────────────────────────

  for (const tool of [
    jobGet, jobCreate, jobSetBudget, jobApproveUsdc, jobFund,
    jobSubmit, jobComplete, jobReject, jobClaimRefund,
  ] as Array<{
    name: string;
    description: string;
    inputSchema: { shape: Record<string, unknown> };
    handler: (input: unknown) => Promise<string>;
  }>) {
    server.tool(
      tool.name,
      tool.description,
      tool.inputSchema.shape,
      async (input) => {
        const text = await tool.handler(input);
        return { content: [{ type: 'text', text }] };
      },
    );
  }

  return server;
}

// ── stdio transport ───────────────────────────────────────────────────────────

async function startStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio mode: no console.log — stdout is the MCP wire
}

// ── HTTP + SSE transport ──────────────────────────────────────────────────────

async function startHttp(): Promise<void> {
  const app = express();
  app.use(express.json());

  // ── Phase 5: global rate limiter (all routes) ─────────────────────────────
  app.use(rateLimiter('global'));

  // ── Phase 5: authentication (skips /health) ───────────────────────────────
  app.use(authMiddleware);

  // ── Phase 5: tighter write-path rate limit (SSE + message) ───────────────
  app.use(['/sse', '/message'], rateLimiter('write'));

  // ── Phase 5: admin routes (kill switch, export) ───────────────────────────
  // These are also served from the dashboard API server (server/api.ts) but
  // are additionally available here for operators who talk directly to the MCP
  // HTTP port without running the dashboard backend.
  const admin = express.Router();
  admin.use(adminAuthMiddleware);

  admin.get('/status', async (_req, res) => {
    const text = await getSystemStatus.handler({});
    res.json(JSON.parse(text) as unknown);
  });

  admin.get('/audit', async (req, res) => {
    const { from, to, tool: t, clientId, status: s, limit, format } = req.query as Record<string, string>;
    const text = await exportAuditLog.handler({
      from:     from     || undefined,
      to:       to       || undefined,
      tool:     t        || undefined,
      clientId: clientId || undefined,
      status:   (s as 'completed' | 'rejected' | 'error' | 'blocked') || undefined,
      limit:    limit ? parseInt(limit, 10) : 500,
      format:   (format === 'csv' ? 'csv' : 'json'),
    });
    if (format === 'csv') {
      res.setHeader('Content-Disposition', 'attachment; filename="arc-mcp-audit.csv"');
      res.setHeader('Content-Type', 'text/csv');
      res.send(text);
    } else {
      res.json(JSON.parse(text) as unknown);
    }
  });

  app.use('/admin', admin);

  // ── Phase 5: startup log ──────────────────────────────────────────────────
  const authEnabled = Boolean(process.env['API_AUTH_TOKEN']?.trim());
  if (!authEnabled) {
    console.error(
      '[Arc MCP] WARNING: API_AUTH_TOKEN is not set. ' +
      'HTTP endpoint is unauthenticated. Set API_AUTH_TOKEN for production.',
    );
  }

  // Track active SSE transports keyed by session ID
  const sseTransports = new Map<string, SSEServerTransport>();

  // SSE endpoint — agents connect here to receive server-sent events
  app.get('/sse', (req, res) => {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const transport = new SSEServerTransport('/message', res);
    sseTransports.set(sessionId, transport);

    const server = createMcpServer();
    server.connect(transport).catch((err: unknown) => {
      console.error('MCP server error:', err);
    });

    // Clean up on disconnect
    res.on('close', () => {
      sseTransports.delete(sessionId);
    });

    console.error(`[Arc MCP] SSE client connected: ${sessionId}`);
  });

  // Message endpoint — agents POST JSON-RPC messages here
  app.post('/message', async (req, res) => {
    // Find the transport matching this session
    // In practice each SSE connection creates its own server instance
    // so we route by matching the res that /sse provided to /message.
    // The SSEServerTransport handles routing internally via its handlePostMessage.
    for (const transport of sseTransports.values()) {
      await transport.handlePostMessage(req, res);
      return;
    }
    res.status(503).json({ error: 'No active SSE session. Connect to /sse first.' });
  });

  // Health check / info endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      server: 'arc-mcp-server',
      version: '1.5.0',
      network: ARC_NETWORK,
      agentMode: AGENT_MODE,
      authEnabled: Boolean(process.env['API_AUTH_TOKEN']?.trim()),
      rateLimitMax: parseInt(process.env['RATE_LIMIT_MAX'] ?? '60', 10),
      killSwitch: isKillSwitchActive(),
      tools: [
        'get_usdc_balance',
        'transfer_usdc',
        'call_contract_read',
        'call_contract_write',
        'get_transaction_status',
        'create_agent_wallet',
        'list_agent_wallets',
        'get_agent_policy',
        'set_agent_policy',
        'transfer_usdc_agent',
        'pay_x402',
        'discover_x402_services',
        'get_system_status',
        'export_audit_log',
        'job_get',
        'job_create',
        'job_set_budget',
        'job_approve_usdc',
        'job_fund',
        'job_submit',
        'job_complete',
        'job_reject',
        'job_claim_refund',
      ],
      endpoints: {
        sse: `http://localhost:${HTTP_PORT}/sse`,
        message: `http://localhost:${HTTP_PORT}/message`,
        health: `http://localhost:${HTTP_PORT}/health`,
      },
    });
  });

  app.listen(HTTP_PORT, () => {
    console.error(`[Arc MCP] HTTP+SSE server listening on http://localhost:${HTTP_PORT}`);
    console.error(`[Arc MCP] SSE endpoint: http://localhost:${HTTP_PORT}/sse`);
    console.error(`[Arc MCP] Health check: http://localhost:${HTTP_PORT}/health`);
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (TRANSPORT === 'stdio') {
    await startStdio();
  } else if (TRANSPORT === 'http') {
    await startHttp();
  } else {
    // "both" — default for development
    await Promise.all([startStdio(), startHttp()]);
  }
}

main().catch((err) => {
  console.error('[Arc MCP] Fatal startup error:', err);
  process.exit(1);
});
