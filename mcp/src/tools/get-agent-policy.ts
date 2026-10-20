/**
 * MCP Tool: get_agent_policy
 *
 * Read the current spending policies on a Circle Agent Wallet.
 *
 * IMPORTANT: Spending policies are MAINNET ONLY. On testnet, this tool returns
 * an informational placeholder explaining that policies are not enforced.
 */
import { z } from 'zod';
import { getPolicy, AgentWalletError } from '../circle-agent-wallet.js';

export const name = 'get_agent_policy';

export const description =
  'Read the current spending policies on a Circle Agent Wallet. ' +
  'Returns transfer limits (per-tx, daily, weekly, monthly) and any address allowlists or blocklists. ' +
  'Spending policies are enforced by Circle at the network level — MAINNET ONLY. ' +
  'On testnet, no Circle-level policies are enforced (Phase 0 server-side guards still apply).';

export const inputSchema = z.object({
  address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid 0x Ethereum address')
    .describe('Agent wallet address to read policies for.'),
  chain: z
    .enum(['ARC', 'ARC-TESTNET'])
    .optional()
    .describe('Chain the wallet lives on. Defaults to ARC-TESTNET (or ARC_NETWORK env var).'),
});

type Input = z.infer<typeof inputSchema>;

export async function handler(input: Input): Promise<string> {
  try {
    const policies = await getPolicy(input.address, input.chain);
    const resolvedChain = input.chain ?? (process.env.ARC_NETWORK === 'mainnet' ? 'ARC' : 'ARC-TESTNET');
    const isTestnet = resolvedChain.includes('TESTNET') || process.env.ARC_NETWORK !== 'mainnet';

    if (isTestnet) {
      return JSON.stringify({
        address: input.address,
        chain: resolvedChain,
        policies: [],
        note:
          'Spending policies are only enforced on mainnet agent wallets. ' +
          'This testnet wallet has no Circle-level spending policy. ' +
          'Phase 0 server-side guards (kill switch, address allowlist, per-call cap, daily limit) ' +
          'still apply to every transfer through this MCP server.',
      });
    }

    return JSON.stringify({
      address: input.address,
      chain: resolvedChain,
      policies,
      note:
        policies.length === 0
          ? 'No spending policies are set. Any transfer amount to any address is currently permitted by Circle. ' +
            'Set a policy with set_agent_policy before using this wallet in production.'
          : `${policies.length} policy rule(s) active. Circle enforces these at the network level.`,
    });
  } catch (err) {
    if (err instanceof AgentWalletError) {
      return JSON.stringify({
        error: err.code,
        message: err.message,
        ...(err.cliOutput ? { cliOutput: err.cliOutput.slice(0, 500) } : {}),
      });
    }
    throw err;
  }
}
