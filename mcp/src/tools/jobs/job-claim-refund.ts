/**
 * MCP Tool: job_claim_refund
 *
 * Reclaim USDC from a Rejected or Expired job.
 * Called by the client (job creator).
 *
 * claimRefund(uint256 jobId)
 */
import { z } from 'zod';
import { encodeFunctionData } from 'viem';
import {
  isKillSwitchActive,
  checkContractAllowlist,
  checkAddressAllowlist,
  createOperationBinding,
  SpendingLimitError,
  appendLog,
  type OperationBinding,
} from '../../spending-limits.js';
import { ERC8183_ABI, AGENTIC_COMMERCE_ADDRESS } from '../../abi/erc8183.js';
import { buildContractWrite, estimateGas } from '../../unsigned-tx.js';
import * as circleWallet from '../../circle-wallet.js';

export const name = 'job_claim_refund';

export const description =
  'Reclaim USDC from a Rejected or Expired ERC-8183 job. ' +
  'Called by the original client (job creator). ' +
  'Job must be in Rejected or Expired status.';

export const inputSchema = z.object({
  jobId: z.number().int().nonnegative().describe('Numeric job ID.'),
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

  try {
    checkContractAllowlist(AGENTIC_COMMERCE_ADDRESS);
    checkAddressAllowlist(AGENTIC_COMMERCE_ADDRESS);
  } catch (err) {
    if (err instanceof SpendingLimitError) {
      appendLog({ timestamp: ts, tool: name, status: 'blocked', limitCode: err.code });
      return JSON.stringify({ success: false, error: err.message, limitViolation: err.code });
    }
    throw err;
  }

  const args = [BigInt(input.jobId)] as const;
  const calldata = encodeFunctionData({ abi: ERC8183_ABI, functionName: 'claimRefund', args });
  const binding = createOperationBinding(AGENTIC_COMMERCE_ADDRESS, 0n, calldata);
  const mode = (process.env.AGENT_MODE ?? 'unsigned').toLowerCase();
  const abiJson = JSON.stringify(Array.from(ERC8183_ABI));

  if (mode === 'circle') {
    appendLog({ timestamp: ts, tool: name, status: 'approved', mode: 'circle', binding });
    const result = await circleWallet.executeContract(
      AGENTIC_COMMERCE_ADDRESS,
      'claimRefund(uint256)',
      [String(input.jobId)],
    );
    appendLog({
      timestamp: new Date().toISOString(), tool: name, status: 'completed',
      mode: 'circle', txHash: result.txHash ?? undefined, binding,
    });
    return JSON.stringify({
      success: true, mode: 'circle', jobId: input.jobId,
      txHash: result.txHash, explorerUrl: result.explorerUrl, binding: bindingSummary(binding),
    });
  }

  const tx = buildContractWrite(AGENTIC_COMMERCE_ADDRESS, abiJson, 'claimRefund', [...args]);
  const gasEst = await estimateGas(tx.to, tx.data, 0n);
  appendLog({ timestamp: ts, tool: name, status: 'approved', mode: 'unsigned', binding });

  return JSON.stringify({
    success: true, mode: 'unsigned', jobId: input.jobId,
    unsignedTransaction: tx, estimatedGasUsdc: gasEst, binding: bindingSummary(binding),
    instructions: 'Sign and broadcast. USDC will be returned to the client wallet.',
  });
}
