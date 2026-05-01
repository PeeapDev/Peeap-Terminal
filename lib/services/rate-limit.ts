import type { SupabaseClient } from '@supabase/supabase-js';
import type { VercelRequest } from '@vercel/node';

/**
 * Postgres-backed fixed-window rate limiter.
 *
 * Backed by `rate_limit_buckets` and the `rl_increment` RPC (see migration 141).
 * Atomic UPSERT under the hood, so concurrent requests are safe.
 *
 * Usage:
 *   const rl = createRateLimit(supabase);
 *   const result = await rl.check({ key: `login:ip:${ip}`, limit: 5, windowSeconds: 900 });
 *   if (!result.allowed) {
 *     return res.status(429).set('Retry-After', String(result.retryAfterSeconds)).json({ error: 'rate_limited' });
 *   }
 *
 * Design notes:
 * - Fixed window (not sliding). Has a 2x-burst edge case at window boundaries
 *   (attacker exhausts limit at end of window N, immediately exhausts again at
 *   start of window N+1). Acceptable for credential-stuffing / PIN-brute-force
 *   protection where order-of-magnitude limits are what matters.
 * - Bucket key cardinality should be bounded; per-IP and per-user are fine.
 *   Avoid keys derived from request body fields that the attacker controls
 *   (those just let them blow up storage).
 * - Cleanup runs via the daily reconcile cron — see runReconciliation hook.
 */

export interface RateLimitParams {
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  windowSeconds: number;
  retryAfterSeconds: number;
}

export class RateLimit {
  constructor(private readonly supabase: SupabaseClient) {}

  async check(params: RateLimitParams): Promise<RateLimitResult> {
    const { key, limit, windowSeconds } = params;

    // Fail-open on DB error — better to allow a request than to lock everyone
    // out of the platform if the rate-limit table is unreachable. The fraud
    // module is the second line of defence.
    let count = 1;
    try {
      const { data, error } = await this.supabase.rpc('rl_increment', {
        p_key: key,
        p_window_seconds: windowSeconds,
      });
      if (error) {
        console.warn('[RateLimit] rl_increment failed (failing open):', error.message);
        return { allowed: true, count: 0, limit, remaining: limit, windowSeconds, retryAfterSeconds: 0 };
      }
      count = (data as number) ?? 1;
    } catch (err: any) {
      console.warn('[RateLimit] exception (failing open):', err?.message);
      return { allowed: true, count: 0, limit, remaining: limit, windowSeconds, retryAfterSeconds: 0 };
    }

    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);
    // Coarse retry hint: time until the next window starts. Caller can refine.
    const nowSec = Math.floor(Date.now() / 1000);
    const windowEnd = (Math.floor(nowSec / windowSeconds) + 1) * windowSeconds;
    const retryAfterSeconds = allowed ? 0 : Math.max(1, windowEnd - nowSec);

    return { allowed, count, limit, remaining, windowSeconds, retryAfterSeconds };
  }

  /**
   * Multi-bucket check: return the first bucket that's exhausted.
   * Use this when you want layered limits (per-IP AND per-user) on the same call.
   * IMPORTANT: every bucket increments even if an earlier one rejects. This is
   * intentional — an attacker shouldn't be able to evade the per-user limit by
   * making the per-IP limit reject first.
   */
  async checkAll(buckets: RateLimitParams[]): Promise<RateLimitResult & { rejectedKey?: string }> {
    const results = await Promise.all(buckets.map(b => this.check(b)));
    const rejected = results.find(r => !r.allowed);
    if (rejected) {
      const idx = results.indexOf(rejected);
      return { ...rejected, rejectedKey: buckets[idx].key };
    }
    // Return the most restrictive remaining count for headers
    const tightest = results.reduce((m, r) => (r.remaining < m.remaining ? r : m), results[0]);
    return tightest;
  }
}

export function createRateLimit(supabase: SupabaseClient): RateLimit {
  return new RateLimit(supabase);
}

/**
 * Extract a stable client IP from a Vercel request.
 * Prefers x-forwarded-for (Vercel sets this), falls back to x-real-ip.
 * Returns 'unknown' if no header is present (rare on Vercel).
 */
export function getClientIp(req: VercelRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) {
    const first = (Array.isArray(fwd) ? fwd[0] : fwd).split(',')[0].trim();
    if (first) return first;
  }
  const real = req.headers['x-real-ip'];
  if (real) return Array.isArray(real) ? real[0] : real;
  return 'unknown';
}

/** Helper: write standard 429 response with Retry-After + JSON body. */
export function rateLimitResponse(res: any, result: RateLimitResult, message = 'Too many requests'): void {
  res.setHeader('Retry-After', String(result.retryAfterSeconds));
  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  res.status(429).json({
    error: 'rate_limited',
    message,
    retry_after_seconds: result.retryAfterSeconds,
  });
}

/**
 * Common limit profiles. Tune as needed in env vars or settings.
 * Numbers chosen as defensive defaults for SL fintech context (low concurrency,
 * mostly mobile users on flaky connections — leave headroom for legitimate retries).
 */
export const LIMITS = {
  // Auth — strict
  LOGIN_PER_IP:        { limit: 10,  windowSeconds: 900 },   // 10 / 15min / IP
  LOGIN_PER_IDENT:     { limit: 5,   windowSeconds: 900 },   // 5  / 15min / username-or-phone
  REGISTER_PER_IP:     { limit: 5,   windowSeconds: 3600 },  // 5  / hr / IP
  PIN_VERIFY_PER_USER: { limit: 8,   windowSeconds: 900 },   // 8  / 15min / user
  PIN_VERIFY_PER_IP:   { limit: 30,  windowSeconds: 900 },   // 30 / 15min / IP

  // Money — generous enough for normal use, blocks scripted abuse
  TRANSFER_PER_USER:   { limit: 30,  windowSeconds: 3600 },  // 30 / hr / user
  PAYOUT_PER_USER:     { limit: 10,  windowSeconds: 3600 },  // 10 / hr / user
  CHECKOUT_PER_IP:     { limit: 60,  windowSeconds: 3600 },  // 60 / hr / IP (covers many sessions)

  // Webhooks/external — should never trip in practice but worth caps
  WEBHOOK_PER_IP:      { limit: 600, windowSeconds: 60 },    // 10 rps sustained
} as const;
