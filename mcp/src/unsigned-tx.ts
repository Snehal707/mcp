/**
 * Unsigned transaction builder.
 *
 * Active when AGENT_MODE=unsigned (the default safe mode).
 * Assembles a ready-to-sign transaction object and returns it as JSON.
 * The human operator signs and broadcasts it with MetaMask, Frame, or cast.
 *
 * No private keys. No signing. No custody. Pure construction.
 */
import { encodeFunctionData, erc20Abi, parseAbi, type Abi } from 'viem';
import {
  publicClient,
  activeChain,
  USDC_ADDRESS,
  parseUsdc,
} from './arc-chain.js';

export interface UnsignedTransaction {
  to: string;
  data: string;
  value: string;       // "0x0" for non-payable; hex-encoded native USDC for payable
  chainId: number;
  chainName: string;
  explorerUrl: string; // link to the chain explorer for operator reference
  // Human-readable summary for the operator
  summary: string;
  signingInstructions: string;
}

// ── USDC transfer ─────────────────────────────────────────────────────────────

/**
 * Build an unsigned ERC-20 USDC transfer transaction.
 *
 * @param to          Recipient 0x address
 * @param amountHuman Human-readable USDC amount (e.g. "5.50")
 */
export function buildUsdcTransfer(
  to: string,
  amountHuman: string,
): UnsignedTransaction {
  const amountRaw = parseUsdc(amountHuman);

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to as `0x${string}`, amountRaw],
  });

  return {
    to: USDC_ADDRESS,
    data,
    value: '0x0',
    chainId: activeChain.id,
    chainName: activeChain.name,
    explorerUrl: activeChain.blockExplorers.default.url,
    summary: `Transfer ${amountHuman} USDC to ${to} on ${activeChain.name}`,
    signingInstructions:
      'Sign and broadcast this transaction with MetaMask, Frame, or ' +
      '`cast send --rpc-url https://rpc.testnet.arc.io --private-key <KEY> ' +
      `${USDC_ADDRESS} "${data}". ` +
      'Gas on Arc is paid in USDC — make sure the signing wallet has USDC for fees.',
  };
}

// ── Arbitrary contract call ───────────────────────────────────────────────────

/**
 * Build an unsigned contract-write transaction.
 *
 * @param contractAddress  Target contract 0x address
 * @param abiJson          ABI as a JSON string (array of function/event objects)
 * @param functionName     Name of the function to call
 * @param args             Array of argument values (must match ABI parameter types)
 * @param valueUsdc        Optional USDC value to attach (human-readable, e.g. "1.0")
 */
export function buildContractWrite(
  contractAddress: string,
  abiJson: string,
  functionName: string,
  args: unknown[],
  valueUsdc?: string,
): UnsignedTransaction {
  let abi: Abi;
  try {
    const parsed = JSON.parse(abiJson) as unknown;
    if (Array.isArray(parsed)) {
      abi = parsed as Abi;
    } else if (typeof parsed === 'string') {
      // Human-readable ABI format passed as a JSON string of strings
      abi = parseAbi([parsed]);
    } else {
      throw new Error('ABI must be a JSON array');
    }
  } catch (err) {
    throw new Error(
      `Invalid ABI JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const data = encodeFunctionData({
    abi,
    functionName,
    args: args as readonly unknown[],
  });

  // Convert USDC value to native 18-decimal representation for msg.value
  // (On Arc, native and ERC-20 USDC are the same pool at different decimal scales.)
  const valueRaw =
    valueUsdc && parseFloat(valueUsdc) > 0
      ? BigInt(parseUsdc(valueUsdc)) * BigInt(10 ** 12) // 6-dec -> 18-dec
      : 0n;

  return {
    to: contractAddress,
    data,
    value: `0x${valueRaw.toString(16)}`,
    chainId: activeChain.id,
    chainName: activeChain.name,
    explorerUrl: activeChain.blockExplorers.default.url,
    summary: `Call ${functionName}(${args.map(String).join(', ')}) on ${contractAddress} on ${activeChain.name}`,
    signingInstructions:
      'Sign and broadcast this transaction with MetaMask, Frame, or ' +
      `\`cast send --rpc-url ${activeChain.rpcUrls.default.http[0]} --private-key <KEY> ` +
      `${contractAddress} "${data}"\`. ` +
      'Gas on Arc is paid in USDC — make sure the signing wallet has USDC for fees.',
  };
}

// ── Estimated gas cost ────────────────────────────────────────────────────────

/**
 * Estimate the gas cost of a transaction in USDC (6-decimal ERC-20 view).
 * Returns a human-readable string, e.g. "0.000021".
 */
export async function estimateGas(
  to: string,
  data: string,
  value: bigint = 0n,
): Promise<string> {
  try {
    const gas = await publicClient.estimateGas({
      to: to as `0x${string}`,
      data: data as `0x${string}`,
      value,
    });
    // On Arc, 1 native unit = 1e-18 USDC native = 1e-6 USDC ERC-20
    // gas × gasPrice (in native units) / 1e12 → ERC-20 6-decimal units
    const gasPrice = await publicClient.getGasPrice();
    const nativeCost = gas * gasPrice;
    const erc20Cost = nativeCost / BigInt(10 ** 12);
    const whole = erc20Cost / BigInt(10 ** 6);
    const frac = erc20Cost % BigInt(10 ** 6);
    const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
    return fracStr ? `${whole}.${fracStr}` : `${whole}`;
  } catch {
    return 'unknown';
  }
}
