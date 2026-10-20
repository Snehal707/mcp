/**
 * MCP Tool: transfer_usdc
 *
 * Transfer USDC to a recipient on Arc. Phase 0 guard order:
 *   1. Kill switch     — KILL_SWITCH=true blocks immediately
 *   2. Address allowlist — REQUIRE_ALLOWLIST=true (default) rejects empty list
 *   3. Per-call cap    — amount <= PER_CALL_LIMIT_USDC
 *   4. Daily rolling   — cumulative 24h spend <= DAILY_LIMIT_USDC
 *   5. Operation binding — keccak256 payload hash stamped on every log entry
 *
 * Two execution modes via AGENT_MODE:
 *   "circle"   — Circle Developer-Controlled Wallets API (no key on server)
 *   "unsigned" — Returns an unsigned tx object for the human operator to sign
 */
import { z } from 'zod';
import { isAddress } from 'viem';
import { parseUsdc } from '../arc-chain.js';
import {
  isKillSwitchActive,
  checkAddressAllowlist,
  checkLimits,
  createOperationBinding,
  SpendingLimitError,
  appendLog,
  type OperationBinding,
} from '../spending-limits.js';
import * as circleWallet from '../circle-wallet.js';
import { estimateGas, buildUsdcTransfer } from '../unsigned-tx.js';

export const name = 'transfer_usdc';

export const description =
  'Transfer USDC to a recipient address on Arc. ' +
  'Phase 0 guards: kill switch, address allowlist (REQUIRE_ALLOWLIST=true by default), ' +
  'per-call cap, 24-hour rolling daily limit, and operation binding (keccak256 payload hash in log). ' +
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

/** Serialise only the fields the agent needs to see from a binding. */
function bindingSummary(b: OperationBinding) {
  return { hash: b.hash, nonce: b.nonce, timestamp: b.timestamp };
}

export async function handler(input: Input): Promise<string> {
  const ts = new Date().toISOString();

  // ── 1. Kill switch ────────────────────────────────────────────────────────
  if (isKillSwitchActive()) {
    appendLog({
      timestamp: ts,
      tool: name,
      to: input.to,
      amountUsdc: input.amount,
      status: 'blocked',
      limitCode: 'KILL_SWITCH_ACTIVE',
      memo: input.memo,
    });
    return JSON.stringify({
      success: false,
      error: 'Kill switch is active. All write operations are blocked. Set KILL_SWITCH=false to re-enable.',
      limitViolation: 'KILL_SWITCH_ACTIVE',
    });
  }

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

  // ── 2. Address allowlist + 3-4. Spending limits ───────────────────────────
  try {
    checkAddressAllowlist(to);
    checkLimits(amountRaw);
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
      return JSON.stringify({
        success: false,
        error: err.message,
        limitViolation: err.code,
      });
    }
    throw err;
  }

  // ── 5. Operation binding ──────────────────────────────────────────────────
  // For a USDC ERC-20 transfer the calldata is the encoded transfer(address,uint256).
  // We bind to '0x' here because we have not yet encoded it; the unsigned-tx builder
  // will include the real calldata in the returned tx object.
  const binding = createOperationBinding(to, amountRaw, '0x');

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
      binding,
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
      binding,
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
      binding: bindingSummary(binding),
    });
  }

  // ── Unsigned mode (default) ───────────────────────────────────────────────
  const tx = buildUsdcTransfer(to, amountStr);
  const estimatedGas = await estimateGas(tx.to, tx.data, 0n);

  appendLog({
    timestamp: ts,
    tool: name,
    to: input.to,
    amountUsdc: amountStr,
    status: 'approved',
    mode: 'unsigned',
    memo: input.memo,
    binding,
  });

  return JSON.stringify({
    success: true,
    mode: 'unsigned',
    to,
    amountUsdc: amountStr,
    unsignedTransaction: tx,
    estimatedGasUsdc: estimatedGas,
    binding: bindingSummary(binding),
    instructions:
      'This transaction has NOT been sent. Sign and broadcast it with MetaMask, ' +
      'Frame, Rainbow, or the cast CLI. Once broadcast, pass the tx hash to ' +
      'get_transaction_status to confirm it.',
  });
}
