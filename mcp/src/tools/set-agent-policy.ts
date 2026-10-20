/**
 * MCP Tool: set_agent_policy
 *
 * Set spending policies on a Circle Agent Wallet.
 *
 * CRITICAL SAFETY RULES:
 *   1. Policies are MAINNET ONLY — testnet returns an informational message.
 *   2. Every policy change requires a human to complete an email OTP.
 *      This tool ALWAYS returns `pending_otp` — it never attempts to
 *      automate or bypass OTP completion.
 *   3. The kill switch blocks this tool just like any other write operation.
 *
 * Limits must satisfy: per-tx ≤ daily ≤ weekly ≤ monthly.
 * Policy types: transfer-limit, recipient-allowlist/blocklist, contract-allowlist/blocklist.
 */
import { z } from 'zod';
import { isKillSwitchActive } from '../spending-limits.js';
import { setPolicy, AgentWalletError } from '../circle-agent-wallet.js';

export const name = 'set_agent_policy';

export const description =
  'Set spending policies on a Circle Agent Wallet. ' +
  'Policies include per-transaction and time-window USDC limits, and recipient/contract allow- or block-lists. ' +
  'MAINNET ONLY — testnet wallets have no enforced policies. ' +
  'Every policy change requires a human to complete an email OTP sent to the agent session email. ' +
  'This tool always returns pending_otp — never attempts to automate OTP.';

export const inputSchema = z.object({
  address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid 0x Ethereum address')
    .describe('Agent wallet address to set policies on.'),
  chain: z
    .enum(['ARC', 'ARC-TESTNET'])
    .optional()
    .describe('Chain the wallet lives on. Policies are mainnet-only; ARC-TESTNET returns an informational message.'),
  // Transfer limits
  perTx: z
    .number()
    .positive()
    .optional()
    .describe('Maximum USDC per single transaction. Must be ≤ daily.'),
  daily: z
    .number()
    .positive()
    .optional()
    .describe('Maximum USDC per rolling 24-hour window. Must be ≥ perTx and ≤ weekly.'),
  weekly: z
    .number()
    .positive()
    .optional()
    .describe('Maximum USDC per rolling 7-day window. Must be ≥ daily and ≤ monthly.'),
  monthly: z
    .number()
    .positive()
    .optional()
    .describe('Maximum USDC per rolling 30-day window. Must be ≥ weekly.'),
  // List rules
  recipientAllowlist: z
    .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
    .optional()
    .describe('Only allow transfers to these recipient addresses.'),
  recipientBlocklist: z
    .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
    .optional()
    .describe('Block transfers to these recipient addresses.'),
  contractAllowlist: z
    .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
    .optional()
    .describe('Only allow contract interactions with these addresses.'),
  contractBlocklist: z
    .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
    .optional()
    .describe('Block contract interactions with these addresses.'),
});

type Input = z.infer<typeof inputSchema>;

export async function handler(input: Input): Promise<string> {
  // Phase 0: kill switch blocks all write operations
  if (isKillSwitchActive()) {
    return JSON.stringify({
      error: 'KILL_SWITCH_ACTIVE',
      message: 'Kill switch is active. All write operations are blocked. Set KILL_SWITCH=false in .env to re-enable.',
    });
  }

  // Validate limit ordering
  const { perTx, daily, weekly, monthly } = input;
  if (perTx !== undefined && daily !== undefined && perTx > daily) {
    return JSON.stringify({
      error: 'INVALID_LIMITS',
      message: `per-tx (${perTx}) must be ≤ daily (${daily}).`,
    });
  }
  if (daily !== undefined && weekly !== undefined && daily > weekly) {
    return JSON.stringify({
      error: 'INVALID_LIMITS',
      message: `daily (${daily}) must be ≤ weekly (${weekly}).`,
    });
  }
  if (weekly !== undefined && monthly !== undefined && weekly > monthly) {
    return JSON.stringify({
      error: 'INVALID_LIMITS',
      message: `weekly (${weekly}) must be ≤ monthly (${monthly}).`,
    });
  }

  const hasAnyPolicy =
    perTx !== undefined ||
    daily !== undefined ||
    weekly !== undefined ||
    monthly !== undefined ||
    (input.recipientAllowlist && input.recipientAllowlist.length > 0) ||
    (input.recipientBlocklist && input.recipientBlocklist.length > 0) ||
    (input.contractAllowlist && input.contractAllowlist.length > 0) ||
    (input.contractBlocklist && input.contractBlocklist.length > 0);

  if (!hasAnyPolicy) {
    return JSON.stringify({
      error: 'NO_POLICY_SPECIFIED',
      message:
        'No policy parameters provided. Specify at least one of: perTx, daily, weekly, monthly, ' +
        'recipientAllowlist, recipientBlocklist, contractAllowlist, or contractBlocklist.',
    });
  }

  try {
    const result = await setPolicy({
      address: input.address,
      chain: input.chain,
      perTx: input.perTx,
      daily: input.daily,
      weekly: input.weekly,
      monthly: input.monthly,
      recipientAllowlist: input.recipientAllowlist,
      recipientBlocklist: input.recipientBlocklist,
      contractAllowlist: input.contractAllowlist,
      contractBlocklist: input.contractBlocklist,
    });

    return JSON.stringify({
      status: result.status,
      address: input.address,
      chain: input.chain ?? (process.env.ARC_NETWORK === 'mainnet' ? 'ARC' : 'ARC-TESTNET'),
      message: result.message,
      humanAction:
        result.status === 'pending_otp'
          ? '*** HUMAN ACTION REQUIRED *** Check your email for a Circle OTP and enter it to confirm the policy change. The agent cannot complete this step.'
          : undefined,
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
