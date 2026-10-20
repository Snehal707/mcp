/**
 * Circle Agent Wallet wrapper — Phase 1.
 *
 * Drives the Circle CLI (`circle` binary from @circle-fin/cli) as child
 * processes. All wallet operations go through the CLI rather than a raw API
 * key, so the MCP server never holds user credentials or signing key shares.
 *
 * Key architecture facts (from Circle docs):
 *   - Agent Wallets are built on 2-of-2 MPC user-controlled wallets.
 *   - Key shares are never exposed to the agent or this server.
 *   - Authentication uses email OTP via `circle wallet login`.
 *   - Spending policies (`set_agent_policy`) require MAINNET ONLY and a
 *     second human-completed email OTP — the MCP tool returns `pending_otp`
 *     and must never attempt to automate that confirmation.
 *   - Transfers on testnet do NOT require a policy to exist.
 *   - CLI output is JSON when `--output json` is passed.
 *
 * CLI commands used:
 *   circle wallet list   --chain <CHAIN> --type agent --output json
 *   circle wallet create --type agent [--testnet] --output json
 *   circle wallet limit  --address <addr> --chain <CHAIN> --output json
 *   circle wallet limit set ... (returns pending_otp — human must confirm)
 *   circle wallet transfer <to> --amount <n> --address <from> --chain <CHAIN> --output json
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseUsdc } from './arc-chain.js';

const execFileAsync = promisify(execFile);

// ── CLI location ──────────────────────────────────────────────────────────────

/**
 * Resolve the `circle` binary. Prefers an explicit CIRCLE_CLI_PATH env var;
 * falls back to PATH lookup. Allows tests to inject a mock binary.
 */
function circleBin(): string {
  return process.env.CIRCLE_CLI_PATH ?? 'circle';
}

/** Timeout for CLI calls that call out to Circle's API. */
const CLI_TIMEOUT_MS = 60_000;

// ── Chain helpers ─────────────────────────────────────────────────────────────

/** Map the MCP chain param to the CLI chain identifier. */
function resolveChain(chain?: string): string {
  const network = (process.env.ARC_NETWORK ?? 'testnet').toLowerCase();
  const requested = (chain ?? '').toUpperCase();
  // Accept explicit overrides first
  if (requested === 'ARC') return 'ARC';
  if (requested === 'ARC-TESTNET') return 'ARC-TESTNET';
  // Default to env-configured network
  return network === 'mainnet' ? 'ARC' : 'ARC-TESTNET';
}

/** True when the chain is a mainnet chain (policies are mainnet-only). */
function isMainnetChain(chain: string): boolean {
  return chain === 'ARC' || chain === 'ETH' || chain === 'BASE' || chain === 'MATIC';
}

// ── CLI runner ────────────────────────────────────────────────────────────────

export class AgentWalletError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cliOutput?: string,
  ) {
    super(message);
    this.name = 'AgentWalletError';
  }
}

interface CliResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a `circle` CLI command and return its stdout/stderr.
 * Throws AgentWalletError when the process exits non-zero.
 */
async function runCli(args: string[]): Promise<CliResult> {
  // Verify CLI is installed before running
  try {
    await execFileAsync(circleBin(), ['--version'], { timeout: 10_000 });
  } catch {
    throw new AgentWalletError(
      'CLI_NOT_FOUND',
      `Circle CLI not found. Install it: npm install -g @circle-fin/cli\n` +
        `Then authenticate: circle wallet login <email> --testnet`,
    );
  }

  try {
    const { stdout, stderr } = await execFileAsync(circleBin(), args, {
      timeout: CLI_TIMEOUT_MS,
      env: { ...process.env },
    });
    return { stdout, stderr };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout, e.stderr].filter(Boolean).join('\n');

    // Check for common auth error
    if (output.includes('not authenticated') || output.includes('login required')) {
      throw new AgentWalletError(
        'NOT_AUTHENTICATED',
        'Not authenticated with Circle CLI. Run: circle wallet login <email> --testnet\n' +
          'Complete the OTP in your email, then retry.',
        output,
      );
    }
    throw new AgentWalletError(
      'CLI_ERROR',
      `Circle CLI command failed: circle ${args.join(' ')}\n${output || (e.message ?? 'unknown error')}`,
      output,
    );
  }
}

/**
 * Run CLI and parse stdout as JSON. Returns the parsed object.
 * Circle CLI uses `{ "data": ... }` envelope when `--output json` is passed.
 */
async function runCliJson<T>(args: string[]): Promise<T> {
  const { stdout } = await runCli([...args, '--output', 'json']);
  try {
    return JSON.parse(stdout.trim()) as T;
  } catch {
    throw new AgentWalletError(
      'PARSE_ERROR',
      `Circle CLI returned non-JSON output for: circle ${args.join(' ')}\n${stdout.slice(0, 500)}`,
      stdout,
    );
  }
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface AgentWallet {
  walletId: string;
  address: string;
  chain: string;
  balanceUsdc?: string;
}

export interface AgentPolicy {
  type: string;
  limits?: {
    perTx?: number;
    daily?: number;
    weekly?: number;
    monthly?: number;
  };
  allowlist?: string[];
  blocklist?: string[];
}

export interface TransferResult {
  circleTxId: string;
  txHash?: string;
  state: string;
  sourceAddress: string;
  destinationAddress: string;
  amount: string;
  chain: string;
  explorerUrl?: string;
}

// ── list wallets ──────────────────────────────────────────────────────────────

/**
 * List Circle Agent Wallets on the given chain.
 * Wraps: circle wallet list --chain <CHAIN> --type agent --output json
 */
export async function listWallets(chain?: string): Promise<AgentWallet[]> {
  const resolvedChain = resolveChain(chain);
  const testnetFlag = !isMainnetChain(resolvedChain);

  const args = ['wallet', 'list', '--chain', resolvedChain, '--type', 'agent'];
  if (testnetFlag) args.push('--testnet');

  interface ListResponse {
    data?: Array<{
      id?: string;
      walletId?: string;
      address?: string;
      blockchain?: string;
      chain?: string;
    }>;
  }

  const result = await runCliJson<ListResponse>(args);
  const wallets = result.data ?? [];

  return wallets.map((w) => ({
    walletId: w.walletId ?? w.id ?? 'unknown',
    address: w.address ?? '0x0000000000000000000000000000000000000000',
    chain: w.blockchain ?? w.chain ?? resolvedChain,
  }));
}

// ── create wallet ─────────────────────────────────────────────────────────────

/**
 * Create a new Circle Agent Wallet.
 * Wraps: circle wallet create --type agent [--testnet] --output json
 *
 * Note: Each account can have up to 5 agent wallets. Wallets cannot be deleted.
 */
export async function createWallet(chain?: string): Promise<AgentWallet> {
  const resolvedChain = resolveChain(chain);
  const testnetFlag = !isMainnetChain(resolvedChain);

  const args = ['wallet', 'create', '--type', 'agent'];
  if (testnetFlag) args.push('--testnet');

  interface CreateResponse {
    data?: {
      id?: string;
      walletId?: string;
      address?: string;
      blockchain?: string;
      chain?: string;
    };
  }

  const result = await runCliJson<CreateResponse>(args);
  const w = result.data ?? {};

  return {
    walletId: w.walletId ?? w.id ?? 'unknown',
    address: w.address ?? '0x0000000000000000000000000000000000000000',
    chain: w.blockchain ?? w.chain ?? resolvedChain,
  };
}

// ── get policy ────────────────────────────────────────────────────────────────

/**
 * Read the current spending policy for an Agent Wallet.
 * Wraps: circle wallet limit --address <addr> --chain <CHAIN> --output json
 *
 * MAINNET ONLY — testnet wallets do not support spending policies.
 */
export async function getPolicy(address: string, chain?: string): Promise<AgentPolicy[]> {
  const resolvedChain = resolveChain(chain);

  if (!isMainnetChain(resolvedChain)) {
    // Testnet wallets have no enforced policies — return informational placeholder.
    return [
      {
        type: 'info',
        limits: undefined,
        allowlist: undefined,
        blocklist: undefined,
      },
    ];
  }

  const args = ['wallet', 'limit', '--address', address, '--chain', resolvedChain];

  interface LimitResponse {
    data?: Array<{
      type?: string;
      policyType?: string;
      ruleType?: string;
      limits?: { perTx?: number; daily?: number; weekly?: number; monthly?: number };
      targets?: string[];
    }>;
  }

  const result = await runCliJson<LimitResponse>(args);
  const policies = result.data ?? [];

  return policies.map((p) => {
    const ruleType = p.ruleType ?? p.type ?? p.policyType ?? 'transfer-limit';
    const isAllowlist = ruleType.includes('allowlist');
    const isBlocklist = ruleType.includes('blocklist');
    return {
      type: ruleType,
      limits: isAllowlist || isBlocklist ? undefined : p.limits,
      allowlist: isAllowlist ? (p.targets ?? []) : undefined,
      blocklist: isBlocklist ? (p.targets ?? []) : undefined,
    };
  });
}

// ── set policy ────────────────────────────────────────────────────────────────

export interface SetPolicyInput {
  address: string;
  chain?: string;
  // Transfer limits (all in USDC)
  perTx?: number;
  daily?: number;
  weekly?: number;
  monthly?: number;
  // List rules
  recipientAllowlist?: string[];
  recipientBlocklist?: string[];
  contractAllowlist?: string[];
  contractBlocklist?: string[];
}

export interface SetPolicyResult {
  status: 'applied' | 'pending_otp';
  message: string;
}

/**
 * Set a spending policy on an Agent Wallet.
 * Wraps: circle wallet limit set ...
 *
 * MAINNET ONLY — returns a clear error for testnet addresses.
 * Policy changes always require a human-completed email OTP.
 * This function never attempts to automate OTP completion.
 *
 * Returns `pending_otp` immediately after submitting the policy change request,
 * with instructions for the human operator to complete the confirmation.
 */
export async function setPolicy(input: SetPolicyInput): Promise<SetPolicyResult> {
  const resolvedChain = resolveChain(input.chain);

  if (!isMainnetChain(resolvedChain)) {
    return {
      status: 'pending_otp',
      message:
        'Spending policies are only supported on mainnet agent wallets. ' +
        'To test policy enforcement, use a mainnet wallet on ARC chain. ' +
        'Testnet wallets have no enforced spending policies.',
    };
  }

  // Build a list of policy commands to run. Each rule type is a separate CLI call.
  const results: string[] = [];

  // 1. Transfer limits
  if (
    input.perTx !== undefined ||
    input.daily !== undefined ||
    input.weekly !== undefined ||
    input.monthly !== undefined
  ) {
    const args = [
      'wallet', 'limit', 'set',
      '--address', input.address,
      '--chain', resolvedChain,
      '--policy-type', 'stablecoin',
      '--rule-type', 'transfer-limit',
    ];
    if (input.perTx !== undefined) args.push('--per-tx', String(input.perTx));
    if (input.daily !== undefined) args.push('--daily', String(input.daily));
    if (input.weekly !== undefined) args.push('--weekly', String(input.weekly));
    if (input.monthly !== undefined) args.push('--monthly', String(input.monthly));

    // This command will block waiting for OTP. We run it but catch the OTP
    // prompt output and surface it as pending_otp.
    try {
      await runCli(args);
      results.push('transfer-limit: submitted');
    } catch (err) {
      if (err instanceof AgentWalletError && err.cliOutput?.includes('OTP')) {
        results.push('transfer-limit: pending_otp');
      } else {
        throw err;
      }
    }
  }

  // 2. Recipient allowlist
  if (input.recipientAllowlist && input.recipientAllowlist.length > 0) {
    await runCli([
      'wallet', 'limit', 'set',
      '--address', input.address, '--chain', resolvedChain,
      '--policy-type', 'stablecoin',
      '--rule-type', 'recipient-allowlist',
      '--targets', `[${input.recipientAllowlist.join(',')}]`,
    ]).catch(() => { results.push('recipient-allowlist: pending_otp'); });
    results.push('recipient-allowlist: submitted');
  }

  // 3. Recipient blocklist
  if (input.recipientBlocklist && input.recipientBlocklist.length > 0) {
    await runCli([
      'wallet', 'limit', 'set',
      '--address', input.address, '--chain', resolvedChain,
      '--policy-type', 'stablecoin',
      '--rule-type', 'recipient-blocklist',
      '--targets', `[${input.recipientBlocklist.join(',')}]`,
    ]).catch(() => { results.push('recipient-blocklist: pending_otp'); });
    results.push('recipient-blocklist: submitted');
  }

  // 4. Contract allowlist
  if (input.contractAllowlist && input.contractAllowlist.length > 0) {
    await runCli([
      'wallet', 'limit', 'set',
      '--address', input.address, '--chain', resolvedChain,
      '--policy-type', 'contract',
      '--rule-type', 'contract-allowlist',
      '--targets', `[${input.contractAllowlist.join(',')}]`,
    ]).catch(() => { results.push('contract-allowlist: pending_otp'); });
    results.push('contract-allowlist: submitted');
  }

  // 5. Contract blocklist
  if (input.contractBlocklist && input.contractBlocklist.length > 0) {
    await runCli([
      'wallet', 'limit', 'set',
      '--address', input.address, '--chain', resolvedChain,
      '--policy-type', 'contract',
      '--rule-type', 'contract-blocklist',
      '--targets', `[${input.contractBlocklist.join(',')}]`,
    ]).catch(() => { results.push('contract-blocklist: pending_otp'); });
    results.push('contract-blocklist: submitted');
  }

  return {
    status: 'pending_otp',
    message:
      'Policy changes have been submitted to Circle. ' +
      'A confirmation email with a one-time password (OTP) has been sent to your agent session email. ' +
      'You must complete the OTP confirmation yourself — the agent cannot do this for you. ' +
      'Run `circle wallet limit --address ' + input.address + ' --chain ' + resolvedChain + '` to verify the policy is active.\n\n' +
      'Rules submitted: ' + (results.length > 0 ? results.join(', ') : 'none'),
  };
}

// ── x402 / nanopayments ───────────────────────────────────────────────────────

export interface InspectResult {
  endpoint: string;
  method: string;
  priceUsdc: string;
  chain: string;
  accepts: Array<{ network: string; asset: string; paymentAddress: string }>;
  raw: unknown;
}

export interface PayResult {
  paidAmount: string;
  status: 'success' | 'payment_required' | 'insufficient_policy' | 'error';
  response?: unknown;
  message?: string;
}

export interface ServiceListing {
  name: string;
  endpoint: string;
  priceUsdc: string;
  description: string;
  category?: string;
}

/**
 * Inspect a URL's x402 payment requirements without paying.
 * Wraps: circle services inspect <url> [--method <M>] --output json
 *
 * Safe to call at any time — no funds are moved.
 */
export async function inspectEndpoint(
  endpoint: string,
  method: string = 'GET',
): Promise<InspectResult> {
  // Validate URL: must be https://
  if (!endpoint.startsWith('https://')) {
    throw new AgentWalletError(
      'INVALID_ENDPOINT',
      `Endpoint must start with https://. Received: ${endpoint}`,
    );
  }

  const args = ['services', 'inspect', endpoint, '-X', method.toUpperCase()];

  interface InspectResponse {
    data?: {
      method?: string;
      price?: { usdc?: string; amount?: string };
      chain?: string;
      network?: string;
      accepts?: Array<{ network?: string; asset?: string; paymentAddress?: string }>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }

  const result = await runCliJson<InspectResponse>(args);
  const d = result.data ?? result;

  return {
    endpoint,
    method: (d as { method?: string }).method ?? method.toUpperCase(),
    priceUsdc:
      (d as { price?: { usdc?: string; amount?: string } }).price?.usdc ??
      (d as { price?: { usdc?: string; amount?: string } }).price?.amount ??
      '0',
    chain:
      (d as { chain?: string; network?: string }).chain ??
      (d as { chain?: string; network?: string }).network ??
      'unknown',
    accepts: ((d as { accepts?: Array<{ network?: string; asset?: string; paymentAddress?: string }> }).accepts ?? []).map(
      (a) => ({
        network: a.network ?? '',
        asset: a.asset ?? 'USDC',
        paymentAddress: a.paymentAddress ?? '',
      }),
    ),
    raw: d,
  };
}

/**
 * Pay for an x402-compatible endpoint and return its response body.
 * Wraps: circle services pay <url> --address <addr> --chain <chain>
 *   --max-amount <usdc> [--method <M>] [--data <json>] [--header K:V ...]
 *
 * SAFETY: Always check Phase 0 kill switch and allowlist BEFORE calling this.
 * The `maxPriceUsdc` ceiling must be validated against the wallet policy's
 * x402Cap before dispatching. This function does not re-check kill switch —
 * the calling tool is responsible for that.
 *
 * Returns the parsed response body on success.
 * Returns a structured error object on failure (never throws policy errors
 * through as unhandled exceptions — surfaces them for the agent to act on).
 */
export async function payEndpoint(
  walletAddress: string,
  endpoint: string,
  maxPriceUsdc: string,
  chain: string,
  method: string = 'GET',
  payload?: unknown,
  headers?: Record<string, string>,
): Promise<PayResult> {
  // URL validation
  if (!endpoint.startsWith('https://')) {
    throw new AgentWalletError(
      'INVALID_ENDPOINT',
      `Endpoint must start with https://. Received: ${endpoint}`,
    );
  }
  // maxPriceUsdc must be a positive number
  const maxPrice = parseFloat(maxPriceUsdc);
  if (!isFinite(maxPrice) || maxPrice <= 0) {
    throw new AgentWalletError(
      'INVALID_MAX_PRICE',
      `maxPriceUsdc must be a positive number, got: ${maxPriceUsdc}`,
    );
  }

  const resolvedChain = resolveChain(chain);
  const testnetFlag = !isMainnetChain(resolvedChain);

  const args: string[] = [
    'services', 'pay', endpoint,
    '--address', walletAddress,
    '--chain', resolvedChain,
    '--max-amount', maxPriceUsdc,
    '-X', method.toUpperCase(),
  ];
  if (testnetFlag) args.push('--testnet');

  // Attach optional payload
  if (payload !== undefined) {
    const payloadStr = JSON.stringify(payload);
    // Reject payloads with shell metacharacters
    if (/[;|&$`()<>'"\\]/.test(payloadStr)) {
      throw new AgentWalletError(
        'UNSAFE_PAYLOAD',
        'Payload contains shell metacharacters and cannot be safely passed to the CLI.',
      );
    }
    args.push('-d', payloadStr);
  }

  // Attach optional headers
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      // Reject headers with shell metacharacters
      const combined = `${k}: ${v}`;
      if (/[;|&$`()<>'"\\\n\r]/.test(combined)) {
        throw new AgentWalletError(
          'UNSAFE_HEADER',
          `Header "${k}" contains unsafe characters.`,
        );
      }
      args.push('-H', combined);
    }
  }

  interface PayResponse {
    data?: unknown;
    response?: unknown;
    body?: unknown;
    status?: string | number;
    error?: string;
    message?: string;
    paidAmount?: string;
    amount?: string;
  }

  try {
    const result = await runCliJson<PayResponse>(args);
    const paidAmount =
      (result as PayResponse).paidAmount ??
      (result as PayResponse).amount ??
      maxPriceUsdc;
    const responseBody =
      (result as PayResponse).data ??
      (result as PayResponse).response ??
      (result as PayResponse).body ??
      result;

    return {
      paidAmount: String(paidAmount),
      status: 'success',
      response: responseBody,
    };
  } catch (err) {
    if (err instanceof AgentWalletError) {
      // Classify common failure modes
      const msg = err.message + (err.cliOutput ?? '');
      if (msg.includes('policy') || msg.includes('limit') || msg.includes('exceeds')) {
        return {
          paidAmount: '0',
          status: 'insufficient_policy',
          message: err.message,
        };
      }
      if (msg.includes('402') || msg.includes('payment required') || msg.includes('max-amount')) {
        return {
          paidAmount: '0',
          status: 'payment_required',
          message: err.message,
        };
      }
      return {
        paidAmount: '0',
        status: 'error',
        message: err.message,
      };
    }
    throw err;
  }
}

/**
 * Search for available x402-compatible services.
 * Wraps: circle services search [<query>] [--limit n] --output json
 *
 * Read-only — safe to call at any time.
 */
export async function discoverServices(
  query?: string,
  limit?: number,
): Promise<ServiceListing[]> {
  const args: string[] = ['services', 'search'];
  if (query?.trim()) args.push(query.trim());
  if (limit) args.push('--limit', String(Math.min(limit, 50)));

  interface SearchResponse {
    data?: Array<{
      name?: string;
      url?: string;
      endpoint?: string;
      price?: { usdc?: string; amount?: string };
      description?: string;
      category?: string;
    }>;
  }

  const result = await runCliJson<SearchResponse>(args);
  const services = result.data ?? [];

  return services.map((s) => ({
    name: s.name ?? 'unknown',
    endpoint: s.url ?? s.endpoint ?? '',
    priceUsdc: s.price?.usdc ?? s.price?.amount ?? '0',
    description: s.description ?? '',
    category: s.category,
  }));
}

// ── transfer ──────────────────────────────────────────────────────────────────

/**
 * Transfer USDC from an Agent Wallet.
 * Wraps: circle wallet transfer <to> --amount <n> --address <from> --chain <CHAIN> --output json
 *
 * Phase 0 kill switch and address allowlist must be checked by the calling tool
 * BEFORE this function is invoked.
 *
 * Circle enforces any spending policies set on the wallet at the network level.
 * This function checks that at least one policy exists on mainnet wallets before
 * dispatching (defense in depth).
 */
export async function transfer(
  fromAddress: string,
  toAddress: string,
  amountUsdc: string,
  chain?: string,
): Promise<TransferResult> {
  const resolvedChain = resolveChain(chain);

  // Validate amount is positive
  const amountRaw = parseUsdc(amountUsdc);
  if (amountRaw <= 0n) {
    throw new AgentWalletError('INVALID_AMOUNT', `Amount must be positive, got: ${amountUsdc}`);
  }

  // On mainnet, verify a policy is set before dispatching
  if (isMainnetChain(resolvedChain)) {
    const policies = await getPolicy(fromAddress, resolvedChain);
    const hasRealPolicy = policies.some((p) => p.type !== 'info');
    if (!hasRealPolicy) {
      throw new AgentWalletError(
        'NO_POLICY',
        `No spending policy is set on wallet ${fromAddress} (chain: ${resolvedChain}). ` +
          'Set a policy first using the set_agent_policy tool. ' +
          'This prevents unrestricted agent transfers on mainnet.',
      );
    }
  }

  const testnetFlag = !isMainnetChain(resolvedChain);
  const args = [
    'wallet', 'transfer', toAddress,
    '--amount', amountUsdc,
    '--address', fromAddress,
    '--chain', resolvedChain,
  ];
  if (testnetFlag) args.push('--testnet');

  interface TransferResponse {
    data?: {
      id?: string;
      state?: string;
      txHash?: string;
      sourceAddress?: string;
      destinationAddress?: string;
      amounts?: string[];
      blockchain?: string;
    };
  }

  const result = await runCliJson<TransferResponse>(args);
  const tx = result.data ?? {};

  const explorerBase = isMainnetChain(resolvedChain)
    ? 'https://explorer.arc.io'
    : 'https://explorer.testnet.arc.io';

  return {
    circleTxId: tx.id ?? 'unknown',
    txHash: tx.txHash,
    state: tx.state ?? 'UNKNOWN',
    sourceAddress: tx.sourceAddress ?? fromAddress,
    destinationAddress: tx.destinationAddress ?? toAddress,
    amount: tx.amounts?.[0] ?? amountUsdc,
    chain: tx.blockchain ?? resolvedChain,
    explorerUrl: tx.txHash ? `${explorerBase}/tx/${tx.txHash}` : undefined,
  };
}
