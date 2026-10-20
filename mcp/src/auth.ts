/**
 * Arc MCP Server — Phase 5: HTTP authentication and rate limiting.
 *
 * Authentication:
 *   - When API_AUTH_TOKEN is set, every HTTP request (except /health) must
 *     carry the header:  Authorization: Bearer <API_AUTH_TOKEN>
 *   - Stdio transport is not affected — it is already process-isolated.
 *   - In production, set a strong random token (e.g. `openssl rand -hex 32`).
 *
 * Rate limiting:
 *   - Per-IP sliding-window limiter: RATE_LIMIT_MAX requests per
 *     RATE_LIMIT_WINDOW_MS milliseconds (defaults: 60 req / 60 s).
 *   - Separate, tighter limit on write-path routes (/sse, /message):
 *     RATE_LIMIT_WRITE_MAX per RATE_LIMIT_WINDOW_MS (default: 20 req / 60 s).
 *   - Returns 429 with Retry-After header on violation.
 *
 * Admin separation:
 *   - Routes under /admin/* require a separate ADMIN_AUTH_TOKEN.
 *   - Falls back to API_AUTH_TOKEN when ADMIN_AUTH_TOKEN is not set.
 *
 * Usage (in server.ts):
 *   import { authMiddleware, rateLimiter, adminAuthMiddleware } from './auth.js';
 *   app.use(rateLimiter('global'));
 *   app.use(authMiddleware);
 *   app.use('/admin', adminAuthMiddleware);
 */

import type { Request, Response, NextFunction } from 'express';

// ── Config (read fresh from env on each call so tests can override) ────────────

function cfg() {
  return {
    apiToken: process.env['API_AUTH_TOKEN']?.trim() ?? '',
    adminToken: process.env['ADMIN_AUTH_TOKEN']?.trim() || process.env['API_AUTH_TOKEN']?.trim() || '',
    windowMs: parseInt(process.env['RATE_LIMIT_WINDOW_MS'] ?? '60000', 10),
    globalMax: parseInt(process.env['RATE_LIMIT_MAX'] ?? '60', 10),
    writeMax: parseInt(process.env['RATE_LIMIT_WRITE_MAX'] ?? '20', 10),
  };
}

// ── In-memory rate-limit store ─────────────────────────────────────────────────

interface Window { count: number; resetAt: number }
const stores = new Map<string, Map<string, Window>>();

function getStore(bucket: string): Map<string, Window> {
  let store = stores.get(bucket);
  if (!store) { store = new Map(); stores.set(bucket, store); }
  return store;
}

function checkRate(bucket: string, key: string, max: number, windowMs: number): boolean {
  const store = getStore(bucket);
  const now = Date.now();
  let win = store.get(key);
  if (!win || now >= win.resetAt) {
    win = { count: 1, resetAt: now + windowMs };
    store.set(key, win);
    return true;          // allowed
  }
  win.count += 1;
  return win.count <= max; // allowed when within limit
}

function retryAfterSecs(bucket: string, key: string): number {
  const win = getStore(bucket).get(key);
  if (!win) return 0;
  return Math.ceil((win.resetAt - Date.now()) / 1000);
}

/** Clean up expired windows periodically — prevents unbounded memory growth. */
setInterval(() => {
  const now = Date.now();
  for (const [, store] of stores) {
    for (const [k, win] of store) {
      if (now >= win.resetAt) store.delete(k);
    }
  }
}, 5 * 60 * 1000);

// ── Helpers ────────────────────────────────────────────────────────────────────

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0]?.trim() ?? req.ip ?? 'unknown';
  return req.ip ?? 'unknown';
}

function extractBearer(req: Request): string {
  const h = req.headers['authorization'] ?? '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return '';
}

// ── Middleware factories ───────────────────────────────────────────────────────

/**
 * rateLimiter — express middleware.
 * bucket: 'global' for all requests, 'write' for agent-facing routes.
 */
export function rateLimiter(bucket: 'global' | 'write') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { windowMs, globalMax, writeMax } = cfg();
    const max = bucket === 'write' ? writeMax : globalMax;
    const ip = clientIp(req);
    const allowed = checkRate(bucket, ip, max, windowMs);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - (getStore(bucket).get(ip)?.count ?? 0)));

    if (!allowed) {
      const retryAfter = retryAfterSecs(bucket, ip);
      res.setHeader('Retry-After', retryAfter);
      res.status(429).json({
        error: 'Too many requests',
        retryAfterSeconds: retryAfter,
      });
      return;
    }
    next();
  };
}

/**
 * authMiddleware — requires Authorization: Bearer <API_AUTH_TOKEN> when set.
 * Passes through without check when API_AUTH_TOKEN is empty (dev mode).
 * Skips /health (always public).
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const { apiToken } = cfg();

  // Always allow health check
  if (req.path === '/health') { next(); return; }

  // No token configured → dev mode, allow all
  if (!apiToken) { next(); return; }

  const presented = extractBearer(req);
  if (!presented) {
    res.status(401).json({ error: 'Authorization header required (Bearer token)' });
    return;
  }
  if (!timingSafeEqual(presented, apiToken)) {
    res.status(403).json({ error: 'Invalid token' });
    return;
  }
  next();
}

/**
 * adminAuthMiddleware — stricter check for /admin routes.
 * Falls back to API_AUTH_TOKEN when ADMIN_AUTH_TOKEN is not set.
 */
export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const { adminToken } = cfg();

  if (!adminToken) { next(); return; }

  const presented = extractBearer(req);
  if (!presented) {
    res.status(401).json({ error: 'Admin Authorization header required' });
    return;
  }
  if (!timingSafeEqual(presented, adminToken)) {
    res.status(403).json({ error: 'Invalid admin token' });
    return;
  }
  next();
}

/**
 * timingSafeEqual — constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  }
  return diff === 0;
}

/** Export for testing */
export { cfg as _authCfg, checkRate as _checkRate, getStore as _getStore };
