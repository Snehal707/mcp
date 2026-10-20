/**
 * Phase 3 — x402 / Nanopayments module.
 *
 * This module implements the guard stack and dispatch logic for paying
 * x402-compatible endpoints via Circle's Agent Wallet CLI.
 *
 * Guard order (same as every other write path):
 *   1. Phase 0 kill switch
 *   2. Endpoint URL validation (https:// required)
 *   3. maxPriceUsdc ceiling (server-side; never let agent raise its own cap)
 *   4. Phase 0 per-call USDC cap (treat payment like a USDC transfer)
 *   5. Phase 0 daily rolling limit
 *   6. Phase 0 address allowlist (optionally, if the payment address is known)
 *   7. Operation binding (log entry with keccak256 hash)
 *   8. Dispatch via circle services pay (Circle CLI)
 *
 * The wallet policy (Phase 1) is the PRIMARY enforcement layer; guards 3-7
 * are SECONDARY (defense-in-depth) so a misconfigured or missing CLI policy
 * never silently removes all protection.
 *
 * Note on x402Cap:
 *   The plan spec mentions checking the wallet's x402Cap from its policy.
 *   Circle's CLI policies are mainnet-only. On testnet there is no enforced
 *   x402Cap to read. We therefore apply the server-side maxPriceUsdc argument
 *   as the sole ceiling on testnet, and document that on mainnet the wallet
 *   policy (set via set_agent_policy) provides an additional Circle-enforced cap.
 */

import {
  isKillSwitchActive,
  checkLimits,
  createOperationBinding,
  appendLog,
  type OperationBinding,
} from './spending-limits.js';
import {
  inspectEndpoint,
  payEndpoint,
  AgentWalletError,
  type PayResult,
} from './circle-agent-wallet.js';
import { parseUsdc } from './arc-chain.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface X402PayInput {
  walletId: string;
  walletAddress: string;
  endpoint: string;
  maxPriceUsdc: string;
  method?: string;
  payload?: unknown;
  headers?: Record<string, string>;
  chain?: string;
}

export interface X402PayOutput {
  paidAmount: string;
  status: 'success' | 'insufficient_policy' | 'payment_required' | 'error';
  response?: unknown;
  txHash?: string;
  circleTxId?: string;
  explorerUrl?: string;
  message?: string;
  binding?: Pick<OperationBinding, 'hash' | 'nonce' | 'timestamp'>;
}

// ── Helper: URL validation ────────────────────────────────────────────────────

const UNSAFE_URL_RE = /[\s;|&$`()'"\\\n\r<>]/;

export function validateEndpointUrl(url: string): void {
  if (!url.startsWith('https://')) {
    throw Object.assign(new Error(`Endpoint must start with https://. Got: ${url}`), {
      code: 'INVALID_ENDPOINT',
    });
  }
  if (UNSAFE_URL_RE.test(url)) {
    throw Object.assign(new Error(`Endpoint URL contains unsafe characters: ${url}`), {
      code: 'UNSAFE_ENDPOINT',
    });
  }
  // Basic hostname check: must contain at least one dot
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('.')) {
      throw new Error('Hostname looks invalid');
    }
  } catch {
    throw Object.assign(new Error(`Endpoint is not a valid URL: ${url}`), {
      code: 'INVALID_ENDPOINT',
    });
  }
}

// ── Core pay function ─────────────────────────────────────────────────────────

/**
 * Pay an x402 endpoint under full Phase 0 guard stack.
 *
 * Returns a structured result — never throws policy errors as unhandled
 * exceptions. The caller (MCP tool handler) converts errors to MCP error
 * responses so the agent gets a clear, actionable message.
 */
export async function payX402(input: X402PayInput): Promise<X402PayOutput> {
  const { walletAddress, endpoint, maxPriceUsdc, method = 'GET', payload, headers, chain } = input;

  // ── Guard 1: Kill switch ───────────────────────────────────────────────────
  if (isKillSwitchActive()) {
    return {
      paidAmount: '0',
      status: 'error',
      message: 'Kill switch is active — all write operations are blocked.',
    };
  }

  // ── Guard 2: URL validation + optional endpoint allowlist ────────────────
  try {
    validateEndpointUrl(endpoint);
  } catch (err) {
    return {
      paidAmount: '0',
      status: 'error',
      message: (err as Error).message,
    };
  }

  // Optional server-wide endpoint prefix allowlist (X402_ALLOWED_ENDPOINTS)
  const allowedPrefixes = (process.env.X402_ALLOWED_ENDPOINTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedPrefixes.length > 0) {
    const isAllowed = allowedPrefixes.some((prefix) => endpoint.startsWith(prefix));
    if (!isAllowed) {
      return {
        paidAmount: '0',
        status: 'error',
        message:
          `Endpoint "${endpoint}" is not in the X402_ALLOWED_ENDPOINTS list. ` +
          `Allowed prefixes: ${allowedPrefixes.join(', ')}`,
      };
    }
  }

  // Optional server-wide x402 price ceiling (X402_MAX_PRICE_USDC)
  const serverMaxPrice = parseFloat(process.env.X402_MAX_PRICE_USDC ?? '');
  if (isFinite(serverMaxPrice) && serverMaxPrice > 0) {
    if (parseFloat(maxPriceUsdc) > serverMaxPrice) {
      return {
        paidAmount: '0',
        status: 'error',
        message:
          `maxPriceUsdc (${maxPriceUsdc}) exceeds the server-configured X402_MAX_PRICE_USDC ceiling ` +
          `(${serverMaxPrice} USDC).`,
      };
    }
  }

  // ── Guard 3: maxPriceUsdc ceiling ──────────────────────────────────────────
  const maxPrice = parseFloat(maxPriceUsdc);
  if (!isFinite(maxPrice) || maxPrice <= 0) {
    return {
      paidAmount: '0',
      status: 'error',
      message: `maxPriceUsdc must be a positive number, got: ${maxPriceUsdc}`,
    };
  }

  // ── Inspect: get actual price before committing spend budget ──────────────
  // We inspect first so we know the actual price, then run limit checks
  // against that price rather than the agent-supplied ceiling.
  let actualPriceUsdc = maxPriceUsdc;
  let inspectError: string | undefined;

  try {
    const inspection = await inspectEndpoint(endpoint, method);
    const inspectedPrice = parseFloat(inspection.priceUsdc);
    if (isFinite(inspectedPrice) && inspectedPrice > 0) {
      actualPriceUsdc = inspection.priceUsdc;
    }
    // Guard 3b: actual price must not exceed maxPriceUsdc
    if (isFinite(inspectedPrice) && inspectedPrice > maxPrice) {
      return {
        paidAmount: '0',
        status: 'payment_required',
        message:
          `Service price (${inspection.priceUsdc} USDC) exceeds your maxPriceUsdc ceiling ` +
          `(${maxPriceUsdc} USDC). Raise maxPriceUsdc or choose a cheaper endpoint.`,
      };
    }
  } catch (err) {
    // Inspect failures are non-fatal — we proceed with maxPriceUsdc as the
    // conservative limit estimate and let the CLI handle the actual negotiation.
    inspectError = err instanceof AgentWalletError ? err.message : String(err);
    // If CLI is not installed, surface immediately rather than trying to pay.
    if (err instanceof AgentWalletError && err.code === 'CLI_NOT_FOUND') {
      return {
        paidAmount: '0',
        status: 'error',
        message: err.message,
      };
    }
  }

  // ── Guards 4 + 5: Per-call cap + daily rolling limit ──────────────────────
  let amountRaw: bigint;
  try {
    amountRaw = parseUsdc(actualPriceUsdc);
  } catch {
    amountRaw = parseUsdc(maxPriceUsdc);
  }

  try {
    checkLimits(amountRaw);
  } catch (err) {
    return {
      paidAmount: '0',
      status: 'error',
      message: (err as Error).message,
    };
  }

  // ── Guard 7: Operation binding ─────────────────────────────────────────────
  const binding = createOperationBinding(endpoint, amountRaw, `x402:${method.toUpperCase()}`);

  // ── Guard 8: Dispatch ──────────────────────────────────────────────────────
  let result: PayResult;
  try {
    result = await payEndpoint(
      walletAddress,
      endpoint,
      maxPriceUsdc,
      chain ?? (process.env.ARC_NETWORK === 'mainnet' ? 'ARC' : 'ARC-TESTNET'),
      method,
      payload,
      headers,
    );
  } catch (err) {
    const message = err instanceof AgentWalletError ? err.message : String(err);
    appendLog({
      tool: 'pay_x402',
      endpoint,
      amount: actualPriceUsdc,
      status: 'failed',
      error: message,
      binding: { hash: binding.hash, nonce: binding.nonce, timestamp: binding.timestamp },
    });
    return {
      paidAmount: '0',
      status: 'error',
      message,
      binding: { hash: binding.hash, nonce: binding.nonce, timestamp: binding.timestamp },
    };
  }

  // ── Log success ────────────────────────────────────────────────────────────
  const paidAmount = result.paidAmount ?? actualPriceUsdc;
  appendLog({
    tool: 'pay_x402',
    endpoint,
    amount: paidAmount,
    status: result.status === 'success' ? 'completed' : result.status,
    ...(inspectError ? { inspectWarning: inspectError } : {}),
    binding: { hash: binding.hash, nonce: binding.nonce, timestamp: binding.timestamp },
  });

  return {
    paidAmount,
    status: result.status,
    response: result.response,
    message: result.message,
    binding: { hash: binding.hash, nonce: binding.nonce, timestamp: binding.timestamp },
  };
}
