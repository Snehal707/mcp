/**
 * MCP Tool: transfer_usdc
 *
 * Transfer USDC to a recipient on Arc, with three spending-limit guardrails:
 *   1. Per-call cap
 *   2. Daily rolling limit
 *   3. Address allowlist
 *
 * Two execution modes via AGENT_MODE env var:
 *   "circle"   — Circle Developer-Controlled Wallets API (no key on server)
 *   "unsigned" — Returns an unsigned tx object for the human operator to sign
 */
import { z } from 'zod';
import { isAddress } from 'viem';
import { parseUsdc } from '../arc-chain.js';
import { checkLimits, SpendingLimitError, appendLog } from '../spending-limits.js';
import * as circleWallet from '../circle-wallet.js';
import { estimateGas, buildUsdcTransfer } from '../unsigned-tx.js';

export const name = 'transfer_usdc';

export const description =
  'Transfer USDC to a recipient address on Arc. ' +
  'Enforces spending limits: per-call cap, 24-hour rolling total, and address allowlist. ' +
  'In "circle" mode the server signs via Circle Developer-Controlled Wallets and ' +
  'returns a transaction hash. In "unsigned" mode the server returns a ready-to-sign ' +
  'transaction object — the human operator must sign and broadcast it. ' +
  'On Arc, USDC is the native gas token, so the same USDC balance covers both the ' +
  'transfer amount and the gas fee.';

export const inputSchema = z.object({
  to: z
    .string()
    .describe(
      'Recipient 0x address. Must be a valid EVM address (0x-prefixed, 40 hex characters).',
    ),
  amount: z
    .string()
    .describe(
      'Amount of USDC to transfer, as a human-readable decimal string (e.g. "5", "1.50", "0.01"). ' +
        'Maximum 6 decimal places. Must be greater than 0.',
    ),
  memo: z
    .string()
    .optional()
    .describe('Optional memo or note for this transfer (logged but not sent onchain).'),
});

export type Input = z.infer<typeof inputSchema>;

export async function handler(input: Input): Promise<string> {
  const ts = new Date().toISOString();

  // ── Input validation ──────────────────────────────────────────────────────
  if (!isAddress(input.to)) {
    throw new Error(
      `"${input.to}" is not a valid EVM address. Provide a 0x-prefixed 40-hex-character address.`,
    );
  }
  const amountStr = input.amount.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(amountStr) || parseFloat(amountStr) <= 0) {
    throw new Error(
      `Invalid amount "${amountStr}". Must be a positive decimal with at most 6 decimal places.`,
    );
  }

  const amountRaw = parseUsdc(amountStr);
  const to = input.to as `0x${string}`;

  // ── Spending-limit check ──────────────────────────────────────────────────
  try {
    checkLimits(to, amountRaw);
  } catch (err) {
    if (err instanceof SpendingLimitError) {
      appendLog({
        timestamp: ts,
        tool: name,
        to: input.to,
        amountUsdc: amountStr,
        status: 'blocked',
        limitCode: err.code,
        memo: input.memo,
      });
      // Return structured error, not a thrown exception, so the agent can read the reason
      return JSON.stringify({
        success: false,
        error: err.message,
        limitViolation: err.code,
      });
    }
    throw err;
  }

  const mode = (process.env.AGENT_MODE ?? 'unsigned').toLowerCase();

  // ── Circle mode ───────────────────────────────────────────────────────────
  if (mode === 'circle') {
    appendLog({
      timestamp: ts,
      tool: name,
      to: input.to,
      amountUsdc: amountStr,
      status: 'approved',
      mode: 'circle',
      memo: input.memo,
    });

    const result = await circleWallet.sendUsdc(to, amountRaw.toString());

    appendLog({
      timestamp: new Date().toISOString(),
      tool: name,
      to: input.to,
      amountUsdc: amountStr,
      status: 'completed',
      mode: 'circle',
      txHash: result.txHash ?? undefined,
      circleTransactionId: result.circleTransactionId,
      memo: input.memo,
    });

    return JSON.stringify({
      success: true,
      mode: 'circle',
      to,
      amountUsdc: amountStr,
      circleTransactionId: result.circleTransactionId,
      txHash: result.txHash,
      state: result.state,
      explorerUrl: result.explorerUrl,
    });
  }

  // ── Unsigned mode (default) ───────────────────────────────────────────────
  const tx = buildUsdcTransfer(to, amountStr);
  const estimatedGas = await estimateGas(tx.to, tx.data, BigInt(tx.value === '0x0' ? 0 : 0));

  appendLog({
    timestamp: ts,
    tool: name,
    to: input.to,
    amountUsdc: amountStr,
    status: 'approved',
    mode: 'unsigned',
    memo: input.memo,
  });

  return JSON.stringify({
    success: true,
    mode: 'unsigned',
    to,
    amountUsdc: amountStr,
    unsignedTransaction: tx,
    estimatedGasUsdc: estimatedGas,
    instructions:
      'This transaction has NOT been sent. Sign and broadcast it with MetaMask, ' +
      'Frame, Rainbow, or the cast CLI. Once broadcast, pass the tx hash to ' +
      'get_transaction_status to confirm it.',
  });
}
