/**
 * MCP Tool: job_submit
 *
 * Submit a deliverable hash for a Funded ERC-8183 job.
 * Called by the provider agent once work is complete.
 *
 * submit(uint256 jobId, bytes32 deliverable, bytes optParams)
 * Phase 0 guards: kill switch, contract allowlist, operation binding.
 * No USDC value — no spending-limit check needed.
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

export const name = 'job_submit';

export const description =
  'Submit a deliverable hash for a Funded ERC-8183 job. ' +
  'Pass a 0x-prefixed 32-byte hex string as deliverableHash, or a plain-text string ' +
  'that will be keccak256-hashed automatically. ' +
  'The job must be in Funded status. Called by the provider agent.';

export const inputSchema = z.object({
  jobId: z.number().int().nonnegative().describe('Numeric job ID.'),
  deliverableHash: z
    .string()
    .describe(
      'Deliverable as a 0x-prefixed bytes32 hex string, or plain text that will be keccak256-hashed. ' +
        'Example: "0xabc...def" (66 chars) or "https://ipfs.io/ipfs/Qm..."',
    ),
  optParams: z.string().optional().default('0x').describe('Optional extra params. Default: "0x".'),
});

export type Input = z.infer<typeof inputSchema>;

function bindingSummary(b: OperationBinding) {
  return { hash: b.hash, nonce: b.nonce, timestamp: b.timestamp };
}

/** Accept 0x+64hex or hash plain text → bytes32. */
function toBytes32(input: string): `0x${string}` {
  const trimmed = input.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed as `0x${string}`;
  // Plain-text: keccak256
  return keccak256(toHex(trimmed));
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

  const deliverable = toBytes32(input.deliverableHash);
  const optParams = (input.optParams ?? '0x') as `0x${string}`;
  const args = [BigInt(input.jobId), deliverable, optParams] as const;

  const calldata = encodeFunctionData({ abi: ERC8183_ABI, functionName: 'submit', args });
  const binding = createOperationBinding(AGENTIC_COMMERCE_ADDRESS, 0n, calldata);
  const mode = (process.env.AGENT_MODE ?? 'unsigned').toLowerCase();
  const abiJson = JSON.stringify(Array.from(ERC8183_ABI));

  if (mode === 'circle') {
    appendLog({ timestamp: ts, tool: name, status: 'approved', mode: 'circle', binding });
    const result = await circleWallet.executeContract(
      AGENTIC_COMMERCE_ADDRESS,
      'submit(uint256,bytes32,bytes)',
      [String(input.jobId), deliverable, optParams],
    );
    appendLog({
      timestamp: new Date().toISOString(), tool: name, status: 'completed',
      mode: 'circle', txHash: result.txHash ?? undefined, binding,
    });
    return JSON.stringify({
      success: true, mode: 'circle', jobId: input.jobId,
      deliverable, txHash: result.txHash, explorerUrl: result.explorerUrl,
      binding: bindingSummary(binding),
    });
  }

  const tx = buildContractWrite(AGENTIC_COMMERCE_ADDRESS, abiJson, 'submit', [...args]);
  const gasEst = await estimateGas(tx.to, tx.data, 0n);
  appendLog({ timestamp: ts, tool: name, status: 'approved', mode: 'unsigned', binding });

  return JSON.stringify({
    success: true, mode: 'unsigned', jobId: input.jobId, deliverable,
    unsignedTransaction: tx, estimatedGasUsdc: gasEst, binding: bindingSummary(binding),
    instructions: 'Sign and broadcast. Job status will move to Submitted.',
  });
}
