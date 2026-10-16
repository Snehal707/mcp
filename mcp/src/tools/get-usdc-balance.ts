/**
 * MCP Tool: get_usdc_balance
 *
 * Read the USDC ERC-20 balance for any address on Arc.
 * Uses the 6-decimal ERC-20 view — never the 18-decimal native view.
 * No spending-limit check needed (read-only).
 */
import { z } from 'zod';
import { isAddress } from 'viem';
import {
  publicClient,
  ERC20_ABI,
  USDC_ADDRESS,
  formatUsdc,
  activeChain,
} from '../arc-chain.js';
import { appendLog } from '../spending-limits.js';

export const name = 'get_usdc_balance';

export const description =
  'Read the USDC balance (6-decimal ERC-20 view) for any address on Arc. ' +
  'Returns the formatted balance, raw bigint string, and a link to the Arc Explorer. ' +
  'On Arc, USDC is the native gas token — there is only one pool of funds; ' +
  'this call returns the canonical 6-decimal ERC-20 balance.';

export const inputSchema = z.object({
  address: z
    .string()
    .describe(
      'The 0x Ethereum address to check. Must be a valid EVM address (42 characters, 0x-prefixed).',
    ),
});

export type Input = z.infer<typeof inputSchema>;

export async function handler(input: Input): Promise<string> {
  const ts = new Date().toISOString();

  // Validate
  if (!isAddress(input.address)) {
    appendLog({
      timestamp: ts,
      tool: name,
      address: input.address,
      status: 'blocked',
      error: 'Invalid address',
    });
    throw new Error(
      `"${input.address}" is not a valid EVM address. Provide a 0x-prefixed 40-hex-character address.`,
    );
  }

  const address = input.address as `0x${string}`;

  // Read from chain
  const rawBalance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address],
  });

  const formatted = formatUsdc(rawBalance);
  const explorerUrl = `${activeChain.blockExplorers.default.url}/address/${address}`;

  appendLog({
    timestamp: ts,
    tool: name,
    address: input.address,
    balanceUsdc: formatted,
    status: 'completed',
  });

  return JSON.stringify({
    address,
    balanceUsdc: formatted,
    balanceRaw: rawBalance.toString(),
    symbol: 'USDC',
    decimals: 6,
    network: activeChain.name,
    chainId: activeChain.id,
    explorerUrl,
    note:
      'On Arc, USDC is the native gas token. This is the ERC-20 6-decimal view. ' +
      'Do NOT separately read the native balance — that is the same pool and ' +
      'showing both would double-count the balance.',
  });
}
