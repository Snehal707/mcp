/**
 * Circle Developer-Controlled Wallets adapter.
 *
 * Active only when AGENT_MODE=circle. Private keys are held by Circle's
 * secure infrastructure under your encrypted entity secret — they never
 * exist in plaintext on this server.
 *
 * Requires CIRCLE_API_KEY and ENTITY_SECRET in the environment.
 * See: https://developers.circle.com/wallets/dev-controlled/register-entity-secret
 */
import { v4 as uuidv4 } from 'uuid';
import { formatUsdc } from './arc-chain.js';

// Lazy-initialise the Circle SDK so the server starts cleanly in "unsigned" mode
// without requiring credentials.
let _sdk: Awaited<ReturnType<typeof initSdk>> | null = null;

async function initSdk() {
  const { initiateDeveloperControlledWalletsClient } = await import(
    '@circle-fin/developer-controlled-wallets'
  );
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    throw new Error(
      'AGENT_MODE=circle requires CIRCLE_API_KEY and ENTITY_SECRET in the environment. ' +
        'See mcp/env.example.txt for setup instructions.',
    );
  }
  return initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
}

async function getSdk() {
  if (!_sdk) _sdk = await initSdk();
  return _sdk;
}

// ── Transaction status polling ────────────────────────────────────────────────

const TERMINAL_STATES = new Set(['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED']);
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000;

interface CircleTx {
  id: string;
  state: string;
  txHash?: string;
  errorCode?: string;
  errorMessage?: string;
}

async function pollUntilTerminal(txId: string): Promise<CircleTx> {
  const sdk = await getSdk();
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const resp = await sdk.getTransaction({ id: txId });
    const tx = resp.data?.transaction as CircleTx | undefined;
    if (!tx) throw new Error(`Transaction ${txId} not found in Circle API`);
    if (TERMINAL_STATES.has(tx.state)) return tx;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Transaction ${txId} did not reach a terminal state within ${POLL_TIMEOUT_MS / 1000}s`,
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface CircleTxResult {
  circleTransactionId: string;
  txHash: string | null;
  state: string;
  explorerUrl: string | null;
}

/**
 * Send USDC from the configured agent wallet to `to`.
 * @param to       Recipient 0x address
 * @param amountRaw  Raw 6-decimal USDC amount as a string (e.g. "5000000" = 5 USDC)
 */
export async function sendUsdc(
  to: string,
  amountRaw: string,
): Promise<CircleTxResult> {
  const sdk = await getSdk();
  const walletId = process.env.CIRCLE_WALLET_ID;
  if (!walletId) {
    throw new Error(
      'CIRCLE_WALLET_ID is not set. Create an agent wallet via the Circle API and set its ID in the environment.',
    );
  }

  const resp = await sdk.createTransaction({
    walletId,
    tokenAddress: '0x3600000000000000000000000000000000000000',
    destinationAddress: to,
    amounts: [formatUsdc(BigInt(amountRaw))], // Circle API wants human-readable amounts
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    idempotencyKey: uuidv4(),
  });

  const txId = resp.data?.id;
  if (!txId) throw new Error('Circle API did not return a transaction ID');

  const finalTx = await pollUntilTerminal(txId);

  if (finalTx.state !== 'COMPLETE') {
    throw new Error(
      `Circle transaction ${txId} ended in state ${finalTx.state}` +
        (finalTx.errorCode ? ` (${finalTx.errorCode}: ${finalTx.errorMessage})` : ''),
    );
  }

  const explorerBase = process.env.ARC_NETWORK === 'mainnet'
    ? 'https://explorer.arc.io'
    : 'https://explorer.testnet.arc.io';

  return {
    circleTransactionId: txId,
    txHash: finalTx.txHash ?? null,
    state: finalTx.state,
    explorerUrl: finalTx.txHash ? `${explorerBase}/tx/${finalTx.txHash}` : null,
  };
}

/**
 * Execute an arbitrary contract function via Circle developer-controlled wallets.
 *
 * @param contractAddress  Target contract 0x address
 * @param abiFunctionSignature  e.g. "transfer(address,uint256)"
 * @param abiParameters  JSON-encoded array of parameter values
 * @param valueUsdc  Optional USDC value to send with the call (human-readable, e.g. "1.5")
 */
export async function executeContract(
  contractAddress: string,
  abiFunctionSignature: string,
  abiParameters: unknown[],
  valueUsdc?: string,
): Promise<CircleTxResult> {
  const sdk = await getSdk();
  const walletId = process.env.CIRCLE_WALLET_ID;
  if (!walletId) {
    throw new Error(
      'CIRCLE_WALLET_ID is not set. Create an agent wallet via the Circle API and set its ID in the environment.',
    );
  }

  const resp = await sdk.createContractExecutionTransaction({
    walletId,
    contractAddress,
    abiFunctionSignature,
    abiParameters: abiParameters as string[],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    idempotencyKey: uuidv4(),
    ...(valueUsdc ? { amount: valueUsdc } : {}),
  });

  const txId = resp.data?.id;
  if (!txId) throw new Error('Circle API did not return a transaction ID');

  const finalTx = await pollUntilTerminal(txId);

  if (finalTx.state !== 'COMPLETE') {
    throw new Error(
      `Circle transaction ${txId} ended in state ${finalTx.state}` +
        (finalTx.errorCode ? ` (${finalTx.errorCode}: ${finalTx.errorMessage})` : ''),
    );
  }

  const explorerBase = process.env.ARC_NETWORK === 'mainnet'
    ? 'https://explorer.arc.io'
    : 'https://explorer.testnet.arc.io';

  return {
    circleTransactionId: txId,
    txHash: finalTx.txHash ?? null,
    state: finalTx.state,
    explorerUrl: finalTx.txHash ? `${explorerBase}/tx/${finalTx.txHash}` : null,
  };
}

/**
 * Look up a Circle transaction by its SDK transaction ID.
 */
export async function getCircleTransactionStatus(
  txId: string,
): Promise<{ id: string; state: string; txHash?: string }> {
  const sdk = await getSdk();
  const resp = await sdk.getTransaction({ id: txId });
  const tx = resp.data?.transaction as CircleTx | undefined;
  if (!tx) throw new Error(`Transaction ${txId} not found`);
  return { id: tx.id, state: tx.state, txHash: tx.txHash };
}
