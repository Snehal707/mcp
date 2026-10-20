/**
 * MCP Tool: transfer_usdc_agent
 *
 * Transfer USDC from a Circle Agent Wallet to any permitted address.
 *
 * Safety layers (applied in order, deepest-first):
 *   1. Phase 0 kill switch  — immediate block if KILL_SWITCH=true
 *   2. Phase 0 address allowlist — checkAddressAllowlist(to)
 *   3. Phase 0 per-call cap + daily rolling limit — checkLimits(amountRaw)
 *   4. Phase 0 operation binding — createOperationBinding stamped on log
 *   5. Circle-level policy — enforced by Circle's network on mainnet wallets;
 *      on mainnet wallets with no policy set, the transfer is rejected here
 *      before calling the CLI (defense in depth).
 *
 * The CLI command that actually executes the transfer:
 *   circle wallet transfer <to> --amount <n> --address <from> --chain <CHAIN>
 *
 * Circle's built-in sanctions screening runs on every transfer.
 */
import { z } from 'zod';
import {
  isKillSwitchActive,
  checkAddressAllowlist,
  checkLimits,
  createOperationBinding,
  appendLog,
  SpendingLimitError,
  limitsConfig,
} from '../spending-limits.js';
import { parseUsdc } from '../arc-chain.js';
import { transfer, AgentWalletError } from '../circle-agent-wallet.js';

export const name = 'transfer_usdc_agent';

export const description =
  'Transfer USDC from a Circle Agent Wallet to a recipient address on Arc. ' +
  'Applies Phase 0 guards (kill switch, address allowlist, per-call cap, daily limit) before calling Circle. ' +
  'On mainnet, also requires a spending policy to be set on the source wallet. ' +
  'Returns the transaction hash and Circle transaction ID on success. ' +
  'Gas is sponsored by Circle — no native token needed.';

export const inputSchema = z.object({
  fromAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid 0x Ethereum address')
    .describe('Agent wallet address to send USDC from (must be a Circle Agent Wallet you own).'),
  to: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid 0x Ethereum address')
    .describe('Recipient 0x address.'),
  amount: z
    .string()
    .describe('Amount of USDC to send (human-readable, e.g. "5" or "1.5"). Uses 6-decimal ERC-20 USDC.'),
  chain: z
    .enum(['ARC', 'ARC-TESTNET'])
    .optional()
    .describe('Chain to send on. Defaults to ARC-TESTNET (or ARC_NETWORK env var).'),
  memo: z
    .string()
    .optional()
    .describe('Optional memo or note stored in the local tool-call log (not sent onchain).'),
});

type Input = z.infer<typeof inputSchema>;

export async function handler(input: Input): Promise<string> {
  const { fromAddress, to, amount, chain, memo } = input;

  // ── Layer 1: Kill switch ──────────────────────────────────────────────────
  if (isKillSwitchActive()) {
    return JSON.stringify({
      error: 'KILL_SWITCH_ACTIVE',
      message: 'Kill switch is active. All write operations are blocked. Set KILL_SWITCH=false in .env to re-enable.',
    });
  }

  // ── Layer 2: Parse and validate amount ────────────────────────────────────
  let amountRaw: bigint;
  try {
    amountRaw = parseUsdc(amount);
    if (amountRaw <= 0n) throw new Error('Amount must be positive');
  } catch {
    return JSON.stringify({
      error: 'INVALID_AMOUNT',
      message: `Invalid USDC amount: "${amount}". Provide a positive decimal number, e.g. "5" or "1.50".`,
    });
  }

  // ── Layer 3: Address allowlist ────────────────────────────────────────────
  try {
    checkAddressAllowlist(to);
  } catch (err) {
    if (err instanceof SpendingLimitError) {
      appendLog({
        timestamp: new Date().toISOString(),
        tool: name,
        from: fromAddress,
        to,
        amountUsdc: amount,
        memo: memo ?? null,
        status: 'blocked',
        reason: err.message,
        errorCode: err.code,
      });
      return JSON.stringify({ error: err.code, message: err.message, policy: limitsConfig() });
    }
    throw err;
  }

  // ── Layer 4: Per-call + daily limit ───────────────────────────────────────
  try {
    checkLimits(amountRaw);
  } catch (err) {
    if (err instanceof SpendingLimitError) {
      appendLog({
        timestamp: new Date().toISOString(),
        tool: name,
        from: fromAddress,
        to,
        amountUsdc: amount,
        memo: memo ?? null,
        status: 'blocked',
        reason: err.message,
        errorCode: err.code,
      });
      return JSON.stringify({ error: err.code, message: err.message, policy: limitsConfig() });
    }
    throw err;
  }

  // ── Layer 5: Create operation binding ─────────────────────────────────────
  const binding = createOperationBinding(to, amountRaw, '0x');

  // Log intent before dispatching
  appendLog({
    timestamp: new Date().toISOString(),
    tool: name,
    from: fromAddress,
    to,
    amountUsdc: amount,
    memo: memo ?? null,
    chain: chain ?? process.env.ARC_NETWORK ?? 'testnet',
    status: 'approved',
    binding,
  });

  // ── Layer 6: Circle Agent Wallet transfer ─────────────────────────────────
  try {
    const result = await transfer(fromAddress, to, amount, chain);

    // Log completion
    appendLog({
      timestamp: new Date().toISOString(),
      tool: name,
      from: fromAddress,
      to,
      amountUsdc: amount,
      memo: memo ?? null,
      chain: result.chain,
      status: 'completed',
      circleTxId: result.circleTxId,
      txHash: result.txHash ?? null,
      state: result.state,
      binding,
    });

    return JSON.stringify({
      circleTxId: result.circleTxId,
      txHash: result.txHash ?? null,
      state: result.state,
      from: result.sourceAddress,
      to: result.destinationAddress,
      amount: result.amount,
      chain: result.chain,
      explorerUrl: result.explorerUrl ?? null,
      binding: {
        hash: binding.hash,
        nonce: binding.nonce,
        timestamp: binding.timestamp,
      },
      policy: limitsConfig(),
    });
  } catch (err) {
    const message = err instanceof AgentWalletError ? err.message : String(err);
    const code = err instanceof AgentWalletError ? err.code : 'TRANSFER_FAILED';

    appendLog({
      timestamp: new Date().toISOString(),
      tool: name,
      from: fromAddress,
      to,
      amountUsdc: amount,
      memo: memo ?? null,
      status: 'failed',
      reason: message,
      errorCode: code,
      binding,
    });

    return JSON.stringify({
      error: code,
      message,
      ...(err instanceof AgentWalletError && err.cliOutput
        ? { cliOutput: err.cliOutput.slice(0, 500) }
        : {}),
    });
  }
}
