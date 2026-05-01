/**
 * Shared module — trimmed for the Terminal service.
 *
 * Contains only what the HEMI + event-gate handlers and the reconciler
 * actually need:
 *   - Supabase client (service-role)
 *   - getAuthenticatedUserId (sso_tokens lookup; same auth shape as Card)
 *   - logAlert (system_alerts insert + admin notification on critical)
 *
 * The Card monorepo's `api-deploy/lib/_shared.ts` has many more helpers
 * (mapUser, generateTokens, broadcastNotification, KYC stuff, etc.)
 * that are irrelevant here. We deliberately don't re-export them — the
 * Terminal service should not be doing user mapping, token issuance, or
 * KYC. If you find yourself needing one of those, consider whether the
 * logic belongs in the main API instead.
 *
 * When auth or alert logging changes, this file and Card's _shared.ts
 * must be updated in lockstep. They read/write the same DB tables
 * (sso_tokens, system_alerts, notifications) so semantic drift breaks
 * cross-service compatibility.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { VercelRequest } from '@vercel/node';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceKey || !supabaseAnonKey) {
  throw new Error(
    'Missing required Supabase env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY must be set.',
  );
}

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseServiceKey);
export const supabaseAnon: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey);

/**
 * Authenticate a request and return the user ID. Tries: sso_tokens
 * session token, Supabase auth JWT, legacy base64 JWT — same precedence
 * as the main API so a single session token works against both
 * services.
 */
export async function getAuthenticatedUserId(req: VercelRequest): Promise<string | null> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return null;

    const token = authHeader.replace(/^(Bearer|Session)\s+/i, '');
    if (!token) return null;

    const { data: session } = await supabase
      .from('sso_tokens')
      .select('user_id, expires_at')
      .eq('token', token)
      .maybeSingle();

    if (session) {
      if (new Date(session.expires_at) < new Date()) return null;
      return session.user_id;
    }

    const { data: { user } } = await supabaseAnon.auth.getUser(token);
    if (user) return user.id;

    try {
      const payload = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
      if (payload.userId && payload.exp && payload.exp > Date.now()) {
        return payload.userId;
      }
    } catch {
      // Legacy JWT decode failed — token is not in legacy format
    }

    return null;
  } catch (err) {
    console.error('[Auth] getAuthenticatedUserId error:', err);
    return null;
  }
}

/**
 * Server-side alert helper. Logs to system_alerts and notifies admins on
 * critical severity. Same table semantics as the main API so a critical
 * Terminal alert surfaces in the same admin observability views.
 */
export async function logAlert(
  severity: 'critical' | 'error' | 'warning',
  service: string,
  errorCode: string,
  message: string,
  context: Record<string, any> = {},
): Promise<void> {
  try {
    await supabase.from('system_alerts').insert({
      severity,
      service,
      error_code: errorCode,
      message,
      context: { ...context, source: 'peeap_terminal', timestamp: new Date().toISOString() },
    });

    if (severity === 'critical') {
      const { data: admins } = await supabase
        .from('users')
        .select('id')
        .or('roles.cs.{admin},roles.cs.{superadmin}')
        .limit(10);

      if (admins && admins.length > 0) {
        const notifications = admins.map(admin => ({
          user_id: admin.id,
          type: 'security_alert',
          title: `CRITICAL: ${service} - ${errorCode}`,
          body: message,
          data: { severity, service, error_code: errorCode, context },
          read: false,
          created_at: new Date().toISOString(),
        }));
        await supabase.from('notifications').insert(notifications);
      }
    }
  } catch (err) {
    console.error('[Alert] Failed to log alert:', err);
  }
}

/**
 * Extract a stable client IP from a Vercel request. Prefers
 * x-forwarded-for (Vercel sets this), falls back to x-real-ip.
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
