/**
 * Minimal ABI for the AgenticCommerce (ERC-8183) contract.
 *
 * Sourced from the verified on-chain implementation at:
 *   Proxy:           0x0747EEf0706327138c69792bF28Cd525089e4583  (Arc Testnet)
 *   Implementation:  0xa316fd02827242d537f84730f8a37d0ba5fd351a  (Arc Testnet)
 *
 * Only the nine functions used by the MCP job tools are included.
 * USDC (paymentToken) is the ERC-20 at 0x3600000000000000000000000000000000000000.
 */

/** Proxy address — always call through this, never the implementation. */
export const AGENTIC_COMMERCE_ADDRESS =
  '0x0747EEf0706327138c69792bF28Cd525089e4583' as const;

/**
 * JobStatus enum mapping (uint8 in contract).
 * Index order matches the on-chain enum definition.
 */
export const JOB_STATUS: Record<number, string> = {
  0: 'Open',
  1: 'Funded',
  2: 'Submitted',
  3: 'Completed',
  4: 'Rejected',
  5: 'Expired',
};

export const ERC8183_ABI = [
  // ── State-changing functions ──────────────────────────────────────────────

  {
    name: 'createJob',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'provider',    type: 'address' },
      { name: 'evaluator',   type: 'address' },
      { name: 'expiredAt',   type: 'uint256' },
      { name: 'description', type: 'string'  },
      { name: 'hook',        type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'setBudget',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId',     type: 'uint256' },
      { name: 'amount',    type: 'uint256' },
      { name: 'optParams', type: 'bytes'   },
    ],
    outputs: [],
  },
  {
    name: 'fund',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId',     type: 'uint256' },
      { name: 'optParams', type: 'bytes'   },
    ],
    outputs: [],
  },
  {
    name: 'submit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId',       type: 'uint256' },
      { name: 'deliverable', type: 'bytes32' },
      { name: 'optParams',   type: 'bytes'   },
    ],
    outputs: [],
  },
  {
    name: 'complete',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId',     type: 'uint256' },
      { name: 'reason',    type: 'bytes32' },
      { name: 'optParams', type: 'bytes'   },
    ],
    outputs: [],
  },
  {
    name: 'reject',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId',     type: 'uint256' },
      { name: 'reason',    type: 'bytes32' },
      { name: 'optParams', type: 'bytes'   },
    ],
    outputs: [],
  },
  {
    name: 'claimRefund',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [],
  },

  // ── View functions ────────────────────────────────────────────────────────

  {
    name: 'getJob',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'id',          type: 'uint256' },
          { name: 'client',      type: 'address' },
          { name: 'provider',    type: 'address' },
          { name: 'evaluator',   type: 'address' },
          { name: 'description', type: 'string'  },
          { name: 'budget',      type: 'uint256' },
          { name: 'expiredAt',   type: 'uint256' },
          { name: 'status',      type: 'uint8'   },
          { name: 'hook',        type: 'address' },
        ],
      },
    ],
  },
  {
    name: 'jobCounter',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'jobHasBudget',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [{ name: 'hasBudget', type: 'bool' }],
  },
] as const;

/** ERC-20 approve ABI fragment — used by job_approve_usdc. */
export const ERC20_APPROVE_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value',   type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;
