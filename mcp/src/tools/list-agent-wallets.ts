/**
 * MCP Tool: list_agent_wallets
 *
 * Lists Circle Agent Wallets for the authenticated CLI session, optionally
 * enriched with live USDC balances read from the Arc RPC.
 */
import { z } from 'zod';
import { listWallets, AgentWalletError } from '../circle-agent-wallet.js';
import { publicClient, USDC_ADDRESS, ERC20_ABI, USDC_DECIMALS } from '../arc-chain.js';

export const name = 'list_agent_wallets';

export const description =
  'List Circle Agent Wallets associated with the authenticated Circle CLI session. ' +
  'Returns wallet IDs, addresses, and optionally live USDC balances. ' +
  'Requires a prior `circle wallet login` CLI session.';

export const inputSchema = z.object({
  chain: z
    .enum(['ARC', 'ARC-TESTNET'])
    .optional()
    .describe('Chain to list wallets on. Defaults to ARC-TESTNET (or ARC_NETWORK env var).'),
  includeBalances: z
    .boolean()
    .optional()
    .default(true)
    .describe('When true (default), fetches the live USDC balance for each wallet from the Arc RPC.'),
});

type Input = z.infer<typeof inputSchema>;

export async function handler(input: Input): Promise<string> {
  try {
    const wallets = await listWallets(input.chain);

    if (wallets.length === 0) {
      return JSON.stringify({
        wallets: [],
        message:
          'No agent wallets found. Create one with create_agent_wallet, or run: ' +
          'circle wallet login <email> --testnet',
      });
    }

    // Optionally enrich with live USDC balances
    let enriched = wallets.map((w) => ({ ...w, balanceUsdc: undefined as string | undefined }));

    if (input.includeBalances !== false) {
      enriched = await Promise.all(
        wallets.map(async (w) => {
          try {
            const raw = await publicClient.readContract({
              address: USDC_ADDRESS,
              abi: ERC20_ABI,
              functionName: 'balanceOf',
              args: [w.address as `0x${string}`],
            });
            const divisor = BigInt(10 ** USDC_DECIMALS);
            const whole = raw / divisor;
            const frac = raw % divisor;
            const fracStr = frac.toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
            const balanceUsdc = fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
            return { ...w, balanceUsdc };
          } catch {
            return { ...w, balanceUsdc: 'unavailable' };
          }
        }),
      );
    }

    const network = process.env.ARC_NETWORK ?? 'testnet';
    const isTestnet = enriched[0]?.chain?.includes('TESTNET') ?? network !== 'mainnet';
    const explorerBase = isTestnet ? 'https://explorer.testnet.arc.io' : 'https://explorer.arc.io';

    return JSON.stringify({
      wallets: enriched.map((w) => ({
        walletId: w.walletId,
        address: w.address,
        chain: w.chain,
        balanceUsdc: w.balanceUsdc,
        explorerUrl: `${explorerBase}/address/${w.address}`,
      })),
      count: enriched.length,
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
