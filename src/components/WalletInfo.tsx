/**
 * WalletInfo — shows the connected wallet address, live USDC balance on Arc,
 * and links to the Arc Testnet Explorer.
 */
import { useReadContract } from 'wagmi';
import { useAccount } from 'wagmi';
import { erc20Abi } from 'viem';
import { ExternalLink, Wallet, Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { getUsdc, requireChain } from '@/onchain-facts';
import { Amount, usdcDecimalsFor } from '@/onchain-money';
import { TokenUSDC } from '@web3icons/react';

const ARC_TESTNET_ID = 5042002;
const usdcFact = getUsdc(ARC_TESTNET_ID);
const chain = requireChain(ARC_TESTNET_ID);

interface Props {
  agentWalletAddress?: string;
}

function AddressChip({ address, label }: { address: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-2">
      <span
        style={{ color: 'var(--subtle)' }}
        className="text-xs font-medium uppercase tracking-widest"
      >
        {label}
      </span>
      <div
        className="flex items-center gap-2 rounded-lg px-3 py-1.5 mono text-sm"
        style={{
          background: 'var(--surface-muted)',
          color: 'var(--ink-2)',
          border: '1px solid var(--border)',
        }}
      >
        <span className="truncate max-w-[220px]">{address}</span>
        <button
          onClick={copy}
          className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          aria-label="Copy address"
        >
          {copied ? (
            <Check size={13} style={{ color: 'var(--success)' }} />
          ) : (
            <Copy size={13} />
          )}
        </button>
        <a
          href={`${chain.explorerBase}/address/${address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          aria-label="View on explorer"
        >
          <ExternalLink size={13} />
        </a>
      </div>
    </div>
  );
}

export default function WalletInfo({ agentWalletAddress }: Props) {
  const { address: connectedAddress } = useAccount();

  // Read USDC balance for the agent wallet (or connected wallet if no agent wallet configured)
  const displayAddress = (agentWalletAddress ?? connectedAddress) as
    | `0x${string}`
    | undefined;

  const { data: rawBalance, isLoading } = useReadContract({
    address: usdcFact?.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: displayAddress ? [displayAddress] : undefined,
    chainId: ARC_TESTNET_ID,
    query: { enabled: !!displayAddress && !!usdcFact },
  });

  const formattedBalance =
    rawBalance !== undefined
      ? Amount.fromRaw(rawBalance, usdcDecimalsFor(ARC_TESTNET_ID)).toFixed(4)
      : '—';

  return (
    <div
      className="rounded-2xl p-6"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <div className="flex items-center gap-2 mb-5">
        <Wallet size={16} style={{ color: 'var(--accent)' }} />
        <span
          className="text-xs font-semibold uppercase tracking-widest"
          style={{ color: 'var(--accent)' }}
        >
          Agent Wallet
        </span>
      </div>

      {/* Balance hero */}
      <div className="flex items-end gap-3 mb-6">
        <TokenUSDC variant="branded" size={36} />
        <div>
          <div
            className="display text-4xl font-bold tabular-nums"
            style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}
          >
            {isLoading ? (
              <span
                className="inline-block h-10 w-40 rounded-lg animate-pulse"
                style={{ background: 'var(--surface-strong)' }}
              />
            ) : (
              formattedBalance
            )}
          </div>
          <div className="text-sm mt-0.5" style={{ color: 'var(--subtle)' }}>
            USDC · Arc Testnet · ERC-20 6-decimal view
          </div>
        </div>
      </div>

      {/* Addresses */}
      <div className="flex flex-col gap-2.5">
        {agentWalletAddress ? (
          <AddressChip address={agentWalletAddress} label="Agent wallet" />
        ) : connectedAddress ? (
          <AddressChip address={connectedAddress} label="Connected wallet" />
        ) : (
          <p className="text-sm" style={{ color: 'var(--subtle)' }}>
            No agent wallet configured. Set{' '}
            <code
              className="mono text-xs px-1.5 py-0.5 rounded"
              style={{ background: 'var(--surface-muted)' }}
            >
              CIRCLE_WALLET_ID
            </code>{' '}
            in{' '}
            <code
              className="mono text-xs px-1.5 py-0.5 rounded"
              style={{ background: 'var(--surface-muted)' }}
            >
              mcp/env.txt
            </code>{' '}
            to show the agent balance.
          </p>
        )}
      </div>

      {/* Network badge */}
      <div
        className="mt-5 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
        style={{
          background: 'rgba(172, 198, 233, 0.12)',
          color: 'var(--accent)',
          border: '1px solid rgba(172, 198, 233, 0.25)',
        }}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)]" />
        Arc Testnet · Chain ID 5042002 · USDC as gas
      </div>
    </div>
  );
}
