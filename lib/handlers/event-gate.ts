/**
 * Event gate validation — HEMI device-scan flow.
 *
 * Mode: an attendee opens the Peeap app, scans a static QR shown on a
 * HEMI Y68/soundbox at the venue gate. The QR encodes
 *   https://my.peeap.com/g?event=<eventId>&device=<deviceSn>
 * The Peeap web app POSTs the (eventId, deviceSn) to this endpoint
 * with the attendee's session token. We:
 *   1. Verify the device is registered as the gate for this event.
 *   2. Find a paid + unredeemed event_ticket belonging to the caller.
 *   3. Atomically mark it consumed (race-safe single-use).
 *   4. Trigger a "valid" or "invalid" audio cue on the device via the
 *      existing manual_message helper.
 *   5. Return the ticket detail so the Peeap app can show "Welcome,
 *      <name>" or "Invalid — see staff".
 *
 * Why this design:
 * - Throughput: per-attendee QR scanning at a busy gate is slow.
 *   Scanning a static device QR + atomic server-side check is fast.
 * - No staff phone needed at the gate — the device IS the gate.
 * - Works offline-tolerant: as soon as the attendee's phone has a
 *   sliver of signal, the verify call goes through; the device's
 *   audio cue is the canonical confirmation.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  supabase,
  getAuthenticatedUserId,
  logAlert,
  getClientIp,
} from '../_shared';
import { sendManualMessage, setPaymentResult } from './hemi';

// Photo-share defense — see migration 010 for context.
//
// Real gate peak observed in SL university test events: ~2–3 consumes/sec
// sustained during the opening rush. A WhatsApp-share burst looks like
// 50+ consumes in <5s from many distinct subnets. We throttle on the
// gap between those.
//
// We measure successful consumes only (not failed scans), so a queue of
// students with mixed valid/expired tickets doesn't trip the limit.
const GATE_RATE_LIMIT_WINDOW_MS = 5000;
const GATE_RATE_LIMIT_MAX = 20;

// If we see this many successful consumes in 60s on one event, fire a
// system alert + notify the merchant. Tuned above the real-gate peak
// so a normal opening rush doesn't trigger it.
const GATE_BURST_ALERT_WINDOW_MS = 60_000;
const GATE_BURST_ALERT_THRESHOLD = 80;
const GATE_BURST_DISTINCT_IP_THRESHOLD = 8;

export async function handleEventGateVerify(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { event_id, device_sn } = (req.body || {}) as {
    event_id?: string;
    device_sn?: string;
  };
  if (!event_id) return res.status(400).json({ error: 'event_id_required' });

  // 1. Look up the event and verify it's in device-scan mode.
  const { data: event } = await supabase
    .from('events')
    .select('id, title, merchant_id, validation_mode, gate_device_sn, start_date, end_date, status')
    .eq('id', event_id)
    .maybeSingle();
  if (!event) return res.status(404).json({ error: 'event_not_found' });
  if (event.validation_mode !== 'device_scan') {
    return res.status(400).json({ error: 'event_not_in_device_scan_mode' });
  }
  // If a device_sn was supplied via the QR, make sure it matches the
  // event's bound device. Prevents an attacker from re-using a gate URL
  // from a different event.
  if (device_sn && event.gate_device_sn && device_sn !== event.gate_device_sn) {
    return res.status(400).json({ error: 'device_event_mismatch' });
  }
  const deviceSn = event.gate_device_sn || device_sn || null;

  // 2. Find a paid, unredeemed ticket for this attendee + event.
  //    Existing schema uses `user_id` (not attendee_user_id) for the
  //    buyer. event_tickets may have multiple rows per attendee
  //    (different ticket types); pick the oldest unredeemed.
  const { data: ticket } = await supabase
    .from('event_tickets')
    .select('id, ticket_type_id, user_id, event_id, status, consumed_at, consumed_device_sn, created_at')
    .eq('event_id', event_id)
    .eq('user_id', userId)
    .is('consumed_at', null)
    .in('status', ['PAID', 'CONFIRMED', 'paid', 'confirmed'])
    .order('created_at', { ascending: true })
    .maybeSingle();

  if (!ticket) {
    // No valid ticket — let the device know with a "denied" cue if we
    // have one approved, otherwise stay silent.
    if (deviceSn) playGateAudio(deviceSn, event.merchant_id, 'invalid').catch(() => {});
    return res.status(403).json({
      ok: false,
      reason: 'no_valid_ticket',
      message: 'No paid ticket found on your account for this event.',
    });
  }

  // 2b. Photo-share rate-limit. Caller has a valid ticket; before we
  //     burn it, check whether this device has been smashed with consumes
  //     in the last few seconds. Real gate stays under the limit; a
  //     dorm-room WhatsApp burst trips it almost immediately. Counts
  //     successful consumes only (the index lives in migration 010), so
  //     a queue of mixed-validity scanners doesn't get throttled.
  if (deviceSn) {
    const cutoff = new Date(Date.now() - GATE_RATE_LIMIT_WINDOW_MS).toISOString();
    const { count: recent } = await supabase
      .from('event_tickets')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', event_id)
      .eq('consumed_device_sn', deviceSn)
      .gte('consumed_at', cutoff);
    if ((recent || 0) >= GATE_RATE_LIMIT_MAX) {
      // 429 — don't consume. Don't play valid audio (the gate isn't
      // actually letting them in). The phone will surface a "try again"
      // hint without revealing the threshold.
      return res.status(429).json({
        ok: false,
        reason: 'rate_limited',
        message: 'Gate is busy. Please try again in a moment.',
      });
    }
  }

  const clientIp = getClientIp(req);
  const userAgent = (req.headers['user-agent'] as string | undefined) || null;

  // 3. Atomic consume — UPDATE ... WHERE consumed_at IS NULL guarantees
  //    only one scanner can flip the row. Two simultaneous scans of the
  //    same ticket → second one comes back with no rows.
  const { data: consumed, error: consumeErr } = await supabase
    .from('event_tickets')
    .update({
      consumed_at: new Date().toISOString(),
      consumed_device_sn: deviceSn,
      consumed_ip: clientIp,
      consumed_user_agent: userAgent,
    })
    .eq('id', ticket.id)
    .is('consumed_at', null)
    .select('id, consumed_at')
    .maybeSingle();

  if (consumeErr || !consumed) {
    if (deviceSn) playGateAudio(deviceSn, event.merchant_id, 'invalid').catch(() => {});
    return res.status(409).json({
      ok: false,
      reason: 'already_consumed',
      message: 'This ticket has already been used at the gate.',
    });
  }

  // 4. Fire-and-forget device audio. "Valid" cue if the merchant
  //    uploaded one; otherwise a short payment-result chime as a
  //    universal "ack" since events skip the standard payment audio
  //    via the event_gate profile.
  if (deviceSn) playGateAudio(deviceSn, event.merchant_id, 'valid').catch(() => {});

  // 4b. Burst alert — out-of-band, doesn't block the response. If
  //     consumes from many distinct subnets land within a minute, that's
  //     the photo-share signature; alert the merchant + log a system
  //     alert so it shows up in admin observability.
  void detectAndAlertBurst(event_id, event.merchant_id, event.title).catch(err =>
    console.warn('[event-gate] burst detection failed:', err?.message),
  );

  // 5. Hydrate attendee info for the Peeap app's success view.
  const { data: attendee } = await supabase
    .from('users')
    .select('first_name, last_name, profile_picture')
    .eq('id', userId)
    .single();

  return res.status(200).json({
    ok: true,
    consumed_at: consumed.consumed_at,
    event: { id: event.id, title: event.title },
    attendee: attendee
      ? {
          name: `${attendee.first_name || ''} ${attendee.last_name || ''}`.trim(),
          profile_picture: attendee.profile_picture,
        }
      : null,
  });
}

// Play a "valid" or "invalid" audio cue on the gate device. Tries the
// merchant's approved custom audio first (display name contains 'valid'
// or 'invalid'); falls back to a short setPaymentResult tone with a
// sentinel amount so the device emits something audible even without
// a custom upload.
async function playGateAudio(
  deviceSn: string,
  merchantUserId: string | null | undefined,
  variant: 'valid' | 'invalid',
): Promise<void> {
  if (!merchantUserId) return;
  try {
    const { data: asset } = await supabase
      .from('merchant_terminal_assets')
      .select('cloud_speaker_filename')
      .eq('merchant_user_id', merchantUserId)
      .eq('asset_type', 'audio')
      .eq('status', 'approved')
      .ilike('display_name', `%${variant}%`)
      .order('reviewed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (asset?.cloud_speaker_filename) {
      await sendManualMessage({
        deviceSn,
        packetType: 'set_device_info',
        content: { play_audio: asset.cloud_speaker_filename },
      });
      return;
    }
    // No custom clip — fall back to a short standard tone. Use 1 SLE
    // for valid, 0 for invalid; setPaymentResult always produces a
    // tone but the spoken amount is short.
    await setPaymentResult({
      deviceSn,
      amount: variant === 'valid' ? 1 : 0,
      orderId: `gate_${variant}_${Date.now()}`,
    });
  } catch (err: any) {
    console.warn('[event-gate] audio cue failed:', err?.message);
  }
}

// Look back over the last minute of consumes for this event. If we see
// a high volume AND the consumes are spread across many distinct /24
// subnets, that's the photo-share signature: consumes coming from many
// home networks rather than the venue's one network.
//
// Logs a system alert + drops an in-app notification on the merchant.
// Idempotency is handled by `error_code` — repeated bursts in the same
// event will create multiple alerts; that's fine, fewer is wronger than
// more here.
async function detectAndAlertBurst(
  eventId: string,
  merchantUserId: string | null | undefined,
  eventTitle: string | null | undefined,
): Promise<void> {
  const since = new Date(Date.now() - GATE_BURST_ALERT_WINDOW_MS).toISOString();
  const { data: recent } = await supabase
    .from('event_tickets')
    .select('consumed_ip')
    .eq('event_id', eventId)
    .gte('consumed_at', since);
  if (!recent || recent.length < GATE_BURST_ALERT_THRESHOLD) return;

  // Count distinct /24 subnets. Real venue ≈ 1 subnet (gate's WAN).
  // Share attack ≈ many subnets (each attacker on their own home network).
  const subnets = new Set<string>();
  for (const row of recent) {
    const ip = (row as any).consumed_ip as string | null;
    if (!ip) continue;
    const parts = ip.split('.');
    if (parts.length === 4) subnets.add(parts.slice(0, 3).join('.'));
    else subnets.add(ip); // ipv6 — keep whole address
  }
  if (subnets.size < GATE_BURST_DISTINCT_IP_THRESHOLD) return;

  await logAlert(
    'critical',
    'event_gate',
    'gate_burst_suspected_share',
    `Suspected QR-share burst on event ${eventId}: ${recent.length} consumes across ${subnets.size} subnets in 60s`,
    { event_id: eventId, event_title: eventTitle, consume_count: recent.length, distinct_subnets: subnets.size },
  );

  // Notify the merchant directly so they can act at the gate.
  if (merchantUserId) {
    try {
      await supabase.from('notifications').insert({
        user_id: merchantUserId,
        type: 'event_gate_burst',
        title: 'Possible ticket-sharing detected',
        message: `${recent.length} check-ins from ${subnets.size} different networks in the last minute on "${eventTitle || 'your event'}". Review the gate.`,
        data: { event_id: eventId, consume_count: recent.length, distinct_subnets: subnets.size },
      });
    } catch (err: any) {
      console.warn('[event-gate] merchant notification failed:', err?.message);
    }
  }
}
