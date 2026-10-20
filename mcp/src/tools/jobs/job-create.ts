/**
 * MCP Tool: job_create
 *
 * Create a new ERC-8183 job on the AgenticCommerce contract.
 * Phase 0 guards: kill switch, contract allowlist, address allowlist, operation binding.
 * No USDC value is attached — creation is free (gas only).
 *
 * Contract: 0x0747EEf0706327138c69792bF28Cd525089e4583 (Arc Testnet)
 */
import { z } from 'zod';
import { isAddress, encodeFunctionData } from 'viem';
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

export const name = 'job_create';

export const description =
  'Create a new ERC-8183 job on the AgenticCommerce contract on Arc. ' +
  'Specify the provider, evaluator, expiry timestamp, description, and optional hook. ' +
  'Returns the job ID once the transaction is confirmed (circle mode) or an unsigned ' +
  'transaction object (unsigned mode). Phase 0 guards apply.';

export const inputSchema = z.object({
  provider: z
    .string()
    .describe('0x address of the agent or service that will do the work.'),
  evaluator: z
    .string()
    .describe('0x address of the evaluator who will approve or reject the deliverable.'),
  expiredAt: z
    .number()
    .int()
    .positive()
    .describe('Unix timestamp (seconds) when the job expires. Must be in the future.'),
  description: z
    .string()
    .min(1)
    .describe('Human-readable description of the work to be done.'),
  hook: z
    .string()
    .optional()
    .describe(
      'Optional hook contract address. Omit or pass the zero address (0x000...000) for no hook.',
    ),
});

export type Input = z.infer<typeof inputSchema>;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

function bindingSummary(b: OperationBinding) {
  return { hash: b.hash, nonce: b.nonce, timestamp: b.timestamp };
}

export async function handler(input: Input): Promise<string> {
  const ts = new Date().toISOString();

  // ── 1. Kill switch ──────────────────────────────────────────────────────────
  if (isKillSwitchActive()) {
    appendLog({ timestamp: ts, tool: name, status: 'blocked', limitCode: 'KILL_SWITCH_ACTIVE' });
    return JSON.stringify({
      success: false,
      error: 'Kill switch is active. Set KILL_SWITCH=false to re-enable.',
      limitViolation: 'KILL_SWITCH_ACTIVE',
    });
  }

  // ── Input validation ────────────────────────────────────────────────────────
  if (!isAddress(input.provider)) {
    throw new Error(`Invalid provider address: "${input.provider}"`);
  }
  if (!isAddress(input.evaluator)) {
    throw new Error(`Invalid evaluator address: "${input.evaluator}"`);
  }
  const hookAddr = input.hook && isAddress(input.hook) ? input.hook : ZERO_ADDRESS;
  if (input.expiredAt <= Math.floor(Date.now() / 1000)) {
    throw new Error('expiredAt must be a future Unix timestamp (seconds).');
  }

  // ── 2. Allowlists ───────────────────────────────────────────────────────────
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

  // ── 3. Operation binding ────────────────────────────────────────────────────
  const args = [
    input.provider as `0x${string}`,
    input.evaluator as `0x${string}`,
    BigInt(input.expiredAt),
    input.description,
    hookAddr as `0x${string}`,
  ] as const;

  const calldata = encodeFunctionData({
    abi: ERC8183_ABI,
    functionName: 'createJob',
    args,
  });
  const binding = createOperationBinding(AGENTIC_COMMERCE_ADDRESS, 0n, calldata);

  const mode = (process.env.AGENT_MODE ?? 'unsigned').toLowerCase();
  const abiJson = JSON.stringify(Array.from(ERC8183_ABI));

  // ── Circle mode ─────────────────────────────────────────────────────────────
  if (mode === 'circle') {
    appendLog({ timestamp: ts, tool: name, status: 'approved', mode: 'circle', binding });
    const result = await circleWallet.executeContract(
      AGENTIC_COMMERCE_ADDRESS,
      'createJob(address,address,uint256,string,address)',
      [input.provider, input.evaluator, String(input.expiredAt), input.description, hookAddr],
    );
    appendLog({
      timestamp: new Date().toISOString(),
      tool: name,
      status: 'completed',
      mode: 'circle',
      txHash: result.txHash ?? undefined,
      binding,
    });
    return JSON.stringify({
      success: true,
      mode: 'circle',
      txHash: result.txHash,
      explorerUrl: result.explorerUrl,
      circleTransactionId: result.circleTransactionId,
      binding: bindingSummary(binding),
      note: 'Parse the JobCreated event from the transaction receipt to get the jobId.',
    });
  }

  // ── Unsigned mode ───────────────────────────────────────────────────────────
  const tx = buildContractWrite(AGENTIC_COMMERCE_ADDRESS, abiJson, 'createJob', [...args]);
  const gasEst = await estimateGas(tx.to, tx.data, 0n);
  appendLog({ timestamp: ts, tool: name, status: 'approved', mode: 'unsigned', binding });

  return JSON.stringify({
    success: true,
    mode: 'unsigned',
    unsignedTransaction: tx,
    estimatedGasUsdc: gasEst,
    binding: bindingSummary(binding),
    instructions:
      'Sign and broadcast this transaction. The contract emits a JobCreated event ' +
      'containing the new jobId. Pass the tx hash to get_transaction_status to confirm.',
  });
}
