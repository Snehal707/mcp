/**
 * MCP Tool: call_contract_write
 *
 * Execute a state-changing function on any contract deployed on Arc.
 * Applies spending-limit guardrails when a USDC value is attached.
 *
 * Two execution modes via AGENT_MODE:
 *   "circle"   — Circle Developer-Controlled Wallets API executes the call
 *   "unsigned" — Returns an unsigned tx object for the human operator to sign
 */
import { z } from 'zod';
import { isAddress } from 'viem';
import { parseUsdc } from '../arc-chain.js';
import { checkLimits, SpendingLimitError, appendLog } from '../spending-limits.js';
import * as circleWallet from '../circle-wallet.js';
import { buildContractWrite, estimateGas } from '../unsigned-tx.js';

export const name = 'call_contract_write';

export const description =
  'Execute a state-changing (non-view) function on any smart contract deployed on Arc. ' +
  'Supports attaching USDC as msg.value for payable functions. ' +
  'Spending-limit guardrails are enforced when valueUsdc > 0. ' +
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

export async function handler(input: Input): Promise<string> {
  const ts = new Date().toISOString();

  if (!isAddress(input.contractAddress)) {
    throw new Error(`"${input.contractAddress}" is not a valid contract address.`);
  }

  const valueStr = (input.valueUsdc ?? '0').trim();
  const hasValue = parseFloat(valueStr) > 0;
  const valueRaw = hasValue ? parseUsdc(valueStr) : 0n;

  // Spending-limit check when USDC value is attached
  if (hasValue) {
    try {
      checkLimits(input.contractAddress, valueRaw);
    } catch (err) {
      if (err instanceof SpendingLimitError) {
        appendLog({
          timestamp: ts,
          tool: name,
          contractAddress: input.contractAddress,
          functionName: input.functionName,
          valueUsdc: valueStr,
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
  }

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
    instructions:
      'This transaction has NOT been sent. Sign and broadcast it with MetaMask, ' +
      'Frame, Rainbow, or the cast CLI. Pass the resulting tx hash to ' +
      'get_transaction_status to confirm completion.',
  });
}
