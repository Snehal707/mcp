/**
 * MCP Tool: call_contract_write
 *
 * Execute a state-changing function on any contract deployed on Arc.
 * Phase 0 guard order:
 *   1. Kill switch          — KILL_SWITCH=true blocks immediately
 *   2. Contract allowlist   — contract must be in ALLOWED_CONTRACTS
 *   3. Selector allowlist   — if ALLOWED_SELECTORS set, 4-byte selector must match
 *   4. Address allowlist    — contract address checked against ALLOWED_ADDRESSES
 *   5. Spending limits      — per-call cap + daily rolling limit (when valueUsdc > 0)
 *   6. Operation binding    — keccak256 payload hash stamped on every log entry
 *
 * Two execution modes via AGENT_MODE:
 *   "circle"   — Circle Developer-Controlled Wallets API executes the call
 *   "unsigned" — Returns an unsigned tx object for the human operator to sign
 */
import { z } from 'zod';
import { isAddress, encodeFunctionData } from 'viem';
import { parseUsdc } from '../arc-chain.js';
import {
  isKillSwitchActive,
  checkContractAllowlist,
  checkAddressAllowlist,
  checkLimits,
  createOperationBinding,
  SpendingLimitError,
  appendLog,
  type OperationBinding,
} from '../spending-limits.js';
import * as circleWallet from '../circle-wallet.js';
import { buildContractWrite, estimateGas } from '../unsigned-tx.js';

export const name = 'call_contract_write';

export const description =
  'Execute a state-changing (non-view) function on any smart contract deployed on Arc. ' +
  'Phase 0 guards: kill switch, contract allowlist (ALLOWED_CONTRACTS required), ' +
  'optional selector allowlist (ALLOWED_SELECTORS), address allowlist, spending limits, ' +
  'and operation binding (keccak256 payload hash in log). ' +
  'Supports attaching USDC as msg.value for payable functions. ' +
  'In "circle" mode the call is signed via Circle Developer-Controlled Wallets. ' +
  'In "unsigned" mode an unsigned transaction object is returned for manual signing.';

export const inputSchema = z.object({
  contractAddress: z
    .string()
    .describe('The 0x address of the contract to call.'),
  abi: z
    .string()
    .describe(
      'Contract ABI as a JSON string (array of ABI objects). ' +
        'Only the function being called needs to be present. ' +
        'Example: \'[{"name":"mint","type":"function","stateMutability":"nonpayable",' +
        '"inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[]}]\'',
    ),
  functionName: z.string().describe('Name of the function to call.'),
  args: z
    .array(z.unknown())
    .optional()
    .default([])
    .describe(
      'Array of function arguments. Pass uint256 values as decimal strings. ' +
        'Pass addresses as 0x strings. Pass bytes as 0x-prefixed hex strings.',
    ),
  valueUsdc: z
    .string()
    .optional()
    .describe(
      'Amount of USDC to attach as msg.value (for payable functions). ' +
        'Human-readable decimal string, e.g. "1.5". Omit or pass "0" for non-payable functions. ' +
        'This amount is subject to spending-limit checks.',
    ),
  memo: z
    .string()
    .optional()
    .describe('Optional memo or description (logged, not sent onchain).'),
});

export type Input = z.infer<typeof inputSchema>;

/** Serialise only the fields the agent needs to see from a binding. */
function bindingSummary(b: OperationBinding) {
  return { hash: b.hash, nonce: b.nonce, timestamp: b.timestamp };
}

/**
 * Derive the 4-byte function selector from the ABI + functionName.
 * Returns undefined if the ABI cannot be parsed (non-fatal; selector check skipped).
 */
function deriveSelector(abiJson: string, functionName: string): string | undefined {
  try {
    const abiArr = JSON.parse(abiJson) as Array<{
      name: string;
      type: string;
      inputs?: Array<{ type: string }>;
    }>;
    const fn = abiArr.find((f) => f.type === 'function' && f.name === functionName);
    if (!fn) return undefined;
    const paramTypes = (fn.inputs ?? []).map((p) => p.type).join(',');
    const sig = `${functionName}(${paramTypes})`;
    // Encode with empty args just to get the selector
    const encoded = encodeFunctionData({
      abi: abiArr as never,
      functionName,
      args: [],
    });
    // encodeFunctionData returns 0x + 8 hex selector + encoded args
    // For selector extraction we just need the first 10 chars
    void encoded; // unused — use the canonical keccak approach via viem instead
    // Compute selector from signature string via keccak (viem doesn't expose this directly)
    // Fall back to the encoded calldata slice which is always correct
    return sig; // return the sig string; checkContractAllowlist expects 0x-selector OR sig
  } catch {
    return undefined;
  }
}

export async function handler(input: Input): Promise<string> {
  const ts = new Date().toISOString();

  // ── 1. Kill switch ────────────────────────────────────────────────────────
  if (isKillSwitchActive()) {
    appendLog({
      timestamp: ts,
      tool: name,
      contractAddress: input.contractAddress,
      functionName: input.functionName,
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

  if (!isAddress(input.contractAddress)) {
    throw new Error(`"${input.contractAddress}" is not a valid contract address.`);
  }

  const valueStr = (input.valueUsdc ?? '0').trim();
  const hasValue = parseFloat(valueStr) > 0;
  const valueRaw = hasValue ? parseUsdc(valueStr) : 0n;

  // ── 2. Contract allowlist + 3. Selector allowlist ─────────────────────────
  // Build calldata early so we can extract the real 4-byte selector
  let calldata: string = '0x';
  try {
    const encoded = buildContractWrite(
      input.contractAddress,
      input.abi,
      input.functionName,
      input.args as unknown[],
      hasValue ? valueStr : undefined,
    );
    calldata = encoded.data ?? '0x';
  } catch {
    // If we can't build calldata yet (e.g. bad ABI), derive selector from ABI string
  }

  // Extract 4-byte selector from calldata (0x + 8 hex = 10 chars)
  const selectorFromCalldata =
    calldata.length >= 10 ? calldata.slice(0, 10) : deriveSelector(input.abi, input.functionName);

  try {
    checkContractAllowlist(input.contractAddress, selectorFromCalldata);
    checkAddressAllowlist(input.contractAddress);
    if (hasValue) checkLimits(valueRaw);
  } catch (err) {
    if (err instanceof SpendingLimitError) {
      appendLog({
        timestamp: ts,
        tool: name,
        contractAddress: input.contractAddress,
        functionName: input.functionName,
        valueUsdc: hasValue ? valueStr : undefined,
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

  // ── 6. Operation binding ──────────────────────────────────────────────────
  const binding = createOperationBinding(input.contractAddress, valueRaw, calldata);

  const mode = (process.env.AGENT_MODE ?? 'unsigned').toLowerCase();

  // ── Circle mode ───────────────────────────────────────────────────────────
  if (mode === 'circle') {
    appendLog({
      timestamp: ts,
      tool: name,
      contractAddress: input.contractAddress,
      functionName: input.functionName,
      valueUsdc: hasValue ? valueStr : undefined,
      status: 'approved',
      mode: 'circle',
      memo: input.memo,
      binding,
    });

    // Build abiFunctionSignature from the ABI JSON
    let abiFunctionSignature: string;
    try {
      const abiArr = JSON.parse(input.abi) as Array<{
        name: string;
        type: string;
        inputs?: Array<{ type: string }>;
      }>;
      const fn = abiArr.find(
        (f) => f.type === 'function' && f.name === input.functionName,
      );
      if (!fn) throw new Error(`Function ${input.functionName} not found in ABI`);
      const paramTypes = (fn.inputs ?? []).map((p) => p.type).join(',');
      abiFunctionSignature = `${input.functionName}(${paramTypes})`;
    } catch (err) {
      throw new Error(
        `Could not build function signature from ABI: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = await circleWallet.executeContract(
      input.contractAddress,
      abiFunctionSignature,
      input.args as unknown[],
      hasValue ? valueStr : undefined,
    );

    appendLog({
      timestamp: new Date().toISOString(),
      tool: name,
      contractAddress: input.contractAddress,
      functionName: input.functionName,
      valueUsdc: hasValue ? valueStr : undefined,
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
      contractAddress: input.contractAddress,
      functionName: input.functionName,
      args: input.args,
      valueUsdc: hasValue ? valueStr : '0',
      circleTransactionId: result.circleTransactionId,
      txHash: result.txHash,
      state: result.state,
      explorerUrl: result.explorerUrl,
      binding: bindingSummary(binding),
    });
  }

  // ── Unsigned mode (default) ───────────────────────────────────────────────
  const tx = buildContractWrite(
    input.contractAddress,
    input.abi,
    input.functionName,
    input.args as unknown[],
    hasValue ? valueStr : undefined,
  );

  const estimatedGas = await estimateGas(
    tx.to,
    tx.data,
    BigInt(tx.value === '0x0' ? 0 : parseInt(tx.value, 16)),
  );

  appendLog({
    timestamp: ts,
    tool: name,
    contractAddress: input.contractAddress,
    functionName: input.functionName,
    valueUsdc: hasValue ? valueStr : undefined,
    status: 'approved',
    mode: 'unsigned',
    memo: input.memo,
    binding,
  });

  return JSON.stringify({
    success: true,
    mode: 'unsigned',
    contractAddress: input.contractAddress,
    functionName: input.functionName,
    args: input.args,
    valueUsdc: hasValue ? valueStr : '0',
    unsignedTransaction: tx,
    estimatedGasUsdc: estimatedGas,
    binding: bindingSummary(binding),
    instructions:
      'This transaction has NOT been sent. Sign and broadcast it with MetaMask, ' +
      'Frame, Rainbow, or the cast CLI. Pass the resulting tx hash to ' +
      'get_transaction_status to confirm completion.',
  });
}
