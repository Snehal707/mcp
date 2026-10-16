/**
 * MCP Tool: call_contract_read
 *
 * Execute a view/pure function on any contract deployed on Arc.
 * No spending-limit check — read-only calls cannot move funds.
 * Returns the decoded result as a JSON-serializable value.
 */
import { z } from 'zod';
import { isAddress, parseAbi, type Abi } from 'viem';
import { publicClient, activeChain } from '../arc-chain.js';
import { appendLog } from '../spending-limits.js';

export const name = 'call_contract_read';

export const description =
  'Execute a read-only (view/pure) function on any smart contract deployed on Arc. ' +
  'Returns the decoded result. No transaction is created and no funds move. ' +
  'Accepts either a full ABI JSON array or a single human-readable signature ' +
  '(e.g. "function balanceOf(address) returns (uint256)").';

export const inputSchema = z.object({
  contractAddress: z
    .string()
    .describe('The 0x address of the contract to call.'),
  abi: z
    .string()
    .describe(
      'Contract ABI as a JSON string. Can be a JSON array of ABI objects, ' +
        'or a single human-readable signature like ' +
        '"function balanceOf(address owner) view returns (uint256)". ' +
        'Only the function being called needs to be present.',
    ),
  functionName: z
    .string()
    .describe('Name of the view/pure function to call (e.g. "balanceOf", "totalSupply").'),
  args: z
    .array(z.unknown())
    .optional()
    .default([])
    .describe(
      'Array of function arguments. Types must match the ABI. ' +
        'Pass uint256 values as decimal strings (e.g. "1000000"). ' +
        'Pass addresses as 0x strings.',
    ),
});

export type Input = z.infer<typeof inputSchema>;

/** Recursively convert BigInt values to strings for JSON serialization. */
function serializeResult(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serializeResult);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        serializeResult(v),
      ]),
    );
  }
  return value;
}

export async function handler(input: Input): Promise<string> {
  const ts = new Date().toISOString();

  if (!isAddress(input.contractAddress)) {
    throw new Error(
      `"${input.contractAddress}" is not a valid contract address.`,
    );
  }

  // Parse ABI
  let abi: Abi;
  try {
    const parsed = JSON.parse(input.abi) as unknown;
    if (Array.isArray(parsed)) {
      abi = parsed as Abi;
    } else if (typeof parsed === 'string') {
      abi = parseAbi([parsed]);
    } else {
      throw new Error('ABI must be a JSON array or a human-readable signature string');
    }
  } catch (err) {
    throw new Error(
      `Failed to parse ABI: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = await publicClient.readContract({
    address: input.contractAddress as `0x${string}`,
    abi,
    functionName: input.functionName,
    args: input.args as readonly unknown[],
  });

  appendLog({
    timestamp: ts,
    tool: name,
    contractAddress: input.contractAddress,
    functionName: input.functionName,
    args: input.args,
    status: 'completed',
  });

  return JSON.stringify({
    success: true,
    contractAddress: input.contractAddress,
    functionName: input.functionName,
    args: input.args,
    result: serializeResult(result),
    network: activeChain.name,
    chainId: activeChain.id,
  });
}
