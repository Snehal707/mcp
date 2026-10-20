/**
 * Phase 0 — spending-limits.ts test suite
 *
 * Tests every guard introduced in Phase 0:
 *   1. Empty ALLOWED_ADDRESSES + REQUIRE_ALLOWLIST=true  → reject
 *   2. Address not in allowlist                          → reject
 *   3. Address in allowlist                              → pass
 *   4. Contract not in ALLOWED_CONTRACTS                 → reject
 *   5. Contract in ALLOWED_CONTRACTS                     → pass
 *   6. Selector not in ALLOWED_SELECTORS                 → reject
 *   7. Selector in ALLOWED_SELECTORS                     → pass
 *   8. Kill switch active                                → isKillSwitchActive() = true
 *   9. Kill switch inactive                              → isKillSwitchActive() = false
 *  10. Binding hash is present and deterministic for same input/nonce
 *  11. Binding hash changes when any field changes
 *  12. Daily limit still enforced after binding change
 *  13. Per-call limit enforced
 *  14. REQUIRE_ALLOWLIST=false + empty list              → pass (any address allowed)
 *  15. No ALLOWED_SELECTORS set                          → all selectors allowed
 *
 * Run: cd mcp && bun test src/spending-limits.test.ts
 */
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  SpendingLimitError,
  isKillSwitchActive,
  checkAddressAllowlist,
  checkContractAllowlist,
  checkLimits,
  createOperationBinding,
  computeDailySpend,
  parseAllowlist,
  type OperationBinding,
  type LogRecord,
} from './spending-limits.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ADDR_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CONTRACT_1 = '0x1111111111111111111111111111111111111111';
const CONTRACT_2 = '0x2222222222222222222222222222222222222222';
const SEL_TRANSFER = '0xa9059cbb';
const SEL_APPROVE = '0x095ea7b3';

/** Save and restore env vars around a test. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

/** Create a temporary log file and point TOOL_LOG_PATH at it. */
function withTempLog(fn: (logPath: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'arc-mcp-test-'));
  const logPath = path.join(dir, 'tool-calls.jsonl');
  const saved = process.env.TOOL_LOG_PATH;
  process.env.TOOL_LOG_PATH = logPath;
  try {
    fn(logPath);
  } finally {
    process.env.TOOL_LOG_PATH = saved;
    try { unlinkSync(logPath); } catch { /* ignore */ }
    try { rmdirSync(dir); } catch { /* ignore */ }
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parseAllowlist', () => {
  it('returns empty array for undefined', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseAllowlist('')).toEqual([]);
  });

  it('normalises addresses to lowercase', () => {
    const result = parseAllowlist('0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaAa');
    expect(result).toEqual([ADDR_A]);
  });

  it('filters out invalid addresses', () => {
    const result = parseAllowlist('not-an-address,0xGGGG,0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(result).toEqual([ADDR_A]);
  });

  it('handles multiple valid addresses', () => {
    const result = parseAllowlist(`${ADDR_A},${ADDR_B}`);
    expect(result).toHaveLength(2);
    expect(result).toContain(ADDR_A);
    expect(result).toContain(ADDR_B);
  });
});

describe('isKillSwitchActive', () => {
  it('returns false when KILL_SWITCH is not set', () => {
    withEnv({ KILL_SWITCH: undefined }, () => {
      expect(isKillSwitchActive()).toBe(false);
    });
  });

  it('returns false when KILL_SWITCH=false', () => {
    withEnv({ KILL_SWITCH: 'false' }, () => {
      expect(isKillSwitchActive()).toBe(false);
    });
  });

  it('returns true when KILL_SWITCH=true', () => {
    withEnv({ KILL_SWITCH: 'true' }, () => {
      expect(isKillSwitchActive()).toBe(true);
    });
  });
});

describe('checkAddressAllowlist', () => {
  it('throws ALLOWLIST_REQUIRED_EMPTY when list is empty and REQUIRE_ALLOWLIST=true', () => {
    withEnv({ ALLOWED_ADDRESSES: '', REQUIRE_ALLOWLIST: 'true' }, () => {
      expect(() => checkAddressAllowlist(ADDR_A))
        .toThrow(SpendingLimitError);
      try {
        checkAddressAllowlist(ADDR_A);
      } catch (err) {
        expect(err).toBeInstanceOf(SpendingLimitError);
        expect((err as SpendingLimitError).code).toBe('ALLOWLIST_REQUIRED_EMPTY');
      }
    });
  });

  it('throws ALLOWLIST_REQUIRED_EMPTY when ALLOWED_ADDRESSES is absent and REQUIRE_ALLOWLIST defaults to true', () => {
    withEnv({ ALLOWED_ADDRESSES: undefined, REQUIRE_ALLOWLIST: undefined }, () => {
      expect(() => checkAddressAllowlist(ADDR_A)).toThrow(SpendingLimitError);
    });
  });

  it('passes when REQUIRE_ALLOWLIST=false and list is empty (any address allowed)', () => {
    withEnv({ ALLOWED_ADDRESSES: '', REQUIRE_ALLOWLIST: 'false' }, () => {
      expect(() => checkAddressAllowlist(ADDR_A)).not.toThrow();
    });
  });

  it('throws ADDRESS_NOT_ALLOWED when address is not in a populated list', () => {
    withEnv({ ALLOWED_ADDRESSES: ADDR_A, REQUIRE_ALLOWLIST: 'true' }, () => {
      try {
        checkAddressAllowlist(ADDR_B);
        expect(true).toBe(false); // should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(SpendingLimitError);
        expect((err as SpendingLimitError).code).toBe('ADDRESS_NOT_ALLOWED');
      }
    });
  });

  it('passes when address is in the allowlist', () => {
    withEnv({ ALLOWED_ADDRESSES: `${ADDR_A},${ADDR_B}`, REQUIRE_ALLOWLIST: 'true' }, () => {
      expect(() => checkAddressAllowlist(ADDR_A)).not.toThrow();
      expect(() => checkAddressAllowlist(ADDR_B)).not.toThrow();
    });
  });

  it('is case-insensitive', () => {
    withEnv({ ALLOWED_ADDRESSES: ADDR_A.toUpperCase(), REQUIRE_ALLOWLIST: 'true' }, () => {
      expect(() => checkAddressAllowlist(ADDR_A.toLowerCase())).not.toThrow();
    });
  });
});

describe('checkContractAllowlist', () => {
  it('throws CONTRACT_NOT_ALLOWED when ALLOWED_CONTRACTS is empty', () => {
    withEnv({ ALLOWED_CONTRACTS: '' }, () => {
      try {
        checkContractAllowlist(CONTRACT_1);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(SpendingLimitError);
        expect((err as SpendingLimitError).code).toBe('CONTRACT_NOT_ALLOWED');
      }
    });
  });

  it('throws CONTRACT_NOT_ALLOWED when contract is not in list', () => {
    withEnv({ ALLOWED_CONTRACTS: CONTRACT_1 }, () => {
      try {
        checkContractAllowlist(CONTRACT_2);
        expect(true).toBe(false);
      } catch (err) {
        expect((err as SpendingLimitError).code).toBe('CONTRACT_NOT_ALLOWED');
      }
    });
  });

  it('passes when contract is in the list', () => {
    withEnv({ ALLOWED_CONTRACTS: `${CONTRACT_1},${CONTRACT_2}` }, () => {
      expect(() => checkContractAllowlist(CONTRACT_1)).not.toThrow();
      expect(() => checkContractAllowlist(CONTRACT_2)).not.toThrow();
    });
  });

  it('throws SELECTOR_NOT_ALLOWED when selector is set and not in list', () => {
    withEnv({
      ALLOWED_CONTRACTS: CONTRACT_1,
      ALLOWED_SELECTORS: SEL_TRANSFER,
    }, () => {
      try {
        checkContractAllowlist(CONTRACT_1, SEL_APPROVE);
        expect(true).toBe(false);
      } catch (err) {
        expect((err as SpendingLimitError).code).toBe('SELECTOR_NOT_ALLOWED');
      }
    });
  });

  it('passes when selector is in the allowed list', () => {
    withEnv({
      ALLOWED_CONTRACTS: CONTRACT_1,
      ALLOWED_SELECTORS: `${SEL_TRANSFER},${SEL_APPROVE}`,
    }, () => {
      expect(() => checkContractAllowlist(CONTRACT_1, SEL_TRANSFER)).not.toThrow();
      expect(() => checkContractAllowlist(CONTRACT_1, SEL_APPROVE)).not.toThrow();
    });
  });

  it('passes with no selector check when ALLOWED_SELECTORS is not set', () => {
    withEnv({
      ALLOWED_CONTRACTS: CONTRACT_1,
      ALLOWED_SELECTORS: undefined,
    }, () => {
      expect(() => checkContractAllowlist(CONTRACT_1, SEL_APPROVE)).not.toThrow();
    });
  });
});

describe('createOperationBinding', () => {
  it('produces a binding with the expected shape', () => {
    const b = createOperationBinding(ADDR_A, 5_000_000n, '0x');
    expect(b.to).toBe(ADDR_A.toLowerCase());
    expect(b.amountRaw).toBe('5000000');
    expect(b.data).toBe('0x');
    expect(b.nonce).toMatch(/^[0-9a-f-]{36}$/i); // UUID v4 format
    expect(typeof b.timestamp).toBe('number');
    expect(b.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('produces a different hash for different amounts', () => {
    const b1 = createOperationBinding(ADDR_A, 1_000_000n, '0x');
    const b2 = createOperationBinding(ADDR_A, 2_000_000n, '0x');
    expect(b1.hash).not.toBe(b2.hash);
  });

  it('produces a different hash for different recipients', () => {
    const b1 = createOperationBinding(ADDR_A, 1_000_000n, '0x');
    const b2 = createOperationBinding(ADDR_B, 1_000_000n, '0x');
    expect(b1.hash).not.toBe(b2.hash);
  });

  it('produces a different hash for different calldata', () => {
    const b1 = createOperationBinding(ADDR_A, 0n, '0xa9059cbb');
    const b2 = createOperationBinding(ADDR_A, 0n, '0x095ea7b3');
    expect(b1.hash).not.toBe(b2.hash);
  });

  it('produces a unique nonce on each call (prevents replay)', () => {
    const b1 = createOperationBinding(ADDR_A, 0n, '0x');
    const b2 = createOperationBinding(ADDR_A, 0n, '0x');
    // Same inputs but different nonces → different hashes
    expect(b1.nonce).not.toBe(b2.nonce);
    expect(b1.hash).not.toBe(b2.hash);
  });
});

describe('checkLimits — per-call cap', () => {
  it('throws PER_CALL_EXCEEDED when amount exceeds PER_CALL_LIMIT_USDC', () => {
    withEnv({ PER_CALL_LIMIT_USDC: '5', DAILY_LIMIT_USDC: '1000' }, () => {
      withTempLog(() => {
        try {
          checkLimits(10_000_000n); // 10 USDC > 5 USDC cap
          expect(true).toBe(false);
        } catch (err) {
          expect((err as SpendingLimitError).code).toBe('PER_CALL_EXCEEDED');
        }
      });
    });
  });

  it('passes when amount equals the per-call limit', () => {
    withEnv({ PER_CALL_LIMIT_USDC: '10', DAILY_LIMIT_USDC: '1000' }, () => {
      withTempLog(() => {
        expect(() => checkLimits(10_000_000n)).not.toThrow(); // exactly 10 USDC
      });
    });
  });
});

describe('checkLimits — daily rolling limit', () => {
  it('throws DAILY_LIMIT_EXCEEDED when cumulative spend would exceed DAILY_LIMIT_USDC', () => {
    withEnv({ PER_CALL_LIMIT_USDC: '1000', DAILY_LIMIT_USDC: '10', ENFORCE_OPERATION_BINDING: 'true' }, () => {
      withTempLog((logPath) => {
        // Pre-populate the log with a 9 USDC completed entry (with binding)
        const fakeBinding: OperationBinding = {
          to: ADDR_A,
          amountRaw: '9000000',
          data: '0x',
          nonce: 'fake-nonce-1',
          timestamp: Date.now(),
          hash: '0x' + 'a'.repeat(64),
        };
        const rec: LogRecord = {
          timestamp: new Date().toISOString(),
          tool: 'transfer_usdc',
          amountUsdc: '9',
          status: 'completed',
          binding: fakeBinding,
        };
        writeFileSync(logPath, JSON.stringify(rec) + '\n', 'utf-8');

        // Now try to send 2 USDC — should be blocked (9 + 2 = 11 > 10)
        try {
          checkLimits(2_000_000n);
          expect(true).toBe(false);
        } catch (err) {
          expect((err as SpendingLimitError).code).toBe('DAILY_LIMIT_EXCEEDED');
        }
      });
    });
  });

  it('counts legacy entries without binding conservatively', () => {
    withEnv({ PER_CALL_LIMIT_USDC: '1000', DAILY_LIMIT_USDC: '10', ENFORCE_OPERATION_BINDING: 'true' }, () => {
      withTempLog((logPath) => {
        // Legacy entry — no binding.hash
        const legacyRec: LogRecord = {
          timestamp: new Date().toISOString(),
          tool: 'transfer_usdc',
          amountUsdc: '9',
          status: 'completed',
        };
        writeFileSync(logPath, JSON.stringify(legacyRec) + '\n', 'utf-8');

        // Should still count and block a 2 USDC transfer
        try {
          checkLimits(2_000_000n);
          expect(true).toBe(false);
        } catch (err) {
          expect((err as SpendingLimitError).code).toBe('DAILY_LIMIT_EXCEEDED');
        }
      });
    });
  });

  it('ignores entries older than 24 hours', () => {
    withEnv({ PER_CALL_LIMIT_USDC: '1000', DAILY_LIMIT_USDC: '10' }, () => {
      withTempLog((logPath) => {
        const oldTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        const oldRec: LogRecord = {
          timestamp: oldTs,
          tool: 'transfer_usdc',
          amountUsdc: '9',
          status: 'completed',
        };
        writeFileSync(logPath, JSON.stringify(oldRec) + '\n', 'utf-8');

        // Old entry should not count — 2 USDC transfer should pass
        expect(() => checkLimits(2_000_000n)).not.toThrow();
      });
    });
  });

  it('ignores non-completed entries', () => {
    withEnv({ PER_CALL_LIMIT_USDC: '1000', DAILY_LIMIT_USDC: '10' }, () => {
      withTempLog((logPath) => {
        const rec: LogRecord = {
          timestamp: new Date().toISOString(),
          tool: 'transfer_usdc',
          amountUsdc: '9',
          status: 'blocked', // not 'completed'
        };
        writeFileSync(logPath, JSON.stringify(rec) + '\n', 'utf-8');

        // Blocked entry should not count toward the daily total
        expect(() => checkLimits(2_000_000n)).not.toThrow();
      });
    });
  });
});

describe('computeDailySpend', () => {
  it('returns 0n when log file does not exist', () => {
    withEnv({ TOOL_LOG_PATH: '/tmp/nonexistent-arc-mcp-log-xyz.jsonl' }, () => {
      expect(computeDailySpend()).toBe(0n);
    });
  });

  it('sums only completed entries within the last 24 hours', () => {
    withTempLog((logPath) => {
      const records: LogRecord[] = [
        { timestamp: new Date().toISOString(), tool: 't', amountUsdc: '3', status: 'completed' },
        { timestamp: new Date().toISOString(), tool: 't', amountUsdc: '2', status: 'completed' },
        { timestamp: new Date().toISOString(), tool: 't', amountUsdc: '1', status: 'blocked' },
        { timestamp: new Date(Date.now() - 30 * 3600 * 1000).toISOString(), tool: 't', amountUsdc: '100', status: 'completed' },
      ];
      writeFileSync(logPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      withEnv({ TOOL_LOG_PATH: logPath, ENFORCE_OPERATION_BINDING: 'false' }, () => {
        const spent = computeDailySpend();
        expect(spent).toBe(5_000_000n); // 3 + 2 USDC (6 decimals)
      });
    });
  });
});
