/**
 * pay_x402 — Phase 3 MCP tool.
 *
 * Pays an x402-compatible endpoint using a Circle Agent Wallet and returns
 * the resource response body. Runs the full Phase 0 guard stack before
 * dispatching any payment.
 *
 * Guard order (see mcp/src/x402.ts for full documentation):
 *   Kill switch → URL validation → maxPriceUsdc ceiling →
 *   inspect actual price → per-call cap → daily limit →
 *   operation binding → circle services pay (CLI)
 *
 * The walletId is used to look up the wallet address. If you already know
 * the address, you may supply it directly as walletAddress.
 *
 * Example agent prompt:
 *   "Pay for weather data at https://api.example.com/weather — budget 0.01 USDC."
 */
import { z } from 'zod';
import { payX402 } from '../x402.js';
import { listWallets, AgentWalletError } from '../circle-agent-wallet.js';

export const name = 'pay_x402';

export const description =
  'Pay for an x402-compatible API endpoint using a Circle Agent Wallet. ' +
  'Returns the resource response body on success. ' +
  'Subject to kill switch, per-call USDC cap, daily rolling limit, and wallet policy. ' +
  'Requires: circle CLI installed and authenticated (circle wallet login).';

export const inputSchema = z.object({
  walletId: z
    .string()
    .min(1)
    .describe(
      'Circle Agent Wallet ID (from create_agent_wallet / list_agent_wallets). ' +
        'Used to resolve the wallet address.',
    ),
  endpoint: z
    .string()
    .url()
    .describe('Full HTTPS URL of the x402-priced resource to pay for.'),
  maxPriceUsdc: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal number')
    .describe(
      'Hard ceiling in USDC — refuse to pay more than this amount. ' +
        'If the service price exceeds this, the call fails without paying.',
    ),
  method: z
    .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
    .default('GET')
    .describe('HTTP method for the paid request. Defaults to GET.'),
  payload: z
    .record(z.unknown())
    .optional()
    .describe('Optional JSON body for POST / PUT requests.'),
  headers: z
    .record(z.string())
    .optional()
    .describe('Optional extra HTTP headers (e.g. Accept, Content-Type).'),
  chain: z
    .string()
    .optional()
    .describe(
      'Override the chain for payment. Defaults to ARC_NETWORK env var ' +
        '(ARC-TESTNET for testnet, ARC for mainnet).',
    ),
});

export type Input = z.infer<typeof inputSchema>;

export async function handler(input: Input): Promise<string> {
  const { walletId, endpoint, maxPriceUsdc, method = 'GET', payload, headers, chain } = input;

  // Resolve wallet address from walletId
  let walletAddress: string;
  try {
    const wallets = await listWallets(chain);
    const match = wallets.find(
      (w) => w.walletId === walletId || w.address.toLowerCase() === walletId.toLowerCase(),
    );
    if (!match) {
      return JSON.stringify({
        status: 'error',
        message:
          `Wallet ID "${walletId}" not found. ` +
          'Run list_agent_wallets to see available wallets.',
        paidAmount: '0',
      });
    }
    walletAddress = match.address;
  } catch (err) {
    if (err instanceof AgentWalletError && err.code === 'CLI_NOT_FOUND') {
      return JSON.stringify({
        status: 'error',
        message: err.message,
        paidAmount: '0',
      });
    }
    if (err instanceof AgentWalletError && err.code === 'NOT_AUTHENTICATED') {
      return JSON.stringify({
        status: 'error',
        message: err.message,
        paidAmount: '0',
      });
    }
    return JSON.stringify({
      status: 'error',
      message: `Failed to resolve wallet: ${(err as Error).message}`,
      paidAmount: '0',
    });
  }

  const result = await payX402({
    walletId,
    walletAddress,
    endpoint,
    maxPriceUsdc,
    method,
    payload,
    headers,
    chain,
  });

  return JSON.stringify(result, null, 2);
}
