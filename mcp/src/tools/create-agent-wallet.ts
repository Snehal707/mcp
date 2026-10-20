/**
 * MCP Tool: create_agent_wallet
 *
 * Creates a new Circle Agent Wallet on Arc (or another supported chain).
 * Wallets are backed by 2-of-2 MPC — key shares never reach this server.
 *
 * Prerequisite: run `circle wallet login <email> [--testnet]` at least once
 * to authenticate a Circle CLI session.
 *
 * Note: Each Circle account supports up to 5 agent wallets. Wallets cannot
 * be deleted. Testnet wallets are free; mainnet wallets require a funded account.
 */
import { z } from 'zod';
import { isKillSwitchActive } from '../spending-limits.js';
import { createWallet, AgentWalletError } from '../circle-agent-wallet.js';

export const name = 'create_agent_wallet';

export const description =
  'Create a new Circle Agent Wallet on Arc (or another supported chain). ' +
  'The wallet uses 2-of-2 MPC — key shares never reach this server or the agent. ' +
  'Requires a prior `circle wallet login` CLI session. ' +
  'Returns the wallet address and ID once created.';

export const inputSchema = z.object({
  chain: z
    .enum(['ARC', 'ARC-TESTNET'])
    .optional()
    .describe(
      'Target chain. "ARC" = mainnet, "ARC-TESTNET" = testnet (default). ' +
        'Falls back to the ARC_NETWORK environment variable if omitted.',
    ),
  name: z
    .string()
    .optional()
    .describe('Optional label for the wallet (stored locally for your reference only).'),
});

type Input = z.infer<typeof inputSchema>;

export async function handler(input: Input): Promise<string> {
  // Phase 0: kill switch applies to all write operations
  if (isKillSwitchActive()) {
    return JSON.stringify({
      error: 'KILL_SWITCH_ACTIVE',
      message: 'Kill switch is active. All write operations are blocked. Set KILL_SWITCH=false in .env to re-enable.',
    });
  }

  try {
    const wallet = await createWallet(input.chain);

    const network = input.chain ?? process.env.ARC_NETWORK ?? 'testnet';
    const isTestnet = wallet.chain.includes('TESTNET') || network !== 'mainnet';
    const explorerBase = isTestnet ? 'https://explorer.testnet.arc.io' : 'https://explorer.arc.io';

    return JSON.stringify({
      walletId: wallet.walletId,
      address: wallet.address,
      chain: wallet.chain,
      explorerUrl: `${explorerBase}/address/${wallet.address}`,
      nextSteps: [
        isTestnet
          ? `Fund the wallet: circle wallet fund --address ${wallet.address} --chain ${wallet.chain}`
          : `Fund the wallet: circle wallet fund --address ${wallet.address} --chain ${wallet.chain} --amount 10 --method crypto`,
        `Set a spending policy (mainnet only): use set_agent_policy tool`,
        `Check balance: circle wallet balance --address ${wallet.address} --chain ${wallet.chain}`,
      ],
      note: isTestnet
        ? 'Testnet wallet created. Spending policies are mainnet-only — testnet transfers have no enforced limits at the Circle level, but Phase 0 server-side guards still apply.'
        : 'Mainnet wallet created. Set a spending policy with set_agent_policy before transferring.',
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
