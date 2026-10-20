/**
 * MCP Tool: job_set_budget
 *
 * Set the USDC budget for an ERC-8183 job (must be in Open status).
 * Phase 0 guards: kill switch, contract allowlist, address allowlist,
 * per-call spending cap, daily rolling limit, operation binding.
 *
 * setBudget(uint256 jobId, uint256 amount, bytes optParams)
 */
import { z } from 'zod';
import { encodeFunctionData } from 'viem';
import { parseUsdc } from '../../arc-chain.js';
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

export const name = 'job_set_budget';

export const description =
  'Set the USDC budget for an ERC-8183 job on Arc. ' +
  'The job must be in Open status. Budget is denominated in USDC (6 decimals). ' +
  'Phase 0 spending guards apply to the budget amount.';

export const inputSchema = z.object({
  jobId: z.number().int().nonnegative().describe('Numeric job ID.'),
  amount: z
    .string()
    .describe('Budget in USDC, e.g. "10" or "5.50". Subject to per-call and daily limits.'),
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

  const amountStr = input.amount.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(amountStr) || parseFloat(amountStr) <= 0) {
    throw new Error(`Invalid amount "${amountStr}". Must be a positive decimal with at most 6 decimal places.`);
  }
  const amountRaw = parseUsdc(amountStr);
  const optParams = (input.optParams ?? '0x') as `0x${string}`;

  try {
    checkContractAllowlist(AGENTIC_COMMERCE_ADDRESS);
    checkAddressAllowlist(AGENTIC_COMMERCE_ADDRESS);
    checkLimits(amountRaw);
  } catch (err) {
    if (err instanceof SpendingLimitError) {
      appendLog({ timestamp: ts, tool: name, amountUsdc: amountStr, status: 'blocked', limitCode: err.code });
      return JSON.stringify({ success: false, error: err.message, limitViolation: err.code });
    }
    throw err;
  }

  const args = [BigInt(input.jobId), amountRaw, optParams] as const;
  const calldata = encodeFunctionData({ abi: ERC8183_ABI, functionName: 'setBudget', args });
  const binding = createOperationBinding(AGENTIC_COMMERCE_ADDRESS, amountRaw, calldata);
  const mode = (process.env.AGENT_MODE ?? 'unsigned').toLowerCase();
  const abiJson = JSON.stringify(Array.from(ERC8183_ABI));

  if (mode === 'circle') {
    appendLog({ timestamp: ts, tool: name, amountUsdc: amountStr, status: 'approved', mode: 'circle', binding });
    const result = await circleWallet.executeContract(
      AGENTIC_COMMERCE_ADDRESS,
      'setBudget(uint256,uint256,bytes)',
      [String(input.jobId), amountRaw.toString(), optParams],
    );
    appendLog({
      timestamp: new Date().toISOString(),
      tool: name,
      amountUsdc: amountStr,
      status: 'completed',
      mode: 'circle',
      txHash: result.txHash ?? undefined,
      binding,
    });
    return JSON.stringify({
      success: true,
      mode: 'circle',
      jobId: input.jobId,
      amountUsdc: amountStr,
      txHash: result.txHash,
      explorerUrl: result.explorerUrl,
      binding: bindingSummary(binding),
    });
  }

  const tx = buildContractWrite(AGENTIC_COMMERCE_ADDRESS, abiJson, 'setBudget', [...args]);
  const gasEst = await estimateGas(tx.to, tx.data, 0n);
  appendLog({ timestamp: ts, tool: name, amountUsdc: amountStr, status: 'approved', mode: 'unsigned', binding });

  return JSON.stringify({
    success: true,
    mode: 'unsigned',
    jobId: input.jobId,
    amountUsdc: amountStr,
    unsignedTransaction: tx,
    estimatedGasUsdc: gasEst,
    binding: bindingSummary(binding),
    instructions: 'Sign and broadcast. Then call job_approve_usdc + job_fund to lock the USDC.',
  });
}
