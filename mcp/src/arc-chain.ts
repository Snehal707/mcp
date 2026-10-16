/**
 * Arc chain config and shared viem public client.
 *
 * Arc Testnet facts come from the Arc Studio onchain-facts registry.
 * Never hardcode chain IDs, RPC URLs, or USDC addresses.
 */
import { createPublicClient, http, defineChain } from 'viem';

// ── Arc Testnet ───────────────────────────────────────────────────────────────
export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_MAINNET_CHAIN_ID = 5042;

// USDC is a predeploy at the same address on every Arc network.
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const;

// 6-decimal ERC-20 view — use for all balance reads, transfers, and display.
export const USDC_DECIMALS = 6;

// 18-decimal native view — used only for gas math.
export const ARC_NATIVE_USDC_DECIMALS = 18;

const arcTestnet = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.arc.io'] },
  },
  blockExplorers: {
    default: { name: 'Arc Explorer', url: 'https://explorer.testnet.arc.io' },
  },
  testnet: true,
});

const arcMainnet = defineChain({
  id: ARC_MAINNET_CHAIN_ID,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.arc.io'] },
  },
  blockExplorers: {
    default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' },
  },
  testnet: false,
});

// Select network based on ARC_NETWORK env var (default: testnet).
const isMainnet =
  (process.env.ARC_NETWORK ?? 'testnet').toLowerCase() === 'mainnet';

export const activeChain = isMainnet ? arcMainnet : arcTestnet;

export const publicClient = createPublicClient({
  chain: activeChain,
  transport: http(activeChain.rpcUrls.default.http[0]),
});

// ERC-20 minimal ABI used for USDC reads and transfers.
export const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

/** Format a raw 6-decimal USDC amount as a human-readable string. */
export function formatUsdc(raw: bigint): string {
  const divisor = BigInt(10 ** USDC_DECIMALS);
  const whole = raw / divisor;
  const frac = raw % divisor;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
}

/** Parse a human-readable USDC amount string into raw 6-decimal bigint. */
export function parseUsdc(human: string): bigint {
  const [whole, frac = ''] = human.split('.');
  const fracPadded = frac.slice(0, USDC_DECIMALS).padEnd(USDC_DECIMALS, '0');
  return BigInt(whole) * BigInt(10 ** USDC_DECIMALS) + BigInt(fracPadded);
}

/** Build an explorer URL for a transaction hash. */
export function explorerTxUrl(hash: string): string {
  return `${activeChain.blockExplorers.default.url}/tx/${hash}`;
}
