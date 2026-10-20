/**
 * MCP Tool: get_system_status
 *
 * Returns a snapshot of the server's current operating state.
 * Read-only — no guards required (no funds move).
 */
import { z } from 'zod';
import { isKillSwitchActive, computeDailySpend, dailyStats } from '../spending-limits.js';

export const name = 'get_system_status';

export const description =
  'Returns the Arc MCP server operating state: network, kill-switch, daily spend, ' +
  'active policy config, and version. Read-only — no USDC moves.';

export const inputSchema = z.object({});

export async function handler(_input: z.infer<typeof inputSchema>): Promise<string> {
  const ARC_NETWORK = (process.env['ARC_NETWORK'] ?? 'testnet').toLowerCase();
  const AGENT_MODE  = (process.env['AGENT_MODE']  ?? 'unsigned').toLowerCase();
  const VERSION     = '1.5.0'; // Phase 5

  const dailySpentRaw = await Promise.resolve(computeDailySpend());
  const stats         = dailyStats();

  const result = {
    version: VERSION,
    network: ARC_NETWORK,
    agentMode: AGENT_MODE,
    killSwitch: isKillSwitchActive(),
    spending: {
      perCallLimitUsdc: stats.perCallLimit,
      dailyLimitUsdc:   stats.dailyLimit,
      spentTodayUsdc:   (Number(dailySpentRaw) / 1e6).toFixed(6),
      remainingUsdc:    (Math.max(0, stats.dailyLimit - Number(dailySpentRaw) / 1e6)).toFixed(6),
    },
    policy: {
      requireAllowlist:    process.env['REQUIRE_ALLOWLIST'] !== 'false',
      allowlistEnabled:    Boolean(process.env['ALLOWED_ADDRESSES']?.trim()),
      contractsEnabled:    Boolean(process.env['ALLOWED_CONTRACTS']?.trim()),
      selectorsEnabled:    Boolean(process.env['ALLOWED_SELECTORS']?.trim()),
      enforceBinding:      process.env['ENFORCE_OPERATION_BINDING'] !== 'false',
      x402MaxPriceUsdc:    process.env['X402_MAX_PRICE_USDC'] ?? null,
      x402AllowlistActive: Boolean(process.env['X402_ALLOWED_ENDPOINTS']?.trim()),
      authEnabled:         Boolean(process.env['API_AUTH_TOKEN']?.trim()),
      rateLimitMax:        parseInt(process.env['RATE_LIMIT_MAX'] ?? '60', 10),
    },
    transports: {
      configured: (process.env['MCP_TRANSPORT'] ?? 'both').toLowerCase(),
      httpPort:   parseInt(process.env['MCP_PORT'] ?? '3456', 10),
    },
  };

  return JSON.stringify(result, null, 2);
}
