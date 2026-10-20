/**
 * MCP Tool: job_reject
 *
 * Reject a Submitted job, returning USDC to the client.
 * Called by the evaluator agent.
 *
 * reject(uint256 jobId, bytes32 reason, bytes optParams)
 */
import { z } from 'zod';
import { encodeFunctionData, keccak256, toHex } from 'viem';
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

export const name = 'job_reject';

export const description =
  'Reject a Submitted ERC-8183 job, allowing the client to reclaim their USDC. ' +
  'Called by the evaluator. Reason can be plain text (auto-hashed) or a 0x bytes32 string.';

export const inputSchema = z.object({
  jobId: z.number().int().nonnegative().describe('Numeric job ID.'),
  reason: z.string().describe('Rejection reason. Plain text or 0x bytes32 hex string.'),
  optParams: z.string().optional().default('0x').describe('Optional extra params.'),
});

export type Input = z.infer<typeof inputSchema>;

function bindingSummary(b: OperationBinding) {
  return { hash: b.hash, nonce: b.nonce, timestamp: b.timestamp };
}

function toBytes32(input: string): `0x${string}` {
  const t = input.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(t)) return t as `0x${string}`;
  return keccak256(toHex(t));
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

  const reasonBytes = toBytes32(input.reason);
  const optParams = (input.optParams ?? '0x') as `0x${string}`;
  const args = [BigInt(input.jobId), reasonBytes, optParams] as const;

  const calldata = encodeFunctionData({ abi: ERC8183_ABI, functionName: 'reject', args });
  const binding = createOperationBinding(AGENTIC_COMMERCE_ADDRESS, 0n, calldata);
  const mode = (process.env.AGENT_MODE ?? 'unsigned').toLowerCase();
  const abiJson = JSON.stringify(Array.from(ERC8183_ABI));

  if (mode === 'circle') {
    appendLog({ timestamp: ts, tool: name, status: 'approved', mode: 'circle', binding });
    const result = await circleWallet.executeContract(
      AGENTIC_COMMERCE_ADDRESS,
      'reject(uint256,bytes32,bytes)',
      [String(input.jobId), reasonBytes, optParams],
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

  const tx = buildContractWrite(AGENTIC_COMMERCE_ADDRESS, abiJson, 'reject', [...args]);
  const gasEst = await estimateGas(tx.to, tx.data, 0n);
  appendLog({ timestamp: ts, tool: name, status: 'approved', mode: 'unsigned', binding });

  return JSON.stringify({
    success: true, mode: 'unsigned', jobId: input.jobId,
    unsignedTransaction: tx, estimatedGasUsdc: gasEst, binding: bindingSummary(binding),
    instructions: 'Sign and broadcast. Client can claim refund after confirmation.',
  });
}
