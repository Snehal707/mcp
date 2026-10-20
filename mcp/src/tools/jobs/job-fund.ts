/**
 * MCP Tool: job_fund
 *
 * Fund an ERC-8183 job by pulling the pre-approved USDC budget into the contract.
 * Requires a prior job_approve_usdc call for at least the budget amount.
 *
 * fund(uint256 jobId, bytes optParams)
 * Phase 0 guards: kill switch, contract allowlist, address allowlist,
 * spending limits (budget amount fetched from chain), operation binding.
 */
import { z } from 'zod';
import { encodeFunctionData } from 'viem';
import { publicClient, formatUsdc } from '../../arc-chain.js';
import {
  isKillSwitchActive,
  checkContractAllowlist,
  checkAddressAllowlist,
  checkLimits,
  createOperationBinding,
  SpendingLimitError,
  appendLog,
  type OperationBinding,
} from '../../spending-limits.js';
import { ERC8183_ABI, AGENTIC_COMMERCE_ADDRESS } from '../../abi/erc8183.js';
import { buildContractWrite, estimateGas } from '../../unsigned-tx.js';
import * as circleWallet from '../../circle-wallet.js';

export const name = 'job_fund';

export const description =
  'Fund an ERC-8183 job by transferring the pre-approved USDC budget into the AgenticCommerce contract. ' +
  'Requires a prior job_approve_usdc call for at least the job budget amount. ' +
  'The job must be in Open status with a budget set. ' +
  'Phase 0 spending guards apply to the job budget amount.';

export const inputSchema = z.object({
  jobId: z.number().int().nonnegative().describe('Numeric job ID to fund.'),
  optParams: z
    .string()
    .optional()
    .default('0x')
    .describe('Optional extra params as a 0x-prefixed hex string. Default: "0x".'),
});

export type Input = z.infer<typeof inputSchema>;

function bindingSummary(b: OperationBinding) {
  return { hash: b.hash, nonce: b.nonce, timestamp: b.timestamp };
}

export async function handler(input: Input): Promise<string> {
  const ts = new Date().toISOString();

  if (isKillSwitchActive()) {
    appendLog({ timestamp: ts, tool: name, status: 'blocked', limitCode: 'KILL_SWITCH_ACTIVE' });
    return JSON.stringify({ success: false, error: 'Kill switch is active.', limitViolation: 'KILL_SWITCH_ACTIVE' });
  }

  // Fetch current budget from chain so spend checks use the real amount
  let budgetRaw = 0n;
  let budgetUsdc = '0';
  try {
    const job = await publicClient.readContract({
      address: AGENTIC_COMMERCE_ADDRESS,
      abi: ERC8183_ABI,
      functionName: 'getJob',
      args: [BigInt(input.jobId)],
    }) as { budget: bigint };
    budgetRaw = job.budget;
    budgetUsdc = formatUsdc(budgetRaw);
  } catch {
    // Non-fatal: proceed and let the contract revert if the job is invalid
  }

  const optParams = (input.optParams ?? '0x') as `0x${string}`;

  try {
    checkContractAllowlist(AGENTIC_COMMERCE_ADDRESS);
    checkAddressAllowlist(AGENTIC_COMMERCE_ADDRESS);
    if (budgetRaw > 0n) checkLimits(budgetRaw);
  } catch (err) {
    if (err instanceof SpendingLimitError) {
      appendLog({ timestamp: ts, tool: name, amountUsdc: budgetUsdc, status: 'blocked', limitCode: err.code });
      return JSON.stringify({ success: false, error: err.message, limitViolation: err.code });
    }
    throw err;
  }

  const args = [BigInt(input.jobId), optParams] as const;
  const calldata = encodeFunctionData({ abi: ERC8183_ABI, functionName: 'fund', args });
  const binding = createOperationBinding(AGENTIC_COMMERCE_ADDRESS, budgetRaw, calldata);
  const mode = (process.env.AGENT_MODE ?? 'unsigned').toLowerCase();
  const abiJson = JSON.stringify(Array.from(ERC8183_ABI));

  if (mode === 'circle') {
    appendLog({ timestamp: ts, tool: name, amountUsdc: budgetUsdc, status: 'approved', mode: 'circle', binding });
    const result = await circleWallet.executeContract(
      AGENTIC_COMMERCE_ADDRESS,
      'fund(uint256,bytes)',
      [String(input.jobId), optParams],
    );
    appendLog({
      timestamp: new Date().toISOString(),
      tool: name,
      amountUsdc: budgetUsdc,
      status: 'completed',
      mode: 'circle',
      txHash: result.txHash ?? undefined,
      binding,
    });
    return JSON.stringify({
      success: true,
      mode: 'circle',
      jobId: input.jobId,
      fundedUsdc: budgetUsdc,
      txHash: result.txHash,
      explorerUrl: result.explorerUrl,
      binding: bindingSummary(binding),
    });
  }

  const tx = buildContractWrite(AGENTIC_COMMERCE_ADDRESS, abiJson, 'fund', [...args]);
  const gasEst = await estimateGas(tx.to, tx.data, 0n);
  appendLog({ timestamp: ts, tool: name, amountUsdc: budgetUsdc, status: 'approved', mode: 'unsigned', binding });

  return JSON.stringify({
    success: true,
    mode: 'unsigned',
    jobId: input.jobId,
    fundedUsdc: budgetUsdc,
    unsignedTransaction: tx,
    estimatedGasUsdc: gasEst,
    binding: bindingSummary(binding),
    instructions: 'Sign and broadcast. Job status will move to Funded once confirmed.',
  });
}
