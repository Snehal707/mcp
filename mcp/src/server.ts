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

// ── Tool imports ──────────────────────────────────────────────────────────────
import * as getUsdcBalance from './tools/get-usdc-balance.js';
import * as transferUsdc from './tools/transfer-usdc.js';
import * as callContractRead from './tools/call-contract-read.js';
import * as callContractWrite from './tools/call-contract-write.js';
import * as getTransactionStatus from './tools/get-transaction-status.js';

// ── Config ────────────────────────────────────────────────────────────────────
const TRANSPORT = (process.env.MCP_TRANSPORT ?? 'both').toLowerCase();
const HTTP_PORT = parseInt(process.env.MCP_PORT ?? '3456', 10);
const AGENT_MODE = (process.env.AGENT_MODE ?? 'unsigned').toLowerCase();
const ARC_NETWORK = (process.env.ARC_NETWORK ?? 'testnet').toLowerCase();

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

  Safe-by-default settings:
    • AGENT_MODE=unsigned  — server returns unsigned tx objects (no keys stored)
    • Spending limits enforced on all transfer/write calls
    • Per-call cap: ${process.env.PER_CALL_LIMIT_USDC ?? '10'} USDC
    • Daily limit : ${process.env.DAILY_LIMIT_USDC ?? '100'} USDC
    • Allowlist   : ${process.env.ALLOWED_ADDRESSES ? 'enabled' : 'disabled (any address)'}

  Switch to circle mode by setting AGENT_MODE=circle in the environment.
  Requires CIRCLE_API_KEY, ENTITY_SECRET, and CIRCLE_WALLET_ID.
  Register entity secret: https://developers.circle.com/wallets/dev-controlled/register-entity-secret
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
      version: '1.0.0',
      network: ARC_NETWORK,
      agentMode: AGENT_MODE,
      tools: [
        'get_usdc_balance',
        'transfer_usdc',
        'call_contract_read',
        'call_contract_write',
        'get_transaction_status',
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
