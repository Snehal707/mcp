/**
 * MCP Tool: job_approve_usdc
 *
 * Approve the AgenticCommerce contract to spend USDC on behalf of the caller.
 * This must be called before job_fund so the contract can pull the budget amount.
 *
 * Calls USDC.approve(spender, amount) where spender is the AgenticCommerce proxy.
 * Phase 0 guards: kill switch, contract allowlist (USDC address), per-call cap,
 * daily rolling limit, operation binding.
 */
import { z } from 'zod';
import { isAddress, encodeFunctionData } from 'viem';
import { USDC_ADDRESS, parseUsdc } from '../../arc-chain.js';
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
import { ERC20_APPROVE_ABI, AGENTIC_COMMERCE_ADDRESS } from '../../abi/erc8183.js';
import { buildContractWrite, estimateGas } from '../../unsigned-tx.js';
import * as circleWallet from '../../circle-wallet.js';

export const name = 'job_approve_usdc';

export const description =
  'Approve a spender contract to transfer USDC on your behalf. ' +
  'Required before job_fund — approves the AgenticCommerce contract to pull the job budget. ' +
  'Phase 0 spending guards apply to the approval amount. ' +
  'In unsigned mode returns an ERC-20 approve transaction to sign.';

export const inputSchema = z.object({
  spender: z
    .string()
    .optional()
    .describe(
      'Address to approve. Defaults to the AgenticCommerce contract ' +
        `(${AGENTIC_COMMERCE_ADDRESS}). Override for other spenders.`,
    ),
  amount: z
    .string()
    .describe('USDC amount to approve, e.g. "10" or "5.50". Subject to spending limits.'),
});

export type Input = z.infer<typeof inputSchema>;

function bindingSummary(b: OperationBinding) {
  return { hash: b.hash, nonce: b.nonce, timestamp: b.timestamp };
}

export async function handler(input: Input): Promise<string> {
  const ts = new Date().toISOString();
  const spender = (input.spender ?? AGENTIC_COMMERCE_ADDRESS) as `0x${string}`;

  if (isKillSwitchActive()) {
    appendLog({ timestamp: ts, tool: name, status: 'blocked', limitCode: 'KILL_SWITCH_ACTIVE' });
    return JSON.stringify({ success: false, error: 'Kill switch is active.', limitViolation: 'KILL_SWITCH_ACTIVE' });
  }

  if (!isAddress(spender)) {
    throw new Error(`Invalid spender address: "${spender}"`);
  }
  const amountStr = input.amount.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(amountStr) || parseFloat(amountStr) <= 0) {
    throw new Error(`Invalid amount "${amountStr}".`);
  }
  const amountRaw = parseUsdc(amountStr);

  // Allowlist checks on the USDC contract address (the target of the approve call)
  try {
    checkContractAllowlist(USDC_ADDRESS);
    checkAddressAllowlist(USDC_ADDRESS);
    checkLimits(amountRaw);
  } catch (err) {
    if (err instanceof SpendingLimitError) {
      appendLog({ timestamp: ts, tool: name, amountUsdc: amountStr, status: 'blocked', limitCode: err.code });
      return JSON.stringify({ success: false, error: err.message, limitViolation: err.code });
    }
    throw err;
  }

  const args = [spender, amountRaw] as const;
  const calldata = encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args });
  const binding = createOperationBinding(USDC_ADDRESS, amountRaw, calldata);
  const mode = (process.env.AGENT_MODE ?? 'unsigned').toLowerCase();
  const abiJson = JSON.stringify(Array.from(ERC20_APPROVE_ABI));

  if (mode === 'circle') {
    appendLog({ timestamp: ts, tool: name, amountUsdc: amountStr, status: 'approved', mode: 'circle', binding });
    const result = await circleWallet.executeContract(
      USDC_ADDRESS,
      'approve(address,uint256)',
      [spender, amountRaw.toString()],
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
      spender,
      amountUsdc: amountStr,
      txHash: result.txHash,
      explorerUrl: result.explorerUrl,
      binding: bindingSummary(binding),
      nextStep: 'Now call job_fund to pull the USDC into the contract.',
    });
  }

  const tx = buildContractWrite(USDC_ADDRESS, abiJson, 'approve', [...args]);
  const gasEst = await estimateGas(tx.to, tx.data, 0n);
  appendLog({ timestamp: ts, tool: name, amountUsdc: amountStr, status: 'approved', mode: 'unsigned', binding });

  return JSON.stringify({
    success: true,
    mode: 'unsigned',
    spender,
    amountUsdc: amountStr,
    unsignedTransaction: tx,
    estimatedGasUsdc: gasEst,
    binding: bindingSummary(binding),
    instructions: 'Sign and broadcast this approval. Then call job_fund to pull the USDC into the contract.',
  });
}
