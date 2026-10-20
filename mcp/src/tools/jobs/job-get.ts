/**
 * MCP Tool: job_get
 *
 * Read the current state of an ERC-8183 job from the AgenticCommerce contract.
 * Read-only — no signing, no spending-limit checks, no Phase 0 guards required.
 *
 * Contract: 0x0747EEf0706327138c69792bF28Cd525089e4583 (Arc Testnet)
 */
import { z } from 'zod';
import { publicClient, formatUsdc } from '../../arc-chain.js';
import {
  ERC8183_ABI,
  AGENTIC_COMMERCE_ADDRESS,
  JOB_STATUS,
} from '../../abi/erc8183.js';

export const name = 'job_get';

export const description =
  'Read the current state of an ERC-8183 job from the AgenticCommerce contract on Arc. ' +
  'Returns job id, client, provider, evaluator, description, budget (USDC), expiry timestamp, ' +
  'status (Open | Funded | Submitted | Completed | Rejected | Expired), and hook address. ' +
  'Read-only — no transaction required.';

export const inputSchema = z.object({
  jobId: z
    .number()
    .int()
    .nonnegative()
    .describe('The numeric job ID to look up.'),
});

export type Input = z.infer<typeof inputSchema>;

export async function handler(input: Input): Promise<string> {
  const job = await publicClient.readContract({
    address: AGENTIC_COMMERCE_ADDRESS,
    abi: ERC8183_ABI,
    functionName: 'getJob',
    args: [BigInt(input.jobId)],
  });

  // job is a typed tuple — destructure safely
  const {
    id,
    client,
    provider,
    evaluator,
    description,
    budget,
    expiredAt,
    status,
    hook,
  } = job as {
    id: bigint;
    client: string;
    provider: string;
    evaluator: string;
    description: string;
    budget: bigint;
    expiredAt: bigint;
    status: number;
    hook: string;
  };

  const statusStr = JOB_STATUS[status] ?? `Unknown(${status})`;
  const now = Math.floor(Date.now() / 1000);
  const expiryTs = Number(expiredAt);

  return JSON.stringify({
    success: true,
    job: {
      id: Number(id),
      client,
      provider,
      evaluator,
      description,
      budgetUsdc: formatUsdc(budget),
      budgetRaw: budget.toString(),
      expiredAt: expiryTs,
      expiredAtIso: new Date(expiryTs * 1000).toISOString(),
      expired: expiryTs > 0 && now > expiryTs,
      status: statusStr,
      hook,
    },
    contract: AGENTIC_COMMERCE_ADDRESS,
  });
}
