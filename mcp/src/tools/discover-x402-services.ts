/**
 * discover_x402_services — Phase 3 MCP tool (read-only).
 *
 * Search the Circle Agent Marketplace for available x402-compatible services.
 * No USDC is moved. Safe to call at any time.
 *
 * Wraps: circle services search [<query>] [--limit n] --output json
 *
 * Example agent prompt:
 *   "Find data APIs that accept USDC payments."
 *   "Search for weather services on the Circle marketplace."
 *   "What x402 services are available for under 0.01 USDC?"
 */
import { z } from 'zod';
import { discoverServices, AgentWalletError } from '../circle-agent-wallet.js';

export const name = 'discover_x402_services';

export const description =
  'Search the Circle Agent Marketplace for x402-compatible services that accept USDC payments. ' +
  'Returns service names, endpoints, per-call prices, and descriptions. ' +
  'Read-only — no USDC is moved. ' +
  'Requires: circle CLI installed and authenticated.';

export const inputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'Optional search keyword (e.g. "weather", "news", "data"). ' +
        'Omit to list all available services.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of results to return (1–50, default 10).'),
});

export type Input = z.infer<typeof inputSchema>;

export async function handler(input: Input): Promise<string> {
  const { query, limit = 10 } = input;

  try {
    const services = await discoverServices(query, limit);

    if (services.length === 0) {
      return JSON.stringify({
        services: [],
        message:
          query
            ? `No x402 services found matching "${query}". Try a broader search term.`
            : 'No x402 services are currently listed. Check https://agents.circle.com/services for updates.',
      });
    }

    return JSON.stringify(
      {
        services,
        count: services.length,
        note: 'Use pay_x402 to call any of these endpoints. Use discover_x402_services with a specific query to narrow results.',
      },
      null,
      2,
    );
  } catch (err) {
    if (err instanceof AgentWalletError) {
      if (err.code === 'CLI_NOT_FOUND') {
        return JSON.stringify({
          services: [],
          status: 'error',
          message: err.message,
        });
      }
      if (err.code === 'NOT_AUTHENTICATED') {
        return JSON.stringify({
          services: [],
          status: 'error',
          message: err.message,
        });
      }
    }
    return JSON.stringify({
      services: [],
      status: 'error',
      message: `Service discovery failed: ${(err as Error).message}`,
    });
  }
}
