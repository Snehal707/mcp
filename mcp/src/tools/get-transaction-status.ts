/**
 * MCP Tool: get_transaction_status
 *
 * Check the confirmation status of a transaction on Arc.
 * Accepts either:
 *   - A raw 0x transaction hash (queries Arc RPC directly via viem)
 *   - A Circle SDK transaction ID (UUID format, queries Circle API)
 */
import { z } from 'zod';
import { publicClient, activeChain } from '../arc-chain.js';
import { appendLog } from '../spending-limits.js';

export const name = 'get_transaction_status';

export const description =
  'Check the confirmation status of a transaction on Arc. ' +
  'Accepts a 0x transaction hash (queries Arc RPC) or a Circle SDK transaction ID ' +
  '(UUID format, queries Circle API in circle mode). ' +
  'Returns block number, confirmation status, gas used, and an explorer link.';

export const inputSchema = z.object({
  id: z
    .string()
    .describe(
      'Either a 0x transaction hash (66 characters) or a Circle SDK transaction ID (UUID format). ' +
        'Example hash: 0xabc123... ' +
        'Example Circle ID: 3ff57d82-1234-5678-abcd-ef0123456789',
    ),
});

export type Input = z.infer<typeof inputSchema>;

function isCircleUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function isTxHash(id: string): boolean {
  return /^0x[0-9a-f]{64}$/i.test(id);
}

export async function handler(input: Input): Promise<string> {
  const ts = new Date().toISOString();

  if (!isCircleUuid(input.id) && !isTxHash(input.id)) {
    throw new Error(
      `"${input.id}" is not a valid transaction hash (0x + 64 hex chars) ` +
        'or Circle transaction ID (UUID format).',
    );
  }

  // ── Circle UUID path ──────────────────────────────────────────────────────
  if (isCircleUuid(input.id)) {
    const mode = (process.env.AGENT_MODE ?? 'unsigned').toLowerCase();
    if (mode !== 'circle') {
      return JSON.stringify({
        success: false,
        error:
          `"${input.id}" looks like a Circle transaction ID (UUID format) but ` +
          'AGENT_MODE is not set to "circle". Switch to circle mode or provide a 0x tx hash instead.',
      });
    }

    const { getCircleTransactionStatus } = await import('../circle-wallet.js');
    const tx = await getCircleTransactionStatus(input.id);

    appendLog({
      timestamp: ts,
      tool: name,
      id: input.id,
      idType: 'circle-uuid',
      state: tx.state,
      status: 'completed',
    });

    const explorerBase = process.env.ARC_NETWORK === 'mainnet'
      ? 'https://explorer.arc.io'
      : 'https://explorer.testnet.arc.io';

    return JSON.stringify({
      success: true,
      idType: 'circle-transaction-id',
      circleTransactionId: tx.id,
      state: tx.state,
      txHash: tx.txHash ?? null,
      explorerUrl: tx.txHash ? `${explorerBase}/tx/${tx.txHash}` : null,
      isTerminal: ['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED'].includes(tx.state),
      isSuccess: tx.state === 'COMPLETE',
    });
  }

  // ── Raw tx hash path (viem) ───────────────────────────────────────────────
  const hash = input.id as `0x${string}`;

  // Try to get the receipt (null if not yet mined)
  let receipt = null;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash });
  } catch {
    // TransactionReceiptNotFoundError — tx not yet mined or unknown hash
  }

  if (!receipt) {
    // Try to at least confirm the tx exists in the mempool
    let pending = false;
    try {
      await publicClient.getTransaction({ hash });
      pending = true;
    } catch {
      // not found at all
    }

    appendLog({
      timestamp: ts,
      tool: name,
      id: input.id,
      idType: 'tx-hash',
      confirmed: false,
      status: 'completed',
    });

    return JSON.stringify({
      success: true,
      idType: 'tx-hash',
      txHash: hash,
      status: pending ? 'pending' : 'not_found',
      confirmed: false,
      blockNumber: null,
      gasUsed: null,
      explorerUrl: `${activeChain.blockExplorers.default.url}/tx/${hash}`,
      network: activeChain.name,
    });
  }

  appendLog({
    timestamp: ts,
    tool: name,
    id: input.id,
    idType: 'tx-hash',
    confirmed: true,
    blockNumber: receipt.blockNumber.toString(),
    status: 'completed',
  });

  return JSON.stringify({
    success: true,
    idType: 'tx-hash',
    txHash: hash,
    status: receipt.status === 'success' ? 'success' : 'reverted',
    confirmed: true,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    explorerUrl: `${activeChain.blockExplorers.default.url}/tx/${hash}`,
    network: activeChain.name,
    chainId: activeChain.id,
  });
}
