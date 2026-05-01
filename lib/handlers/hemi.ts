/**
 * HEMI scan-to-pay device integration (Y68 keypad + soundbox/screen).
 *
 * Pure Peeap-rail wallet→wallet. NEVER routes through Monime — Monime is
 * reserved for cash on/off-ramp only (see project_hemi_device.md memory).
 *
 * Flow (Y68 keypad):
 *   1. Cashier types amount + # on the device.
 *   2. HEMI cloud POSTs to our per-device URL: /api/hemi/in/<device_secret>
 *      Body: { deviceNumber, amountDue, keyValue: "F2", qrCode }
 *   3. We resolve owner_user_id via merchant_devices, optionally stamp
 *      cashier_user_id from any open device_shifts row, create a P2P
 *      checkout session, then push the QR back to the device via
 *      api.cloud-speaker.com/api/set_qr_code_data.
 *   4. Customer scans QR with Peeap app → handleCheckoutScanPay debits
 *      payer wallet and credits owner wallet atomically via the ledger.
 *   5. On COMPLETED, callDeviceAnnouncement is fired from
 *      handleCheckoutScanPay to play the audio on the device.
 *
 * Security notes:
 *   - HEMI's keypad callback has NO auth header. The per-device URL secret
 *     IS the auth — treat it like a webhook signing key. Rotate by issuing
 *     a new device_secret and asking FAE to re-bind the device.
 *   - Outbound calls to HEMI use HEMI_API_KEY (X-API-Key header).
 *   - Rate limit on the inbound URL is enforced via the existing
 *     createRateLimit utility, keyed by device_sn.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID, randomBytes } from 'crypto';
import { waitUntil } from '@vercel/functions';
import {
  supabase,
  getAuthenticatedUserId,
  logAlert,
} from '../_shared';

// `vercel env add` via shell pipe historically appends a trailing newline,
// which breaks strict comparisons. Trim every HEMI env var defensively.
const HEMI_BASE_URL = (process.env.HEMI_BASE_URL || 'https://api.cloud-speaker.com').trim();
const HEMI_SOUNDBOX_BASE = (process.env.HEMI_SOUNDBOX_BASE || 'http://47.254.244.245:8188').trim();
const HEMI_API_KEY = (process.env.HEMI_API_KEY || '').trim();
// Bootstrap token — used on first call. If it returns 401, we re-login via
// HEMI_LOGIN_ACCOUNT/HEMI_LOGIN_PASSWORD and cache the fresh token in-memory
// for the lifetime of the lambda. With Fluid Compute reusing instances, this
// effectively makes token rotation invisible to operators.
let HEMI_USER_TOKEN = (process.env.HEMI_USER_TOKEN || '').trim();
const HEMI_LOGIN_ACCOUNT = (process.env.HEMI_LOGIN_ACCOUNT || '').trim();
const HEMI_LOGIN_PASSWORD = (process.env.HEMI_LOGIN_PASSWORD || '').trim();
// User-level URL secret. ALL of Peeap's HEMI devices route to a single URL
// /api/hemi/in/<HEMI_URL_SECRET>; HEMI sets it once on our peeappay account
// and every device on that account inherits it.
const HEMI_URL_SECRET = (process.env.HEMI_URL_SECRET || '').trim();
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://my.peeap.com';
const CHECKOUT_URL = process.env.CHECKOUT_URL || 'https://checkout.peeap.com';
const SESSION_TIMEOUT_SECONDS = 180;

function requireApiKey(): string {
  if (!HEMI_API_KEY) {
    throw new Error('HEMI_API_KEY not configured');
  }
  return HEMI_API_KEY;
}

// ─── Outbound: push QR to device ─────────────────────────────────────────
export async function setQrCodeData(params: {
  deviceSn: string;
  amountDue: number;
  orderId: string;
  qrText: string;
  amountLabel?: string;
  timeOutSec?: number;  // override the default 3-minute payment timeout
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const body = {
    deviceNumber: params.deviceSn,
    amountDue: params.amountDue,
    orderId: params.orderId,
    timeOut: params.timeOutSec ?? SESSION_TIMEOUT_SECONDS,
    screenContent: {
      wait_payment_screen_qrcode_1_config: {
        txt: params.qrText,
      },
      ...(params.amountLabel && {
        wait_payment_screen_label_3_config: { txt: params.amountLabel },
      }),
    },
  };

  try {
    const r = await fetch(`${HEMI_BASE_URL}/api/set_qr_code_data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': requireApiKey(),
      },
      body: JSON.stringify(body),
    });
    const json: any = await r.json().catch(() => ({}));
    if (!r.ok || json?.success === false) {
      return { ok: false, error: json?.msg || `HTTP ${r.status}` };
    }
    return { ok: true, messageId: json?.data?.message_id };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'network_error' };
  }
}

// ─── Outbound: play "received Le X.XX" audio on device ───────────────────
export async function setPaymentResult(params: {
  deviceSn: string;
  amount: number;
  orderId: string;
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  try {
    const r = await fetch(`${HEMI_BASE_URL}/api/set_payment_result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': requireApiKey(),
      },
      body: JSON.stringify({
        deviceNumber: params.deviceSn,
        playPaymentAmount: params.amount,
        orderId: params.orderId,
      }),
    });
    const json: any = await r.json().catch(() => ({}));
    if (!r.ok || json?.success === false) {
      return { ok: false, error: json?.msg || `HTTP ${r.status}` };
    }
    return { ok: true, messageId: json?.data?.message_id };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'network_error' };
  }
}

// ─── Outbound: paint the IDLE home screen (persistent QR + labels) ───────
// Soundbox/screen device endpoint. Use this to plant the "Scan to claim"
// QR before pairing, and the merchant-branded screen after.
export async function updateHomeScreen(params: {
  deviceSn: string;
  qrText: string;
  topLabel?: string;
  bottomLabel?: string;
  qrColor?: string;
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const requestId = `hs_${randomUUID().replace(/-/g, '')}`;
  const body: Record<string, any> = {
    deviceNumber: params.deviceSn,
    requestId,
    timeStamp: Math.floor(Date.now() / 1000),
    qrcode_1_content: params.qrText,
    ...(params.qrColor && { qrcode_1_color: params.qrColor }),
  };
  if (params.topLabel) {
    body.label_1_content = params.topLabel;
    body.label_1_height = 32;
  }
  if (params.bottomLabel) {
    body.label_3_content = params.bottomLabel;
    body.label_3_height = 24;
  }
  try {
    const r = await fetch(`${HEMI_SOUNDBOX_BASE}/webhook/update_home_screen`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': requireApiKey(),
      },
      body: JSON.stringify(body),
    });
    const json: any = await r.json().catch(() => ({}));
    if (!r.ok || json?.success === false) {
      return { ok: false, error: json?.msg || `HTTP ${r.status}` };
    }
    return { ok: true, messageId: json?.data?.message_id };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'network_error' };
  }
}

/**
 * Push the "Scan to activate this Peeap device" QR onto the device's idle
 * screen. Uses the device's own SN as the identifier — merchant scans, app
 * sees the SN, calls /api/hemi/claim-by-sn. No per-device secret to share.
 *
 * Best-effort — failure (e.g. on a Y68 keypad model that doesn't support
 * update_home_screen) is logged, not surfaced.
 */
async function pushClaimScreen(deviceSn: string, _deviceSecret?: string): Promise<void> {
  const claimUrl = `${FRONTEND_URL}/claim?sn=${encodeURIComponent(deviceSn)}`;
  const r = await updateHomeScreen({
    deviceSn,
    qrText: claimUrl,
    topLabel: 'Scan with Peeap',
    bottomLabel: 'to activate',
  });
  if (!r.ok) {
    console.warn('[HEMI] pushClaimScreen failed:', deviceSn, r.error);
  }
}

/**
 * After a merchant claims a device, restore the factory idle screen
 * (Peeap brand image) by clearing the home-screen overrides we set
 * while it was unclaimed. Empirically HEMI's update_home_screen with
 * empty fields reverts the device to its built-in default image —
 * confirmed against device 2512230002 on 2026-04-29.
 *
 * We DON'T paint a merchant-specific QR onto the idle screen anymore.
 * The previous design replaced the factory Peeap logo with a generic
 * QR, which made claimed devices look identical to unclaimed ones.
 * Now: idle = factory default; merchant identity surfaces only on the
 * wait-payment screen (set_qr_code_data), which the device shows when
 * the cashier types an amount.
 */
async function pushMerchantHomeScreen(
  deviceSn: string,
  _merchantName: string,
  _merchantUserId: string,
): Promise<void> {
  // Empty payload → device reverts to factory home image.
  const r = await updateHomeScreen({
    deviceSn,
    qrText: '',
    topLabel: '',
    bottomLabel: '',
  });
  if (!r.ok) console.warn('[HEMI] pushMerchantHomeScreen restore failed:', deviceSn, r.error);
}

/**
 * Fire-and-forget device announce — called from handleCheckoutScanPay after
 * a successful debit/credit. Failure is logged but never bubbled back to
 * the customer (they were charged; the audio is best-effort).
 *
 * Profile-aware: an event_gate device skips the long "received Le X.XX"
 * audio because gate throughput depends on rapid scanning. If the merchant
 * has an approved 'event_valid' audio uploaded we play that via
 * manual_message instead; otherwise the device stays silent and the
 * customer/attendee gets a visual-only confirmation from the Peeap app.
 */
export async function announceIfDeviceSession(session: any, paidAmount: number): Promise<void> {
  const deviceSn = session?.metadata?.device_sn;
  if (!deviceSn) return;
  try {
    // Look up the device profile so we can branch on event_gate. The
    // session metadata doesn't carry profile, so a quick DB read is the
    // only reliable source. Falls back to standard payment audio if the
    // row is missing.
    const { data: device } = await supabase
      .from('merchant_devices')
      .select('profile, owner_user_id')
      .eq('device_sn', deviceSn)
      .maybeSingle();

    if (device?.profile === 'event_gate') {
      // Try to play an approved "ticket valid" custom audio if the
      // merchant has uploaded one. Falls back to silence — events
      // depend on fast scanning and the Peeap app already shows the
      // attendee a visual confirmation.
      const { data: validAudio } = await supabase
        .from('merchant_terminal_assets')
        .select('cloud_speaker_filename')
        .eq('merchant_user_id', device.owner_user_id)
        .eq('asset_type', 'audio')
        .eq('status', 'approved')
        .ilike('display_name', '%valid%')
        .order('reviewed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (validAudio?.cloud_speaker_filename) {
        await sendManualMessage({
          deviceSn,
          packetType: 'set_device_info',
          content: { play_audio: validAudio.cloud_speaker_filename },
        }).catch(err => console.warn('[HEMI] event_gate audio failed:', err?.message));
      }
      return; // skip the standard "received Le X.XX" audio
    }

    const r = await setPaymentResult({
      deviceSn,
      amount: paidAmount,
      orderId: session.external_id,
    });
    if (!r.ok) {
      console.error('[HEMI] setPaymentResult failed:', r.error, 'device:', deviceSn);
      await logAlert(
        'warning',
        'hemi',
        'announce_failed',
        `Device ${deviceSn} announce failed: ${r.error}`,
        { device_sn: deviceSn, session_id: session.external_id, amount: paidAmount },
      ).catch(() => {});
    }
  } catch (err: any) {
    console.error('[HEMI] announce exception:', err?.message);
  }
}

// ─── Outbound: upload custom audio to cloud-speaker audio bank ──────────
// Wraps /aduio_upload (HEMI's typo). Multipart form: audio file + query
// params (language=usa_eng, deviceModel, user). Returns a taskId; the
// actual file conversion + flashing happens server-side at HEMI. We
// optionally poll get_task_detail to wait for completion, but for
// merchant uploads we return the taskId immediately and let the client
// poll if it cares.
export async function uploadAudioFile(params: {
  fileBuffer: Buffer;
  filename: string;
  contentType: string;
  language?: string;
  deviceModel?: string;
}): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  // Ensure we have a valid token first (auto-refresh if needed). We can't
  // re-use cloudSpeakerFetch because this is multipart, not JSON.
  if (!HEMI_USER_TOKEN) {
    const login = await loginCloudSpeaker();
    if (!login.ok) return { ok: false, error: login.error };
  }

  const language = params.language || 'usa_eng';
  const deviceModel = params.deviceModel || 'Y68B';
  const user = HEMI_LOGIN_ACCOUNT || 'peeappay';
  const qs = new URLSearchParams({ language, deviceModel, user }).toString();

  const exec = async (token: string) => {
    // Build multipart manually so we don't pull in form-data dependency.
    const boundary = `----HEMI${randomBytes(16).toString('hex')}`;
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${params.filename}"\r\n` +
      `Content-Type: ${params.contentType}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, params.fileBuffer, tail]);
    return fetch(`${HEMI_BASE_URL}/aduio_upload?${qs}`, {
      method: 'POST',
      headers: {
        'authorization': token,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });
  };

  try {
    let r = await exec(HEMI_USER_TOKEN);
    let json: any = await r.json().catch(() => ({}));
    const isAuthFail = r.status === 401 || json?.code === 401 || json?.code === 4001
      || /token.*invalid|token.*expired/i.test(json?.msg || '');
    if (isAuthFail) {
      const login = await loginCloudSpeaker();
      if (!login.ok) return { ok: false, error: login.error };
      r = await exec(HEMI_USER_TOKEN);
      json = await r.json().catch(() => ({}));
    }
    if (!r.ok || json?.code !== 0) {
      return { ok: false, error: json?.msg || `HTTP ${r.status}` };
    }
    return { ok: true, taskId: json?.data?.taskId || json?.data?.task_id };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'network_error' };
  }
}

export async function getUploadTaskStatus(taskId: string): Promise<{ ok: boolean; status?: string; filename?: string; error?: string }> {
  const r = await cloudSpeakerFetch(`/get_task_detail?taskId=${encodeURIComponent(taskId)}`, { method: 'GET' });
  if (!r.ok) return { ok: false, error: r.error };
  const data = r.json?.data || {};
  return { ok: true, status: data.status || data.state, filename: data.filename || data.file_name };
}

// ─── Outbound: send arbitrary control packet via /manual_message ─────────
// User-token auth (cloud-speaker portal API), not X-API-Key. Used to swap
// post-payment audio (set_device_info + play_audio) and any other portal-
// level device commands. Auto-refreshes token on 401 via cloudSpeakerFetch.
export async function sendManualMessage(params: {
  deviceSn: string;
  packetType: string;
  content: Record<string, any>;
}): Promise<{ ok: boolean; error?: string; data?: any }> {
  const r = await cloudSpeakerFetch('/manual_message', {
    body: {
      deviceNumber: params.deviceSn,
      packet_type: params.packetType,
      content: params.content,
    },
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, data: r.json?.data };
}

// ─── Admin: ad-hoc command panel ─────────────────────────────────────────
// Dispatches to one of the four device primitives based on the `action`
// field in the body. Admin-only — used for testing and one-off operations
// from the device detail drawer (push test QR, play test audio, repaint
// screen, swap audio file).
export async function handleHemiAdminCommand(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { data: u } = await supabase.from('users').select('roles').eq('id', userId).single();
  const roles = (u?.roles as string[]) || [];
  if (!roles.includes('admin') && !roles.includes('superadmin')) {
    return res.status(403).json({ error: 'admin_only' });
  }

  const { device_sn, action, params } = (req.body || {}) as {
    device_sn?: string;
    action?: 'push_qr' | 'play_amount' | 'set_screen' | 'play_audio' | 'manual_message';
    params?: Record<string, any>;
  };

  if (!device_sn) return res.status(400).json({ error: 'device_sn_required' });
  if (!action) return res.status(400).json({ error: 'action_required' });

  // Verify device exists in our DB to prevent admins from poking arbitrary
  // SNs that aren't ours. Skip the in-cloud check — admin may want to test
  // a freshly-added device that hasn't been synced yet.
  const { data: device } = await supabase
    .from('merchant_devices')
    .select('device_sn, status')
    .eq('device_sn', device_sn)
    .maybeSingle();
  if (!device) return res.status(404).json({ error: 'device_not_in_db' });

  const p = params || {};
  const orderId = `admin_${Date.now()}`;

  switch (action) {
    case 'push_qr': {
      if (!p.qrText) return res.status(400).json({ error: 'qrText_required' });
      const r = await setQrCodeData({
        deviceSn: device_sn,
        amountDue: typeof p.amountDue === 'number' ? p.amountDue : 0,
        orderId,
        qrText: String(p.qrText),
        amountLabel: p.amountLabel ? String(p.amountLabel) : undefined,
      });
      return r.ok ? res.status(200).json({ ok: true, messageId: r.messageId }) : res.status(502).json({ error: r.error });
    }
    case 'play_amount': {
      const amt = typeof p.amount === 'number' ? p.amount : 1;
      const r = await setPaymentResult({ deviceSn: device_sn, amount: amt, orderId });
      return r.ok ? res.status(200).json({ ok: true, messageId: r.messageId }) : res.status(502).json({ error: r.error });
    }
    case 'set_screen': {
      if (!p.qrText) return res.status(400).json({ error: 'qrText_required' });
      const r = await updateHomeScreen({
        deviceSn: device_sn,
        qrText: String(p.qrText),
        topLabel: p.topLabel ? String(p.topLabel) : undefined,
        bottomLabel: p.bottomLabel ? String(p.bottomLabel) : undefined,
        qrColor: p.qrColor ? String(p.qrColor) : undefined,
      });
      return r.ok ? res.status(200).json({ ok: true, messageId: r.messageId }) : res.status(502).json({ error: r.error });
    }
    case 'play_audio': {
      // Swap post-payment audio to a custom clip (must be uploaded already).
      if (!p.filename) return res.status(400).json({ error: 'filename_required' });
      const r = await sendManualMessage({
        deviceSn: device_sn,
        packetType: 'set_device_info',
        content: { play_audio: String(p.filename) },
      });
      return r.ok ? res.status(200).json({ ok: true, data: r.data }) : res.status(502).json({ error: r.error });
    }
    case 'manual_message': {
      // Escape hatch: send any packet with arbitrary content.
      if (!p.packetType) return res.status(400).json({ error: 'packetType_required' });
      const r = await sendManualMessage({
        deviceSn: device_sn,
        packetType: String(p.packetType),
        content: (p.content && typeof p.content === 'object') ? p.content : {},
      });
      return r.ok ? res.status(200).json({ ok: true, data: r.data }) : res.status(502).json({ error: r.error });
    }
    default:
      return res.status(400).json({ error: 'unknown_action' });
  }
}

// ─── Inbound: HEMI cloud → us, when cashier presses # on Y68 keypad ──────
//
// COLD-START NOTE: HEMI's keypad has a ~3-5 s timeout. We can't move this
// to a dedicated micro-function easily (Vercel's wildcard rewrite catches
// all /api/* before filesystem matching), so we keep it here in the giant
// router and rely on a GitHub Actions cron (.github/workflows/hemi-keepalive.yml)
// hitting /api/hemi/in/_keepalive every 5 min to keep the lambda warm.
//
// The `_keepalive` short-circuit at the top of this handler returns 200
// immediately without touching the DB. That's the cron's target — it
// causes the lambda to load and stay alive without creating phantom
// device rows.
export async function handleHemiKeypadInbound(
  req: VercelRequest,
  res: VercelResponse,
  deviceSecret: string,
) {
  // Keepalive probe — any secret that starts with `_` short-circuits.
  // The GitHub cron uses `_keepalive`. Return immediately without a DB
  // round-trip so the cron is cheap.
  if (deviceSecret && deviceSecret.startsWith('_')) {
    return res.status(200).json({ ok: true, probe: true, ts: Date.now() });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // URL-secret check — this is the auth gate (HEMI doesn't sign callbacks).
  if (!deviceSecret || deviceSecret.length < 16) {
    return res.status(404).json({ error: 'not_found' });
  }
  if (!HEMI_URL_SECRET || deviceSecret !== HEMI_URL_SECRET) {
    return res.status(404).json({ error: 'not_found' });
  }

  const { deviceNumber, amountDue, keyValue } = (req.body || {}) as {
    deviceNumber?: string;
    amountDue?: number;
    keyValue?: string;
  };

  if (!deviceNumber || typeof amountDue !== 'number' || amountDue <= 0) {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  // ACK to cloud-speaker IMMEDIATELY before any DB work — keypad timeout
  // is ~3-5 s. waitUntil keeps the background promise alive past res.end()
  // on Fluid Compute.
  res.status(200).json({ accepted: true, mode: keyValue === 'F1' ? 'cash' : 'qr' });

  if (keyValue === 'F1') return;  // Cash mode — no QR push needed.

  waitUntil((async () => {
    try {
      let { data: device } = await supabase
        .from('merchant_devices')
        .select('id, device_sn, owner_user_id, status, terminal_label, claimed_at, profile')
        .eq('device_sn', deviceNumber)
        .maybeSingle();

      if (!device) {
        const { data: created } = await supabase
          .from('merchant_devices')
          .insert({
            device_sn: deviceNumber,
            device_secret: randomBytes(24).toString('base64url'),
            owner_user_id: null,
            model: 'y68',
            profile: 'merchant',
            status: 'active',
          })
          .select('id, device_sn, owner_user_id, status, terminal_label, claimed_at, profile')
          .single();
        device = created;
        if (!device) return;
      }

      if (device.status !== 'active') return;

      // Event-gate mode ignores keypad input entirely. There's no payment
      // happening at the gate; the device only exists to display a
      // static QR that attendees scan. Both screens were painted
      // permanently when the merchant bound the event (very long
      // timeOut on the wait-payment screen + no-timeout idle home), so
      // we don't need to do anything here. Just ACK and bail.
      if (device.profile === 'event_gate' && device.claimed_at) {
        return;
      }

      // Unclaimed → paint a "POS not connected" QR on the wait-payment
      // screen with the amount the cashier typed. When the customer
      // scans, they land on /pos-disconnected which shows a clear
      // message ("This terminal is not connected to a merchant — ask
      // the cashier to activate it") instead of a payment surface they
      // can't actually pay through. The amount echoes the keypad press
      // so the cashier sees their input was received.
      if (!device.claimed_at || !device.owner_user_id) {
        const disconnectedUrl = `${FRONTEND_URL}/pos-disconnected?sn=${encodeURIComponent(deviceNumber)}&amount=${encodeURIComponent(String(amountDue))}`;
        await setQrCodeData({
          deviceSn: deviceNumber,
          amountDue,
          orderId: `disc_${Date.now()}`,
          qrText: disconnectedUrl,
          amountLabel: 'Not connected',
        });
        return;
      }

      const [{ data: owner }, { data: openShift }] = await Promise.all([
        supabase
          .from('users')
          .select('id, first_name, last_name, username, profile_picture')
          .eq('id', device.owner_user_id)
          .single(),
        supabase
          .from('device_shifts')
          .select('id, staff_user_id')
          .eq('device_sn', device.device_sn)
          .is('ended_at', null)
          .maybeSingle(),
      ]);

      const ownerName = owner
        ? `${owner.first_name || ''} ${owner.last_name || ''}`.trim() || owner.username || 'Merchant'
        : 'Merchant';

      supabase
        .from('merchant_devices')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', device.id)
        .then(() => {});

      const sessionId = `cs_${randomUUID().replace(/-/g, '')}`;
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

      const { data: session, error: sessErr } = await supabase
        .from('checkout_sessions')
        .insert({
          external_id: sessionId,
          merchant_id: null,
          status: 'OPEN',
          amount: amountDue,
          currency_code: 'SLE',
          description: device.terminal_label
            ? `${ownerName} · ${device.terminal_label}`
            : `Payment to ${ownerName}`,
          merchant_name: ownerName,
          merchant_logo_url: owner?.profile_picture || null,
          brand_color: '#4F46E5',
          payment_methods: { qr: true, card: true, mobile: false },
          metadata: {
            type: 'p2p',
            recipientId: device.owner_user_id,
            recipientName: ownerName,
            device_sn: device.device_sn,
            terminal_label: device.terminal_label || null,
            cashier_user_id: openShift?.staff_user_id || null,
            shift_id: openShift?.id || null,
            source: 'hemi_keypad',
            expectedAmount: amountDue,
          },
          expires_at: expiresAt.toISOString(),
        })
        .select('external_id')
        .single();

      if (sessErr || !session) {
        console.error('[HEMI] session create failed:', sessErr);
        return;
      }

      const qrText = `${CHECKOUT_URL}/scan-pay/${session.external_id}`;
      const push = await setQrCodeData({
        deviceSn: device.device_sn,
        amountDue,
        orderId: session.external_id,
        qrText,
        amountLabel: amountDue.toFixed(2),
      });

      if (!push.ok) {
        console.error('[HEMI] QR push failed:', push.error);
        await supabase
          .from('checkout_sessions')
          .update({ status: 'EXPIRED', metadata: { device_sn: device.device_sn, push_error: push.error } })
          .eq('external_id', session.external_id);
      }
    } catch (err: any) {
      console.error('[HEMI] async pipeline exception:', err?.message);
    }
  })());
}

// ─── Admin: register a device ────────────────────────────────────────────
export async function handleHemiDeviceRegister(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { device_sn, model, profile, terminal_label } = (req.body || {}) as {
    device_sn?: string;
    model?: string;
    profile?: string;
    terminal_label?: string;
  };

  if (!device_sn || device_sn.length < 4) {
    return res.status(400).json({ error: 'device_sn_required' });
  }

  const deviceSecret = randomBytes(24).toString('base64url');

  const { data, error } = await supabase
    .from('merchant_devices')
    .insert({
      device_sn,
      device_secret: deviceSecret,
      owner_user_id: userId,
      model: model || 'y68',
      profile: profile || 'merchant',
      terminal_label: terminal_label || null,
    })
    .select('id, device_sn, profile, terminal_label')
    .single();

  if (error) {
    if ((error as any).code === '23505') {
      return res.status(409).json({ error: 'device_already_registered' });
    }
    console.error('[HEMI] register error:', error);
    return res.status(500).json({ error: error.message });
  }

  const inboundUrl = `${process.env.PUBLIC_API_URL || 'https://api.peeap.com'}/api/hemi/in/${deviceSecret}`;

  return res.status(201).json({
    device: data,
    paymentRequestUrl: inboundUrl,
    nextSteps: 'Send paymentRequestUrl to HEMI FAE to bind to this device SN.',
  });
}

// ─── Merchant: list devices owned by current user ───────────────────────
// Includes cloud_state so the merchant Terminal Settings page can render
// live battery/signal/online state. With ?live=1 we additionally fan out
// to cloud-speaker (cached 30 s by cloudSpeakerListDevices) and overlay
// fresh state on top of the DB row — fixes the false-offline case where
// the device is heartbeating to cloud-speaker but our DB hasn't been
// re-synced by an admin.
export async function handleHemiDeviceList(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const url = new URL(req.url || '', `https://${req.headers.host}`);
  const wantLive = url.searchParams.get('live') === '1';

  const dbPromise = supabase
    .from('merchant_devices')
    .select('id, device_sn, model, profile, terminal_label, status, last_seen_at, last_synced_at, cloud_state, created_at')
    .eq('owner_user_id', userId)
    .order('created_at', { ascending: false });

  if (!wantLive) {
    const { data, error } = await dbPromise;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ devices: data || [] });
  }

  // Fan out DB + cloud-speaker in parallel. cloud-speaker call uses the
  // existing 30 s in-memory cache, so multiple merchants opening their
  // page within that window share one upstream fetch.
  const [dbRes, csRes] = await Promise.all([dbPromise, cloudSpeakerListDevices()]);
  if (dbRes.error) return res.status(500).json({ error: dbRes.error.message });

  const csBySn = new Map<string, any>();
  if (csRes.ok && csRes.devices) {
    for (const d of csRes.devices) {
      if (d.deviceNumber) csBySn.set(d.deviceNumber, d);
    }
  }

  const nowIso = new Date().toISOString();
  const persistRows: Array<{ device_sn: string; cloud_state: any; last_synced_at: string; last_seen_at: string | null }> = [];

  const overlayed = (dbRes.data || []).map((d: any) => {
    const csRow = csBySn.get(d.device_sn);
    if (!csRow) return d; // not on cloud-speaker right now → keep DB cloud_state as-is
    const networkMode = csRow.network_mode ?? d.cloud_state?.networkMode;
    const isWifi = (networkMode || '').toUpperCase() === 'WIFI';
    const cloudState = {
      ...(d.cloud_state || {}),
      deviceModel: csRow.deviceModel ?? d.cloud_state?.deviceModel,
      networkStatus: csRow.networkStatus ?? d.cloud_state?.networkStatus,
      networkMode,
      wifiName: csRow.wifi_name ?? d.cloud_state?.wifiName,
      wifiSignal: csRow.wifi_signal ?? d.cloud_state?.wifiSignal,
      cellSignal: csRow.signal_value ?? d.cloud_state?.cellSignal,
      signalValue: isWifi
        ? (csRow.wifi_signal ?? csRow.signal_value ?? d.cloud_state?.signalValue)
        : (csRow.signal_value ?? d.cloud_state?.signalValue),
      batteryPercent: csRow.battery_percent ?? d.cloud_state?.batteryPercent,
      batteryVoltage: csRow.battery_voltage ?? d.cloud_state?.batteryVoltage,
      lastReportAt: csRow.lastReportDataTime ?? d.cloud_state?.lastReportAt,
      ip: csRow.ip ?? d.cloud_state?.ip,
    };
    const lastSeen = csRow.lastReportDataTime
      ? new Date(csRow.lastReportDataTime).toISOString()
      : d.last_seen_at;
    persistRows.push({
      device_sn: d.device_sn,
      cloud_state: cloudState,
      last_synced_at: nowIso,
      last_seen_at: lastSeen,
    });
    return { ...d, cloud_state: cloudState, last_seen_at: lastSeen };
  });

  // Persist fresh state to DB so other clients (and Supabase Realtime
  // subscribers) see updates without each running their own ?live=1 fetch.
  // Fire-and-forget — the response doesn't depend on this finishing.
  if (persistRows.length > 0) {
    Promise.all(persistRows.map(p =>
      supabase
        .from('merchant_devices')
        .update({
          cloud_state: p.cloud_state,
          last_synced_at: p.last_synced_at,
          last_seen_at: p.last_seen_at,
        })
        .eq('device_sn', p.device_sn)
        .then(() => {}),
    )).catch(() => {});
  }

  return res.status(200).json({
    devices: overlayed,
    cloud_speaker_error: csRes.ok ? null : csRes.error,
  });
}

// ─── Merchant: upload custom audio to a device they own ─────────────────
// Body: { filename, contentType, dataBase64 } — keeping it JSON instead of
// multipart so the route plays nicely with our existing POST/JSON router.
// Returns the taskId from cloud-speaker; the client polls /audio/:taskId.
//
// Limits enforced server-side:
//   - max 500 KB per upload (HEMI bank cap is 2.5 MB total per account)
//   - mp3 / wav only (HEMI doesn't accept anything else)
const MAX_AUDIO_BYTES = 500 * 1024;
const ALLOWED_AUDIO_MIME = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav']);

export async function handleHemiDeviceAudioUpload(
  req: VercelRequest,
  res: VercelResponse,
  deviceSn: string,
) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { data: device } = await supabase
    .from('merchant_devices')
    .select('owner_user_id, status, cloud_state')
    .eq('device_sn', deviceSn)
    .maybeSingle();
  if (!device) return res.status(404).json({ error: 'device_not_found' });
  if (device.owner_user_id !== userId) return res.status(403).json({ error: 'not_your_device' });
  if (device.status !== 'active') return res.status(403).json({ error: 'device_disabled' });

  const { filename, contentType, dataBase64 } = (req.body || {}) as {
    filename?: string;
    contentType?: string;
    dataBase64?: string;
  };
  if (!filename || !contentType || !dataBase64) {
    return res.status(400).json({ error: 'filename_contentType_dataBase64_required' });
  }
  if (!ALLOWED_AUDIO_MIME.has(contentType.toLowerCase())) {
    return res.status(400).json({ error: 'unsupported_audio_type', allowed: Array.from(ALLOWED_AUDIO_MIME) });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(dataBase64, 'base64');
  } catch {
    return res.status(400).json({ error: 'invalid_base64' });
  }
  if (buffer.length === 0) return res.status(400).json({ error: 'empty_file' });
  if (buffer.length > MAX_AUDIO_BYTES) {
    return res.status(413).json({ error: 'file_too_large', max_bytes: MAX_AUDIO_BYTES });
  }

  // Sanitize filename — strip path separators, allow only ascii chars.
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);

  // Upload to cloud-speaker. deviceModel from cloud_state if we have it.
  const csModel = (device.cloud_state as any)?.deviceModel || 'Y68B';

  const r = await uploadAudioFile({
    fileBuffer: buffer,
    filename: safeName,
    contentType,
    language: 'usa_eng',
    deviceModel: String(csModel),
  });

  if (!r.ok) return res.status(502).json({ error: r.error });

  // Record a pending asset row so admin can review before merchant can
  // activate. cloud_speaker_filename is the actual stored name HEMI used.
  const csFilename = `usa_eng_${safeName}`;
  const { data: asset } = await supabase
    .from('merchant_terminal_assets')
    .insert({
      merchant_user_id: userId,
      device_sn: deviceSn,
      asset_type: 'audio',
      display_name: filename, // user-facing name (pre-sanitization)
      original_filename: safeName,
      mime_type: contentType,
      size_bytes: buffer.length,
      cloud_speaker_filename: csFilename,
      cloud_speaker_task_id: r.taskId || null,
      status: 'pending',
    })
    .select('id, status, submitted_at')
    .single();

  return res.status(200).json({
    ok: true,
    taskId: r.taskId,
    filename: csFilename,
    asset_id: asset?.id,
    status: 'pending',
    message: 'Uploaded. Awaiting admin approval before it can be played on the device.',
  });
}

// ─── Merchant: list their own terminal assets (audio + images) ──────────
export async function handleHemiMerchantAssetList(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const url = new URL(req.url || '', `https://${req.headers.host}`);
  const deviceSn = url.searchParams.get('device_sn') || null;
  const assetType = url.searchParams.get('type') || null;

  let q = supabase
    .from('merchant_terminal_assets')
    .select('id, device_sn, asset_type, display_name, mime_type, size_bytes, cloud_speaker_filename, status, rejection_reason, submitted_at, reviewed_at')
    .eq('merchant_user_id', userId)
    .order('submitted_at', { ascending: false });
  if (deviceSn) q = q.eq('device_sn', deviceSn);
  if (assetType) q = q.eq('asset_type', assetType);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ assets: data || [] });
}

// ─── Admin: terminal-asset approval queue ───────────────────────────────
export async function handleHemiAdminAssetQueue(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const { data: u } = await supabase.from('users').select('roles').eq('id', userId).single();
  const roles = (u?.roles as string[]) || [];
  if (!roles.includes('admin') && !roles.includes('superadmin')) {
    return res.status(403).json({ error: 'admin_only' });
  }

  const url = new URL(req.url || '', `https://${req.headers.host}`);
  const status = url.searchParams.get('status') || 'pending';

  const { data, error } = await supabase
    .from('merchant_terminal_assets')
    .select(`
      id, merchant_user_id, device_sn, asset_type, display_name,
      original_filename, mime_type, size_bytes, cloud_speaker_filename,
      status, rejection_reason, submitted_at, reviewed_at,
      merchant:users!merchant_terminal_assets_merchant_user_id_fkey ( email, first_name, last_name )
    `)
    .eq('status', status)
    .order('submitted_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ assets: data || [] });
}

// ─── Admin: approve / reject a terminal asset ──────────────────────────
export async function handleHemiAdminAssetReview(
  req: VercelRequest,
  res: VercelResponse,
  assetId: string,
) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const { data: u } = await supabase.from('users').select('roles').eq('id', userId).single();
  const roles = (u?.roles as string[]) || [];
  if (!roles.includes('admin') && !roles.includes('superadmin')) {
    return res.status(403).json({ error: 'admin_only' });
  }

  const { decision, reason } = (req.body || {}) as { decision?: 'approve' | 'reject'; reason?: string };
  if (decision !== 'approve' && decision !== 'reject') {
    return res.status(400).json({ error: 'decision_must_be_approve_or_reject' });
  }
  if (decision === 'reject' && !reason) {
    return res.status(400).json({ error: 'reason_required_for_reject' });
  }

  const update: Record<string, any> = {
    status: decision === 'approve' ? 'approved' : 'rejected',
    reviewed_by_user_id: userId,
    reviewed_at: new Date().toISOString(),
  };
  if (decision === 'reject') update.rejection_reason = reason;

  const { data, error } = await supabase
    .from('merchant_terminal_assets')
    .update(update)
    .eq('id', assetId)
    .select('id, status, rejection_reason, reviewed_at')
    .single();
  if (error || !data) return res.status(500).json({ error: error?.message || 'review_failed' });
  return res.status(200).json({ asset: data });
}

export async function handleHemiAudioTaskStatus(
  req: VercelRequest,
  res: VercelResponse,
  taskId: string,
) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  if (!taskId) return res.status(400).json({ error: 'taskId_required' });

  const r = await getUploadTaskStatus(taskId);
  if (!r.ok) return res.status(502).json({ error: r.error });
  return res.status(200).json({ ok: true, status: r.status, filename: r.filename });
}

// ─── Merchant: release / sign-out from a terminal ──────────────────────
// Hard release — sets owner_user_id NULL, claimed_at NULL, archives any
// pending personalization assets, and pushes the activation QR back onto
// the device screen so the next merchant who scans can claim it.
// Compare with `disable`: disable keeps ownership and just prevents new
// transactions; release fully un-pairs.
export async function handleHemiDeviceRelease(
  req: VercelRequest,
  res: VercelResponse,
  deviceSn: string,
) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { data: device } = await supabase
    .from('merchant_devices')
    .select('id, device_sn, owner_user_id')
    .eq('device_sn', deviceSn)
    .maybeSingle();
  if (!device) return res.status(404).json({ error: 'device_not_found' });
  if (device.owner_user_id !== userId) return res.status(403).json({ error: 'not_your_device' });

  // Close any open shift on this device (pump operator handoff, etc.)
  await supabase
    .from('device_shifts')
    .update({ ended_at: new Date().toISOString(), metadata: { closed_via: 'owner_release' } })
    .eq('device_sn', deviceSn)
    .is('ended_at', null);

  // Unbind any events still pointing at this device as their gate. If we
  // skip this, events.gate_device_sn keeps a stale reference, the unique
  // index blocks the next owner from binding the same SN to their event,
  // and the gate-verify endpoint keeps treating this SN as a live gate
  // for the previous owner's event.
  await supabase
    .from('events')
    .update({ gate_device_sn: null, validation_mode: 'attendee_qr' })
    .eq('gate_device_sn', deviceSn);

  // Archive personalization — clears the merchant's audio bank entries so
  // the next owner doesn't inherit them.
  await supabase
    .from('merchant_terminal_assets')
    .update({ status: 'archived' })
    .eq('merchant_user_id', userId)
    .eq('device_sn', deviceSn)
    .neq('status', 'archived');

  // Un-claim
  const { data: updated, error: updErr } = await supabase
    .from('merchant_devices')
    .update({
      owner_user_id: null,
      claimed_at: null,
      terminal_label: null,
      profile: 'merchant',
      updated_at: new Date().toISOString(),
    })
    .eq('id', device.id)
    .select('device_sn')
    .single();

  if (updErr || !updated) {
    console.error('[HEMI] release failed:', updErr);
    return res.status(500).json({ error: 'release_failed' });
  }

  // Best-effort: paint the activation QR via BOTH apis so the device shows
  // it regardless of current screen state (idle vs payment-screen). For a
  // merchant that just disconnected, the device might be showing whatever
  // screen they were on — we want it to instantly become "Scan to activate".
  // Also try to clear the merchant's custom audio override so the next
  // owner doesn't briefly hear the previous merchant's voice. We send an
  // empty play_audio which most HEMI firmware treats as "use default".
  const claimUrl = `${FRONTEND_URL}/claim?sn=${encodeURIComponent(deviceSn)}`;
  const orderId = `claim-${Date.now()}`;
  await Promise.all([
    updateHomeScreen({
      deviceSn,
      qrText: claimUrl,
      topLabel: 'Scan with Peeap',
      bottomLabel: 'to activate',
    }).catch(err => console.warn('[HEMI release] updateHomeScreen failed:', err?.message)),
    setQrCodeData({
      deviceSn,
      amountDue: 0,
      orderId,
      qrText: claimUrl,
      amountLabel: 'Activate',
    }).catch(err => console.warn('[HEMI release] setQrCodeData failed:', err?.message)),
    // Reset audio override — best-effort. If the empty-string trick isn't
    // accepted by HEMI firmware we'll learn from logs and ask FAE for the
    // correct "restore default" packet shape.
    sendManualMessage({
      deviceSn,
      packetType: 'set_device_info',
      content: { play_audio: '' },
    }).catch(err => console.warn('[HEMI release] reset audio failed:', err?.message)),
  ]);

  // The device may currently be parked on the wait-payment screen because
  // event-bind painted it with a 24h timeout. Without an active dismiss,
  // the new home-screen paint above is invisible until the timeout
  // expires. setPaymentResult with amount=0 transitions the device back
  // to the home screen, where the claim QR we just painted becomes
  // visible.
  setPaymentResult({
    deviceSn,
    amount: 0,
    orderId: `release_${Date.now()}`,
  }).catch(err => console.warn('[HEMI release] dismiss wait-payment failed:', err?.message));

  return res.status(200).json({ ok: true });
}

// ─── Factory reset — escape hatch ───────────────────────────────────────
// One endpoint that brings ANY device's screen back into agreement with
// its DB state by routing through the central reconciler. Idempotent.
//
// Auth: any signed-in user. The action is only allowed when:
//   (a) the device has no owner (caller is recovering an orphan), OR
//   (b) the caller IS the owner.
// Both are no-op-safe: there's no destructive side-effect and the
// reconciler always paints the state implied by the DB row.
//
// This is the customer escape hatch for "device stuck showing old QR".
// Surface a button in the merchant Terminal UI. If a merchant calls
// support, support tells them to tap it — no SQL, no Abdul, no deploy.
export async function handleHemiDeviceFactoryReset(
  req: VercelRequest,
  res: VercelResponse,
  deviceSn: string,
) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { data: device } = await supabase
    .from('merchant_devices')
    .select('owner_user_id, status')
    .eq('device_sn', deviceSn)
    .maybeSingle();
  if (!device) return res.status(404).json({ error: 'device_not_found' });
  if (device.owner_user_id && device.owner_user_id !== userId) {
    return res.status(403).json({ error: 'not_your_device' });
  }

  const { reconcileDeviceScreen } = await import('../services/device-reconciler');
  const result = await reconcileDeviceScreen(deviceSn);

  return res.status(200).json({
    ok: result.painted,
    target_state: result.targetKind,
    warnings: result.warnings,
  });
}

// ─── Merchant: report device as stolen (honeypot mode) ────────────────
//
// Owner-only. Doesn't block future claims — the device stays "active"
// to anyone scanning the activation QR. What changes:
//   - merchant_devices.security_flag = 'reported_stolen'
//   - reported_stolen_at + reported_stolen_by recorded
//   - owner_user_id cleared so a re-claim flow can run
//   - logAlert fires immediately so admins know a theft is in motion
//
// The honeypot itself triggers in handleHemiClaimBySn — when a flagged
// device is claimed by a new user, that handler captures their identity,
// IP, UA, and fires a critical system_alerts row + admin notification.
// The claimer doesn't see anything different from a normal claim.
//
// Why honeypot vs hard-block: a hard block tells the holder it's stolen,
// they discard or resell to someone else, and we lose the trail. A
// honeypot recovers identity instead of just losing the asset.
export async function handleHemiDeviceReportStolen(
  req: VercelRequest,
  res: VercelResponse,
  deviceSn: string,
) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { data: device } = await supabase
    .from('merchant_devices')
    .select('id, device_sn, owner_user_id, terminal_label, security_flag')
    .eq('device_sn', deviceSn)
    .maybeSingle();
  if (!device) return res.status(404).json({ error: 'device_not_found' });
  if (device.owner_user_id !== userId) return res.status(403).json({ error: 'not_your_device' });

  // Close any open shift on the device — staff in the field have nothing
  // useful to do with a reported-stolen device.
  await supabase
    .from('device_shifts')
    .update({ ended_at: new Date().toISOString(), metadata: { closed_via: 'theft_report' } })
    .eq('device_sn', deviceSn)
    .is('ended_at', null);

  const { error } = await supabase
    .from('merchant_devices')
    .update({
      security_flag: 'reported_stolen',
      reported_stolen_at: new Date().toISOString(),
      reported_stolen_by: userId,
      // Clear ownership so a re-claim by the holder triggers the honeypot
      // capture in handleHemiClaimBySn. We deliberately keep status='active'
      // so the holder doesn't realise the device is flagged.
      owner_user_id: null,
      claimed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', device.id);
  if (error) return res.status(500).json({ error: error.message });

  // Surface to admin observability immediately. fraud / police liaison
  // monitors system_alerts for this code.
  await logAlert(
    'critical',
    'hemi_theft_report',
    'device_reported_stolen',
    `Device ${deviceSn} (${device.terminal_label || 'unlabelled'}) reported stolen by user ${userId}`,
    { device_sn: deviceSn, reported_by: userId, terminal_label: device.terminal_label },
  );

  return res.status(200).json({ ok: true });
}

// ─── Merchant: end the current shift on a device they own ──────────────
// Owner-only. Closes any open shift regardless of which staff started it
// — useful when the merchant wants to force-end a shift remotely (staff
// went home without ending, etc.). Distinct from /api/hemi/shift/end
// which only closes the caller's own shift.
//
// Why a separate action from "Disconnect": a multi-cashier site (fuel
// station, supermarket lane) has staff handovers throughout the day.
// Sign-out ends the shift; the device stays paired with the merchant
// and the next staff scans to start their own shift. No assets cleared.
export async function handleHemiDeviceEndShift(
  req: VercelRequest,
  res: VercelResponse,
  deviceSn: string,
) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { data: device } = await supabase
    .from('merchant_devices')
    .select('owner_user_id, terminal_label')
    .eq('device_sn', deviceSn)
    .maybeSingle();
  if (!device) return res.status(404).json({ error: 'device_not_found' });
  if (device.owner_user_id !== userId) return res.status(403).json({ error: 'not_your_device' });

  const { cash_collected } = (req.body || {}) as { cash_collected?: number };

  const { data: ended, error } = await supabase
    .from('device_shifts')
    .update({
      ended_at: new Date().toISOString(),
      cash_collected: typeof cash_collected === 'number' ? cash_collected : null,
      metadata: { closed_via: 'owner_force' },
    })
    .eq('device_sn', deviceSn)
    .is('ended_at', null)
    .select('id, staff_user_id, started_at, ended_at')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!ended) return res.status(404).json({ error: 'no_open_shift' });

  // Repaint idle screen with "Scan to start shift" — for multi-cashier
  // profiles this is the wake-up state for the next staff member.
  const startShiftUrl = `${FRONTEND_URL}/shift-start?sn=${encodeURIComponent(deviceSn)}`;
  updateHomeScreen({
    deviceSn,
    qrText: startShiftUrl,
    topLabel: 'Scan to start shift',
    bottomLabel: device.terminal_label?.slice(0, 20) || 'Peeap terminal',
  }).catch(() => {});

  return res.status(200).json({ ok: true, shift: ended });
}

// Bump live state in DB after a command succeeds against a device. Every
// 200 from cloud-speaker is evidence the device responded (cloud-speaker
// queues or errors when the device is offline) — so we treat it as a
// freshness signal. Realtime then pushes to all open merchant pages.
async function bumpLiveStateAfterCommand(deviceSn: string) {
  const now = new Date();
  const { data: cur } = await supabase
    .from('merchant_devices')
    .select('cloud_state')
    .eq('device_sn', deviceSn)
    .maybeSingle();
  const next = {
    ...(cur?.cloud_state as any || {}),
    networkStatus: 1,
    lastReportAt: now.getTime(),
  };
  await supabase
    .from('merchant_devices')
    .update({
      cloud_state: next,
      last_seen_at: now.toISOString(),
    })
    .eq('device_sn', deviceSn);
}

// ─── Merchant: bind a device to an event for gate-scan validation ──────
// Updates events.gate_device_sn + events.validation_mode in one shot,
// then re-paints the device with the gate QR. The merchant must own
// BOTH the device and the event. Pass event_id=null to unbind.
export async function handleHemiDeviceBindEvent(
  req: VercelRequest,
  res: VercelResponse,
  deviceSn: string,
) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { event_id } = (req.body || {}) as { event_id?: string | null };

  // Ownership check on device
  const { data: device } = await supabase
    .from('merchant_devices')
    .select('owner_user_id, terminal_label')
    .eq('device_sn', deviceSn)
    .maybeSingle();
  if (!device) return res.status(404).json({ error: 'device_not_found' });
  if (device.owner_user_id !== userId) return res.status(403).json({ error: 'not_your_device' });

  // Unbind path
  if (!event_id) {
    const { data: prevBind } = await supabase
      .from('events')
      .select('id')
      .eq('gate_device_sn', deviceSn)
      .maybeSingle();
    if (prevBind) {
      await supabase
        .from('events')
        .update({ gate_device_sn: null })
        .eq('id', prevBind.id);
    }
    // Reset to factory idle since the device no longer points at any event
    updateHomeScreen({ deviceSn, qrText: '', topLabel: '', bottomLabel: '' }).catch(() => {});
    return res.status(200).json({ ok: true, bound_event_id: null });
  }

  // Bind path: load event and confirm ownership via merchant_id (which is
  // the user_id in our schema for self-served merchants).
  const { data: event } = await supabase
    .from('events')
    .select('id, title, merchant_id, gate_device_sn')
    .eq('id', event_id)
    .maybeSingle();
  if (!event) return res.status(404).json({ error: 'event_not_found' });
  if (event.merchant_id !== userId) return res.status(403).json({ error: 'not_your_event' });

  // Release any previous device this event was bound to (and any previous
  // event THIS device was bound to) so the unique index is happy.
  await supabase
    .from('events')
    .update({ gate_device_sn: null })
    .eq('gate_device_sn', deviceSn)
    .neq('id', event_id);

  const { data: updated, error: updErr } = await supabase
    .from('events')
    .update({
      validation_mode: 'device_scan',
      gate_device_sn: deviceSn,
    })
    .eq('id', event_id)
    .select('id, title, gate_device_sn, validation_mode')
    .single();

  if (updErr || !updated) {
    return res.status(500).json({ error: updErr?.message || 'bind_failed' });
  }

  // Auto-paint the gate QR on BOTH the idle home AND the wait-payment
  // screen with a 24-hour timeout. The idle home has no expiry, but
  // the wait-payment screen has a max — we set it to 24h so a stray
  // keypad press during the event doesn't show a stale URL or
  // expire mid-event. (If the event runs longer than 24h, a single
  // additional bind-event call refreshes both screens.)
  const gateUrl = `${FRONTEND_URL}/g?event=${encodeURIComponent(updated.id)}&device=${encodeURIComponent(deviceSn)}`;
  const orderId = `gate_${Date.now()}`;
  await Promise.all([
    updateHomeScreen({
      deviceSn,
      qrText: gateUrl,
      topLabel: updated.title.slice(0, 20),
      bottomLabel: 'Show pass to scan',
    }).catch(err => console.warn('[HEMI] bind-event home paint failed:', err?.message)),
    setQrCodeData({
      deviceSn,
      amountDue: 0,
      orderId,
      qrText: gateUrl,
      amountLabel: updated.title.slice(0, 20),
      timeOutSec: 86400,  // 24h — gates don't take payments
    }).catch(err => console.warn('[HEMI] bind-event payment paint failed:', err?.message)),
  ]);

  return res.status(200).json({ ok: true, event: updated });
}

// ─── Merchant: list events ownerable by current user (for bind picker) ──
export async function handleHemiMyEvents(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { data, error } = await supabase
    .from('events')
    .select('id, title, status, validation_mode, gate_device_sn, start_date, end_date')
    .eq('merchant_id', userId)
    .order('start_date', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ events: data || [] });
}

// ─── Cron: silent fleet ping ─────────────────────────────────────────────
// Called by .github/workflows/hemi-keepalive.yml every 5 min (GitHub
// Actions minimum). One cloud-speaker /paging_devices request returns
// state for all devices on our peeappay account; we bulk-write the
// fresh cloud_state into merchant_devices, and Supabase Realtime pushes
// the change to every open merchant page within ~100 ms.
//
// Auth: Bearer CRON_SECRET — same gate as the other /api/cron/* endpoints.
//
// Why we don't poke each device individually: cloud-speaker already
// holds the freshest device state on its side. Pulling once per fleet
// is one HTTP call regardless of device count. Sending a command to
// each device would be N calls per minute and could trigger unwanted
// audio / screen side effects.
export async function handleCronHemiPing(req: VercelRequest, res: VercelResponse) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const start = Date.now();
  const list = await cloudSpeakerListDevices();
  if (!list.ok || !list.devices) {
    return res.status(502).json({ error: list.error || 'cloud_speaker_unreachable' });
  }

  // Pull current rows so we can preserve fields cloud-speaker doesn't return.
  const { data: existing } = await supabase
    .from('merchant_devices')
    .select('id, device_sn, cloud_state, status, owner_user_id, claimed_at');
  const existingBySn = new Map((existing || []).map(r => [r.device_sn, r]));

  const nowIso = new Date().toISOString();
  const updates: Array<{ device_sn: string; payload: Record<string, any> }> = [];

  for (const csRow of list.devices as any[]) {
    const sn = csRow.deviceNumber;
    if (!sn) continue;
    const cur = existingBySn.get(sn);
    if (!cur) continue; // not in our DB — leave for /api/hemi/sync to import

    const isWifi = (csRow.network_mode || '').toUpperCase() === 'WIFI';
    const cloudState = {
      ...((cur.cloud_state as any) || {}),
      deviceModel: csRow.deviceModel,
      networkStatus: csRow.networkStatus,
      networkMode: csRow.network_mode,
      wifiName: csRow.wifi_name,
      wifiSignal: csRow.wifi_signal,
      cellSignal: csRow.signal_value,
      signalValue: isWifi ? (csRow.wifi_signal || csRow.signal_value) : csRow.signal_value,
      batteryPercent: csRow.battery_percent,
      batteryVoltage: csRow.battery_voltage,
      lastReportAt: csRow.lastReportDataTime,
      ip: csRow.ip,
    };

    updates.push({
      device_sn: sn,
      payload: {
        cloud_state: cloudState,
        last_synced_at: nowIso,
        last_seen_at: csRow.lastReportDataTime
          ? new Date(csRow.lastReportDataTime).toISOString()
          : null,
      },
    });
  }

  // Fan-out the updates. Supabase doesn't have a multi-row upsert that
  // updates only the specific fields we care about, so per-row updates
  // it is. Realtime fires once per row.
  const writeStart = Date.now();
  await Promise.all(updates.map(u =>
    supabase.from('merchant_devices').update(u.payload).eq('device_sn', u.device_sn).then(() => {}),
  ));

  // Self-heal: bring every online device's screen into agreement with
  // its DB state. The reconciler is the only place that decides what
  // each device should be showing; calling it here means any drift —
  // failed paint, manual SQL change, missed handler call, network
  // blip — corrects itself within one cron tick (~5 min worst case).
  //
  // Fires in the background so the cron response time stays bounded
  // by the cloud-speaker fleet pull, not by N per-device paints.
  void (async () => {
    try {
      const { reconcileAllOnlineDevices } = await import('../services/device-reconciler');
      const r = await reconcileAllOnlineDevices();
      console.log(`[HEMI cron] reconciled=${r.reconciled}/${r.total} warnings=${r.warnings}`);
    } catch (err: any) {
      console.warn('[HEMI cron] reconcile failed:', err?.message);
    }
  })();

  return res.status(200).json({
    ok: true,
    devices_seen: list.devices.length,
    rows_updated: updates.length,
    reconcile_kicked_off: true,
    cloud_speaker_ms: Date.now() - start - (Date.now() - writeStart),
    db_write_ms: Date.now() - writeStart,
    total_ms: Date.now() - start,
  });
}

// ─── Merchant: per-device test actions ──────────────────────────────────
// Lets the device owner self-test from Terminal Settings without going
// through the admin Send Command panel. Six owner-only actions:
//   - test-sound: plays "received Le 1.00" via setPaymentResult
//   - test-qr: pushes a "Hello Peeap" QR to the payment screen for 30 s
//   - reset-screen: repaints idle home with the merchant's claim QR (used
//     when the device is in a stuck "waiting for payment" state)
//   - play-audio: swaps post-payment audio to a custom uploaded clip
//   - refresh: forces a cloud-speaker re-fetch + DB update for THIS device
//   - ping: silent reachability check — pulls device state from cloud-speaker
//     filtered to this SN and bumps last_seen_at on success
//
// Every successful command also bumps last_seen_at + networkStatus=1 so
// the merchant page's Realtime subscription reflects "device responded
// just now" without a separate polling cycle.
//
// We expose these as POST /api/hemi/devices/:sn/<action>.
export async function handleHemiDeviceAction(
  req: VercelRequest,
  res: VercelResponse,
  deviceSn: string,
  action: 'test-sound' | 'test-qr' | 'reset-screen' | 'play-audio' | 'refresh' | 'ping',
) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  // Owner-only — fail fast before any HEMI call.
  const { data: device } = await supabase
    .from('merchant_devices')
    .select('id, device_sn, owner_user_id, status, terminal_label')
    .eq('device_sn', deviceSn)
    .maybeSingle();
  if (!device) return res.status(404).json({ error: 'device_not_found' });
  if (device.owner_user_id !== userId) return res.status(403).json({ error: 'not_your_device' });
  if (device.status !== 'active' && action !== 'refresh') {
    return res.status(403).json({ error: 'device_disabled' });
  }

  const orderId = `merchant_${Date.now()}`;

  if (action === 'test-sound') {
    const r = await setPaymentResult({ deviceSn, amount: 1, orderId });
    if (!r.ok) return res.status(502).json({ error: r.error });
    await bumpLiveStateAfterCommand(deviceSn);
    return res.status(200).json({ ok: true });
  }

  if (action === 'test-qr') {
    const r = await setQrCodeData({
      deviceSn,
      amountDue: 0,
      orderId,
      qrText: `${FRONTEND_URL}/`,
      amountLabel: 'Test',
    });
    if (!r.ok) return res.status(502).json({ error: r.error });
    await bumpLiveStateAfterCommand(deviceSn);
    return res.status(200).json({ ok: true });
  }

  if (action === 'reset-screen') {
    // Repaint idle screen — for a claimed device, show a "Scan to pay <merchant>" QR.
    const { data: owner } = await supabase
      .from('users')
      .select('first_name, last_name, username')
      .eq('id', userId)
      .single();
    const ownerName = owner
      ? `${owner.first_name || ''} ${owner.last_name || ''}`.trim() || owner.username || 'Merchant'
      : 'Merchant';
    const r = await updateHomeScreen({
      deviceSn,
      qrText: `${FRONTEND_URL}/`,
      topLabel: ownerName.slice(0, 20),
      bottomLabel: device.terminal_label
        ? device.terminal_label.slice(0, 20)
        : 'Type amount + #',
    });
    if (!r.ok) return res.status(502).json({ error: r.error });
    await bumpLiveStateAfterCommand(deviceSn);
    return res.status(200).json({ ok: true });
  }

  if (action === 'play-audio') {
    const { filename } = (req.body || {}) as { filename?: string };
    if (!filename) return res.status(400).json({ error: 'filename_required' });
    // Approval gate: only clips the merchant has uploaded AND admin has
    // approved can be activated. Prevents bypass of the review queue
    // (e.g. "payment failed" audio after a successful payment).
    const { data: asset } = await supabase
      .from('merchant_terminal_assets')
      .select('id, status, merchant_user_id')
      .eq('cloud_speaker_filename', filename)
      .eq('merchant_user_id', userId)
      .maybeSingle();
    if (!asset) {
      return res.status(403).json({ error: 'audio_not_in_merchant_library' });
    }
    if (asset.status !== 'approved') {
      return res.status(403).json({ error: 'audio_not_approved', status: asset.status });
    }
    const r = await sendManualMessage({
      deviceSn,
      packetType: 'set_device_info',
      content: { play_audio: String(filename) },
    });
    if (!r.ok) return res.status(502).json({ error: r.error });
    await bumpLiveStateAfterCommand(deviceSn);
    return res.status(200).json({ ok: true });
  }

  if (action === 'ping') {
    // Silent reachability probe. Pull cloud-speaker (cached 30 s) filtered
    // to this device and trust the resulting networkStatus + lastReportAt.
    // No device-side side effects — won't beep, won't repaint the screen,
    // safe to fire on a fast cadence from the page.
    const list = await cloudSpeakerListDevices();
    if (!list.ok || !list.devices) {
      return res.status(502).json({ error: list.error || 'cloud_speaker_unreachable' });
    }
    const csRow = list.devices.find((d: any) => d.deviceNumber === deviceSn);
    if (!csRow) {
      return res.status(404).json({ error: 'device_not_on_cloud_speaker' });
    }
    // Apply the same overlay logic as ?live=1 so signal/network/battery
    // get refreshed alongside last_seen.
    const isWifi = (csRow.network_mode || '').toUpperCase() === 'WIFI';
    const { data: cur } = await supabase
      .from('merchant_devices')
      .select('cloud_state')
      .eq('device_sn', deviceSn)
      .maybeSingle();
    const cloudState = {
      ...(cur?.cloud_state as any || {}),
      deviceModel: csRow.deviceModel,
      networkStatus: csRow.networkStatus,
      networkMode: csRow.network_mode,
      wifiName: csRow.wifi_name,
      wifiSignal: csRow.wifi_signal,
      cellSignal: csRow.signal_value,
      signalValue: isWifi ? (csRow.wifi_signal || csRow.signal_value) : csRow.signal_value,
      batteryPercent: csRow.battery_percent,
      batteryVoltage: csRow.battery_voltage,
      lastReportAt: csRow.lastReportDataTime,
      ip: csRow.ip,
    };
    await supabase
      .from('merchant_devices')
      .update({
        cloud_state: cloudState,
        last_synced_at: new Date().toISOString(),
        last_seen_at: csRow.lastReportDataTime
          ? new Date(csRow.lastReportDataTime).toISOString()
          : new Date().toISOString(),
      })
      .eq('device_sn', deviceSn);
    return res.status(200).json({
      ok: true,
      online: csRow.networkStatus === 1,
      cloud_state: cloudState,
    });
  }

  if (action === 'refresh') {
    // Force a single-device cloud-speaker refresh, write fresh cloud_state to DB.
    const list = await cloudSpeakerListDevices();
    if (!list.ok || !list.devices) {
      return res.status(502).json({ error: list.error || 'cloud_speaker_unreachable' });
    }
    const csRow = list.devices.find((d: any) => d.deviceNumber === deviceSn);
    if (!csRow) {
      return res.status(404).json({ error: 'device_not_on_cloud_speaker' });
    }
    const isWifi = (csRow.network_mode || '').toUpperCase() === 'WIFI';
    const cloudState = {
      deviceModel: csRow.deviceModel,
      networkStatus: csRow.networkStatus,
      networkMode: csRow.network_mode,
      wifiName: csRow.wifi_name,
      wifiSignal: csRow.wifi_signal,
      cellSignal: csRow.signal_value,
      signalValue: isWifi ? (csRow.wifi_signal || csRow.signal_value) : csRow.signal_value,
      batteryPercent: csRow.battery_percent,
      batteryVoltage: csRow.battery_voltage,
      language: csRow.language,
      firmware: {
        fourG: csRow.fourG_fw_version,
        wifi: csRow.wifi_fw_version,
        audio: csRow.audio_version,
        hardware: csRow.hardware_version,
        protocol: csRow.protocol_version,
      },
      storageRemainBytes: csRow.file_storage_remain_size,
      lastReportAt: csRow.lastReportDataTime,
      activeAt: csRow.activeTime,
      ip: csRow.ip,
      cloudId: csRow.id,
      ownerName: csRow.ownerName,
    };
    await supabase
      .from('merchant_devices')
      .update({
        cloud_state: cloudState,
        last_synced_at: new Date().toISOString(),
        last_seen_at: csRow.lastReportDataTime ? new Date(csRow.lastReportDataTime).toISOString() : null,
      })
      .eq('device_sn', deviceSn);
    return res.status(200).json({ ok: true, cloud_state: cloudState });
  }

  return res.status(400).json({ error: 'unknown_action' });
}

// ─── Merchant: update device profile / terminal label ───────────────────
// PATCH /api/hemi/devices/:sn — owner only. Profile changes the device's
// operating mode (merchant-payment / event_gate / fuel / etc.) and is the
// hook the merchant Settings UI uses for "service toggles". Terminal label
// is a free-text identifier for multi-device fleets ("Lane 3", "Pump 2").
export async function handleHemiDeviceUpdate(
  req: VercelRequest,
  res: VercelResponse,
  deviceSn: string,
) {
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  if (!deviceSn) return res.status(400).json({ error: 'device_sn_required' });

  const { profile, terminal_label, status } = (req.body || {}) as {
    profile?: string;
    terminal_label?: string | null;
    status?: string;
  };

  // Verify ownership before any update
  const { data: existing } = await supabase
    .from('merchant_devices')
    .select('owner_user_id, status, profile')
    .eq('device_sn', deviceSn)
    .maybeSingle();

  if (!existing) return res.status(404).json({ error: 'device_not_found' });
  if (existing.owner_user_id !== userId) return res.status(403).json({ error: 'not_your_device' });

  // Whitelist the profile values so a hostile payload can't write garbage.
  const allowedProfiles = ['merchant', 'transport', 'pos', 'fuel', 'supermarket', 'event_gate'];
  if (profile !== undefined && !allowedProfiles.includes(profile)) {
    return res.status(400).json({ error: 'invalid_profile' });
  }
  // Status: only allow merchant to disable/re-enable their own device. Lost
  // is a special state set elsewhere (anti-fraud) — block here.
  const allowedStatusForOwner = ['active', 'disabled'];
  if (status !== undefined && !allowedStatusForOwner.includes(status)) {
    return res.status(400).json({ error: 'invalid_status' });
  }

  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  if (profile !== undefined) updates.profile = profile;
  if (terminal_label !== undefined) updates.terminal_label = terminal_label || null;
  if (status !== undefined) updates.status = status;

  const { data: updated, error: updErr } = await supabase
    .from('merchant_devices')
    .update(updates)
    .eq('device_sn', deviceSn)
    .eq('owner_user_id', userId)
    .select('id, device_sn, model, profile, terminal_label, status, last_seen_at, last_synced_at, cloud_state, created_at')
    .single();

  if (updErr || !updated) {
    console.error('[HEMI] device update error:', updErr);
    return res.status(500).json({ error: updErr?.message || 'update_failed' });
  }

  // Profile change side-effect: paint the device's idle screen so the
  // mode switch is visible immediately, not on the next reboot.
  // - event_gate → static gate QR encoding /g?event=<evt>&device=<sn>
  //                pulled from the merchant's currently-active event
  //                (validation_mode='device_scan' AND gate_device_sn=this).
  //                If no event is bound yet, paint a "Pending event setup"
  //                fallback so the merchant knows the device is ready
  //                but waiting for an event.
  // - any other  → restore factory default (empty payload).
  if (profile !== undefined && profile !== existing.profile) {
    if (profile === 'event_gate') {
      const { data: boundEvent } = await supabase
        .from('events')
        .select('id, title')
        .eq('gate_device_sn', deviceSn)
        .eq('validation_mode', 'device_scan')
        .maybeSingle();
      if (boundEvent) {
        const gateUrl = `${FRONTEND_URL}/g?event=${encodeURIComponent(boundEvent.id)}&device=${encodeURIComponent(deviceSn)}`;
        updateHomeScreen({
          deviceSn,
          qrText: gateUrl,
          topLabel: boundEvent.title.slice(0, 20),
          bottomLabel: 'Show pass to scan',
        }).catch(err => console.warn('[HEMI] gate paint failed:', err?.message));
      } else {
        updateHomeScreen({
          deviceSn,
          qrText: `${FRONTEND_URL}/`,
          topLabel: 'Event gate',
          bottomLabel: 'Bind an event in Peeap',
        }).catch(() => {});
      }
    } else {
      // Anything other than event_gate → restore factory.
      updateHomeScreen({
        deviceSn,
        qrText: '',
        topLabel: '',
        bottomLabel: '',
      }).catch(() => {});

      // Leaving event_gate: the wait-payment screen was painted with a
      // 24h timeout when the event was bound, so the device is parked
      // there showing the gate QR. The factory home paint above is
      // invisible until that screen dismisses. setPaymentResult forces
      // the wait-payment screen to clear and the device returns to
      // home, where the factory image now shows.
      if (existing.profile === 'event_gate') {
        setPaymentResult({
          deviceSn,
          amount: 0,
          orderId: `mode_change_${Date.now()}`,
        }).catch(err => console.warn('[HEMI] dismiss event-gate screen failed:', err?.message));

        // Drop any event still pointing at this device as its gate.
        // The unique index on events.gate_device_sn would otherwise
        // block the next bind, and gate-verify would keep accepting
        // scans for an event the merchant has clearly moved on from.
        await supabase
          .from('events')
          .update({ gate_device_sn: null, validation_mode: 'attendee_qr' })
          .eq('gate_device_sn', deviceSn);
      }
    }
  }

  return res.status(200).json({ device: updated });
}

// ─── Shift: open ─────────────────────────────────────────────────────────
export async function handleHemiShiftStart(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { device_sn, opened_via } = (req.body || {}) as {
    device_sn?: string;
    opened_via?: string;
  };
  if (!device_sn) return res.status(400).json({ error: 'device_sn_required' });

  // Device must exist + be active (any owner — staff don't have to belong
  // to the owner table; the unique-open-shift constraint covers handoff).
  const { data: device } = await supabase
    .from('merchant_devices')
    .select('device_sn, status')
    .eq('device_sn', device_sn)
    .single();

  if (!device || device.status !== 'active') {
    return res.status(404).json({ error: 'device_not_found' });
  }

  // Auto-close any prior open shift on this device.
  await supabase
    .from('device_shifts')
    .update({ ended_at: new Date().toISOString(), metadata: { closed_via: 'auto_handoff' } })
    .eq('device_sn', device_sn)
    .is('ended_at', null);

  const { data: shift, error } = await supabase
    .from('device_shifts')
    .insert({
      device_sn,
      staff_user_id: userId,
      opened_via: opened_via || 'app',
    })
    .select('id, started_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ shift });
}

// ─── Shift: close ────────────────────────────────────────────────────────
export async function handleHemiShiftEnd(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { device_sn, cash_collected } = (req.body || {}) as {
    device_sn?: string;
    cash_collected?: number;
  };
  if (!device_sn) return res.status(400).json({ error: 'device_sn_required' });

  const { data, error } = await supabase
    .from('device_shifts')
    .update({
      ended_at: new Date().toISOString(),
      cash_collected: typeof cash_collected === 'number' ? cash_collected : null,
    })
    .eq('device_sn', device_sn)
    .eq('staff_user_id', userId)
    .is('ended_at', null)
    .select('id, started_at, ended_at')
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'no_open_shift_for_user' });
  }
  return res.status(200).json({ shift: data });
}

// ─── Bulk pre-provision: admin creates N unclaimed devices ───────────────
// Used to manufacture a batch. Body: { devices: [{ device_sn, model? }] }.
// Returns the same array decorated with device_secret + claim_url for each
// row, so you can hand the CSV to FAE for flashing.
export async function handleHemiBulkProvision(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  // Admin-only — gate by role check on users.roles (text[] column).
  const { data: u } = await supabase.from('users').select('roles').eq('id', userId).single();
  const roles = (u?.roles as string[]) || [];
  if (!roles.includes('admin') && !roles.includes('superadmin')) {
    return res.status(403).json({ error: 'admin_only' });
  }

  const { devices } = (req.body || {}) as { devices?: Array<{ device_sn: string; model?: string }> };
  if (!Array.isArray(devices) || devices.length === 0 || devices.length > 500) {
    return res.status(400).json({ error: 'devices_array_required (max 500)' });
  }

  const rows = devices.map(d => ({
    device_sn: d.device_sn,
    device_secret: randomBytes(24).toString('base64url'),
    owner_user_id: null,
    model: d.model || 'y68',
    profile: 'merchant',
    status: 'active',
  }));

  const { data, error } = await supabase
    .from('merchant_devices')
    .insert(rows)
    .select('device_sn, device_secret');

  if (error) return res.status(500).json({ error: error.message });

  const enriched = (data || []).map(d => ({
    device_sn: d.device_sn,
    claim_url: `${FRONTEND_URL}/claim/${d.device_secret}`,
    payment_request_url: `${process.env.PUBLIC_API_URL || 'https://api.peeap.com'}/api/hemi/in/${d.device_secret}`,
  }));

  return res.status(201).json({
    count: enriched.length,
    devices: enriched,
    csv: enriched.map(d => `${d.device_sn},${d.claim_url},${d.payment_request_url}`).join('\n'),
  });
}

// ─── Claim: GET → device info, POST → take ownership ────────────────────
// URL: /api/hemi/claim/<device_secret>
// GET requires auth — returns the device's basic info so the app can show
// a confirmation prompt ("Activate this Y68 for [Merchant Name]?").
// POST requires auth — assigns ownership to the caller, sets claimed_at,
// and pushes a merchant-branded idle screen.
export async function handleHemiDeviceClaim(
  req: VercelRequest,
  res: VercelResponse,
  deviceSecret: string,
) {
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  if (!deviceSecret || deviceSecret.length < 16) {
    return res.status(404).json({ error: 'not_found' });
  }

  const { data: device, error: devErr } = await supabase
    .from('merchant_devices')
    .select('id, device_sn, model, profile, terminal_label, status, claimed_at, owner_user_id')
    .eq('device_secret', deviceSecret)
    .maybeSingle();

  if (devErr || !device) {
    return res.status(404).json({ error: 'device_not_found' });
  }
  if (device.status !== 'active') {
    return res.status(403).json({ error: 'device_disabled' });
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      device: {
        sn: device.device_sn,
        model: device.model,
        profile: device.profile,
        already_claimed: !!device.claimed_at,
        is_yours: device.owner_user_id === userId,
      },
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // POST — claim. Reject if already claimed by someone else; idempotent if
  // the same caller is re-claiming.
  if (device.claimed_at && device.owner_user_id && device.owner_user_id !== userId) {
    return res.status(409).json({ error: 'device_already_claimed' });
  }

  const { profile, terminal_label } = (req.body || {}) as {
    profile?: string;
    terminal_label?: string;
  };

  const { data: claimed, error: updErr } = await supabase
    .from('merchant_devices')
    .update({
      owner_user_id: userId,
      claimed_at: new Date().toISOString(),
      ...(profile && { profile }),
      ...(terminal_label !== undefined && { terminal_label }),
      updated_at: new Date().toISOString(),
    })
    .eq('id', device.id)
    .select('id, device_sn, profile, terminal_label, claimed_at')
    .single();

  if (updErr || !claimed) {
    console.error('[HEMI] claim update failed:', updErr);
    return res.status(500).json({ error: 'claim_failed' });
  }

  // Best-effort: paint the merchant's branded idle screen so the next
  // walk-up customer knows who they're paying.
  const { data: owner } = await supabase
    .from('users')
    .select('first_name, last_name, username')
    .eq('id', userId)
    .single();
  const ownerName = owner
    ? `${owner.first_name || ''} ${owner.last_name || ''}`.trim() || owner.username || 'Merchant'
    : 'Merchant';
  pushMerchantHomeScreen(device.device_sn, ownerName, userId).catch(() => {});

  return res.status(200).json({ device: claimed });
}

// ─── Claim by SN — for devices that show their own SN-based QR ──────────
// URL: /api/hemi/claim-by-sn (GET ?sn=  → info ; POST  → claim)
//
// Trust model: only SNs we've already imported into merchant_devices can be
// claimed. The pool is fed by /api/hemi/sync which only pulls from our own
// HEMI account. So a stranger guessing an SN can only claim devices we
// physically own — and at most steal the bond on a single device once,
// which the rightful owner can revoke from the admin dashboard.
export async function handleHemiClaimBySn(req: VercelRequest, res: VercelResponse) {
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const url = new URL(req.url || '', `https://${req.headers.host}`);
  const snFromQuery = url.searchParams.get('sn');
  const snFromBody = (req.body || {}).device_sn;
  const sn = (snFromQuery || snFromBody || '').trim();

  if (!sn || sn.length < 4) {
    return res.status(400).json({ error: 'device_sn_required' });
  }

  const { data: device, error: devErr } = await supabase
    .from('merchant_devices')
    .select('id, device_sn, model, profile, terminal_label, status, claimed_at, owner_user_id, security_flag, reported_stolen_by')
    .eq('device_sn', sn)
    .maybeSingle();

  if (devErr || !device) {
    return res.status(404).json({ error: 'device_not_in_inventory' });
  }
  if (device.status !== 'active') {
    return res.status(403).json({ error: 'device_disabled' });
  }
  // 'fraud_hold' is a hard block (admin-set). 'reported_stolen' is a
  // honeypot — claim proceeds normally; we capture identity below.
  if (device.security_flag === 'fraud_hold') {
    return res.status(403).json({ error: 'device_disabled' });
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      device: {
        sn: device.device_sn,
        model: device.model,
        profile: device.profile,
        already_claimed: !!device.claimed_at,
        is_yours: device.owner_user_id === userId,
      },
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (device.claimed_at && device.owner_user_id && device.owner_user_id !== userId) {
    return res.status(409).json({ error: 'device_already_claimed' });
  }

  const { profile, terminal_label } = (req.body || {}) as {
    profile?: string;
    terminal_label?: string;
  };

  const { data: claimed, error: updErr } = await supabase
    .from('merchant_devices')
    .update({
      owner_user_id: userId,
      claimed_at: new Date().toISOString(),
      ...(profile && { profile }),
      ...(terminal_label !== undefined && { terminal_label }),
      updated_at: new Date().toISOString(),
    })
    .eq('id', device.id)
    .select('id, device_sn, profile, terminal_label, claimed_at')
    .single();

  if (updErr || !claimed) {
    console.error('[HEMI] claim-by-sn update failed:', updErr);
    return res.status(500).json({ error: 'claim_failed' });
  }

  // Best-effort: paint merchant-branded idle screen now that it's theirs.
  const { data: owner } = await supabase
    .from('users')
    .select('first_name, last_name, username')
    .eq('id', userId)
    .single();
  const ownerName = owner
    ? `${owner.first_name || ''} ${owner.last_name || ''}`.trim() || owner.username || 'Merchant'
    : 'Merchant';
  pushMerchantHomeScreen(device.device_sn, ownerName, userId).catch(() => {});

  // If the device was previously in event_gate mode, the wait-payment
  // screen was painted with a 24h timeout (see handleHemiDeviceBindEvent).
  // The home-screen paint above is invisible while wait-payment is up,
  // so a re-claim of a previously-event-gate device would visually do
  // nothing for up to 24h. setPaymentResult dismisses wait-payment and
  // the device falls back to the freshly-painted home image.
  setPaymentResult({
    deviceSn: device.device_sn,
    amount: 0,
    orderId: `claim_${Date.now()}`,
  }).catch(err => console.warn('[HEMI claim] dismiss wait-payment failed:', err?.message));

  // ── Theft honeypot ────────────────────────────────────────────────
  // If the device was reported stolen, the claim above looked normal
  // to the holder. We log everything we have on them out-of-band: full
  // user record, IP, UA, plus a notification to the original reporter.
  // The fraud team (or police, via fraud team) gets a critical alert.
  // We do NOT tell the claimer anything is amiss — the whole point.
  if (device.security_flag === 'reported_stolen') {
    const claimerIp = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      || (req.headers['x-real-ip'] as string | undefined)
      || 'unknown';
    const claimerUa = (req.headers['user-agent'] as string | undefined) || 'unknown';
    const { data: claimer } = await supabase
      .from('users')
      .select('id, first_name, last_name, phone, email, kyc_status, kyc_tier, created_at')
      .eq('id', userId)
      .single();
    void logAlert(
      'critical',
      'hemi_theft_honeypot',
      'stolen_device_claimed',
      `Stolen device ${device.device_sn} was claimed — capture identity for investigation`,
      {
        device_sn: device.device_sn,
        claimer_user_id: userId,
        claimer_phone: claimer?.phone,
        claimer_name: claimer ? `${claimer.first_name || ''} ${claimer.last_name || ''}`.trim() : null,
        claimer_email: claimer?.email,
        claimer_kyc: { status: claimer?.kyc_status, tier: claimer?.kyc_tier },
        claimer_account_age_days: claimer?.created_at
          ? Math.floor((Date.now() - new Date(claimer.created_at).getTime()) / 86400000)
          : null,
        claimer_ip: claimerIp,
        claimer_user_agent: claimerUa,
        original_owner_user_id: device.reported_stolen_by,
      },
    );
    // Notify the original owner that their stolen device just resurfaced.
    if (device.reported_stolen_by) {
      void supabase.from('notifications').insert({
        user_id: device.reported_stolen_by,
        type: 'theft_honeypot_triggered',
        title: 'Your reported device was just claimed',
        message: `Device ${device.device_sn} was claimed by another user. Our team is investigating — do not contact the claimer or the police directly. We will update you.`,
        data: { device_sn: device.device_sn },
      });
    }
  }

  return res.status(200).json({ device: claimed });
}

// ─── Admin: push the "Scan to activate" QR to a specific device ──────────
// Useful for devices already in inventory but never sent a screen update.
// Caller is admin; body { device_sn }.
export async function handleHemiPushClaimScreen(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { data: u } = await supabase.from('users').select('roles').eq('id', userId).single();
  const roles = (u?.roles as string[]) || [];
  if (!roles.includes('admin') && !roles.includes('superadmin')) {
    return res.status(403).json({ error: 'admin_only' });
  }

  const { device_sn } = (req.body || {}) as { device_sn?: string };
  if (!device_sn) return res.status(400).json({ error: 'device_sn_required' });

  const { data: device } = await supabase
    .from('merchant_devices')
    .select('device_sn, claimed_at')
    .eq('device_sn', device_sn)
    .maybeSingle();
  if (!device) return res.status(404).json({ error: 'device_not_found' });

  await pushClaimScreen(device.device_sn);
  return res.status(200).json({ ok: true });
}

// ─── Admin: list every device in our DB (with owner details) ────────────
export async function handleHemiAdminDeviceList(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { data: u } = await supabase.from('users').select('roles').eq('id', userId).single();
  const roles = (u?.roles as string[]) || [];
  if (!roles.includes('admin') && !roles.includes('superadmin')) {
    return res.status(403).json({ error: 'admin_only' });
  }

  const { data: devices, error } = await supabase
    .from('merchant_devices')
    .select(`
      id, device_sn, device_secret, model, profile, terminal_label,
      status, owner_user_id, claimed_at, last_seen_at, last_synced_at,
      cloud_state, created_at,
      owner:users!merchant_devices_owner_user_id_fkey ( email, first_name, last_name )
    `)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[HEMI] admin device list error:', error);
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ devices: devices || [] });
}

// In-memory cache for the live merged view. Cloud-speaker + DB fan-out is
// ~500-800 ms; navigating between Overview / Device Manager / Audio
// re-fetches every time, which feels sluggish on slow links. Cache for
// 30 s — short enough that a power-cycle on a device shows up within
// half a minute, long enough that quick tab-switching is instant.
const LIVE_CACHE_TTL_MS = 30_000;
let liveCache: { at: number; payload: any } | null = null;

// ─── Admin: live merged view of cloud-speaker + our DB ──────────────────
export async function handleHemiAdminLiveDevices(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { data: u } = await supabase.from('users').select('roles').eq('id', userId).single();
  const roles = (u?.roles as string[]) || [];
  if (!roles.includes('admin') && !roles.includes('superadmin')) {
    return res.status(403).json({ error: 'admin_only' });
  }

  // Honor cache unless caller asks for fresh (refresh button / sync flow).
  const url = new URL(req.url || '', `https://${req.headers.host}`);
  const skipCache = url.searchParams.get('fresh') === '1';
  if (!skipCache && liveCache && Date.now() - liveCache.at < LIVE_CACHE_TTL_MS) {
    return res.status(200).json({ ...liveCache.payload, cached_at: liveCache.at });
  }

  // Fan out both reads in parallel — cloud-speaker is the slow leg (~500ms),
  // our DB is fast.
  const [csList, dbResult] = await Promise.all([
    cloudSpeakerListDevices(),
    supabase
      .from('merchant_devices')
      .select(`
        id, device_sn, device_secret, model, profile, terminal_label,
        status, owner_user_id, claimed_at, last_seen_at, created_at,
        owner:users!merchant_devices_owner_user_id_fkey ( email, first_name, last_name )
      `),
  ]);

  if (dbResult.error) {
    console.error('[HEMI] live admin DB error:', dbResult.error);
    return res.status(500).json({ error: dbResult.error.message });
  }

  const dbBySn = new Map((dbResult.data || []).map((d: any) => [d.device_sn, d]));
  const csBySn = new Map<string, any>();
  if (csList.ok && csList.devices) {
    for (const d of csList.devices) {
      if (d.deviceNumber) csBySn.set(d.deviceNumber, d);
    }
  }

  const allSns = new Set<string>([...dbBySn.keys(), ...csBySn.keys()]);
  const merged = Array.from(allSns).map(sn => {
    const dbRow: any = dbBySn.get(sn) || null;
    const csRow: any = csBySn.get(sn) || null;
    return {
      device_sn: sn,
      // Where does this device exist?
      in_db: !!dbRow,
      in_cloud: !!csRow,
      // DB-side fields (may be null if device is on cloud-speaker but not yet imported)
      id: dbRow?.id || null,
      device_secret: dbRow?.device_secret || null,
      model: dbRow?.model || (csRow?.deviceModel ? (String(csRow.deviceModel).toLowerCase().startsWith('y68') ? 'y68' : 'soundbox') : null),
      profile: dbRow?.profile || null,
      terminal_label: dbRow?.terminal_label || null,
      status: dbRow?.status || null,
      owner_user_id: dbRow?.owner_user_id || null,
      claimed_at: dbRow?.claimed_at || null,
      created_at: dbRow?.created_at || null,
      owner: dbRow?.owner || null,
      // Cloud-speaker live state — shape mirrors what /sync writes to cloud_state
      cloud_state: csRow ? {
        deviceModel: csRow.deviceModel,
        networkStatus: csRow.networkStatus,
        networkMode: csRow.network_mode,
        wifiName: csRow.wifi_name,
        signalValue: csRow.signal_value,
        batteryPercent: csRow.battery_percent,
        batteryVoltage: csRow.battery_voltage,
        language: csRow.language,
        firmware: {
          fourG: csRow.fourG_fw_version,
          wifi: csRow.wifi_fw_version,
          audio: csRow.audio_version,
          hardware: csRow.hardware_version,
          protocol: csRow.protocol_version,
        },
        storageRemainBytes: csRow.file_storage_remain_size,
        lastReportAt: csRow.lastReportDataTime,
        activeAt: csRow.activeTime,
        ip: csRow.ip,
        cloudId: csRow.id,
        ownerName: csRow.ownerName,
      } : null,
      last_seen_at: csRow?.lastReportDataTime
        ? new Date(csRow.lastReportDataTime).toISOString()
        : (dbRow?.last_seen_at || null),
    };
  });

  // Sort: online first, then in-cloud-only (need import), then offline, then orphaned (in DB but not on cloud-speaker)
  merged.sort((a: any, b: any) => {
    const aOnline = a.cloud_state?.networkStatus === 1 ? 0 : 1;
    const bOnline = b.cloud_state?.networkStatus === 1 ? 0 : 1;
    if (aOnline !== bOnline) return aOnline - bOnline;
    if (a.in_cloud !== b.in_cloud) return a.in_cloud ? -1 : 1;
    return (a.device_sn || '').localeCompare(b.device_sn || '');
  });

  const payload = {
    devices: merged,
    summary: {
      cloud_total: csBySn.size,
      db_total: dbBySn.size,
      merged_total: merged.length,
      online: merged.filter((d: any) => d.cloud_state?.networkStatus === 1).length,
      claimed: merged.filter((d: any) => !!d.claimed_at).length,
      pending_claim: merged.filter((d: any) => d.in_db && !d.claimed_at).length,
      needs_import: merged.filter((d: any) => !d.in_db && d.in_cloud).length,
      orphaned: merged.filter((d: any) => d.in_db && !d.in_cloud).length,
    },
    cloud_speaker_error: csList.ok ? null : csList.error,
  };

  // Only cache if cloud-speaker call succeeded — caching errors would
  // strand the page in a bad state for 30 s.
  if (csList.ok) {
    liveCache = { at: Date.now(), payload };
  }
  return res.status(200).json(payload);
}

// ─── Cloud-speaker auth: auto-refresh token on 401 ───────────────────────
// HEMI's /create_token uses {loginAccount, password} and returns
// { code: 0, data: { token, userId, ... }, success: true }.
// Tokens expire after some interval (a few days in observation); we always
// retry once on 401 by re-logging in with the stored credentials. The
// resulting token is cached in the module-scoped HEMI_USER_TOKEN variable,
// so subsequent calls (within the same lambda instance) skip login.
async function loginCloudSpeaker(): Promise<{ ok: boolean; token?: string; error?: string }> {
  if (!HEMI_LOGIN_ACCOUNT || !HEMI_LOGIN_PASSWORD) {
    return { ok: false, error: 'HEMI_LOGIN_ACCOUNT/HEMI_LOGIN_PASSWORD not configured' };
  }
  try {
    const r = await fetch(`${HEMI_BASE_URL}/create_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginAccount: HEMI_LOGIN_ACCOUNT, password: HEMI_LOGIN_PASSWORD }),
    });
    const json: any = await r.json().catch(() => ({}));
    // HEMI uses code !== 0 for errors even when HTTP is 200 and success is true.
    if (!r.ok || json?.code !== 0 || !json?.data?.token) {
      return { ok: false, error: json?.msg || `HTTP ${r.status}` };
    }
    HEMI_USER_TOKEN = String(json.data.token);
    console.log('[HEMI] cloud-speaker token refreshed');
    return { ok: true, token: HEMI_USER_TOKEN };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'network_error' };
  }
}

// Wraps a cloud-speaker call so a 401 (or 4001) auto-re-logs and retries once.
async function cloudSpeakerFetch(
  path: string,
  init: { method?: string; body?: any } = {},
): Promise<{ ok: boolean; json?: any; error?: string }> {
  const exec = async (token: string) => fetch(`${HEMI_BASE_URL}${path}`, {
    method: init.method || 'POST',
    headers: { 'authorization': token, 'content-type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  if (!HEMI_USER_TOKEN) {
    const login = await loginCloudSpeaker();
    if (!login.ok) return { ok: false, error: login.error };
  }

  let r = await exec(HEMI_USER_TOKEN);
  let json: any = await r.json().catch(() => ({}));

  // HEMI returns code 401/4001 for auth failures even when HTTP is 200.
  // 403 also surfaces when the token is stale — observed at peeap-terminal
  // first-deploy when the env-copied token had aged out. Re-login is
  // cheap (~150ms) so widening the trigger is safe; if it's a true
  // permission error the retry will return the same 403 and we surface
  // it to the caller.
  const isAuthFail = r.status === 401 || r.status === 403
    || json?.code === 401 || json?.code === 4001
    || /token.*invalid|token.*expired/i.test(json?.msg || '');

  if (isAuthFail) {
    const login = await loginCloudSpeaker();
    if (!login.ok) return { ok: false, error: login.error };
    r = await exec(HEMI_USER_TOKEN);
    json = await r.json().catch(() => ({}));
  }

  if (!r.ok || json?.code !== 0) {
    return { ok: false, error: json?.msg || `HTTP ${r.status}` };
  }
  return { ok: true, json };
}

// ─── Cloud-speaker sync: pull all devices on our HEMI account ────────────
async function cloudSpeakerListDevices(): Promise<{ ok: boolean; devices?: any[]; error?: string }> {
  const r = await cloudSpeakerFetch('/paging_devices', {
    body: { pageNum: 1, pageSize: 200 },
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, devices: r.json?.data?.content || [] };
}

/**
 * Admin: import devices from cloud-speaker into our merchant_devices pool.
 *
 * Pulls everything HEMI shows under our `peeappay` account, then inserts
 * any missing rows as pre-provisioned (owner_user_id NULL). Existing rows
 * are left untouched — claimed devices keep their merchant ownership;
 * already-pre-provisioned devices keep their device_secret unchanged.
 *
 * Each pre-provisioned row gets a fresh device_secret which becomes the
 * `/claim/<secret>` URL we share with the merchant who'll receive the
 * physical unit.
 */
export async function handleHemiSync(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  // Admin-only — gate by role check on users.roles (text[] column).
  const { data: u } = await supabase.from('users').select('roles').eq('id', userId).single();
  const roles = (u?.roles as string[]) || [];
  if (!roles.includes('admin') && !roles.includes('superadmin')) {
    return res.status(403).json({ error: 'admin_only' });
  }

  const list = await cloudSpeakerListDevices();
  if (!list.ok || !list.devices) {
    return res.status(502).json({ error: 'cloud_speaker_unreachable', detail: list.error });
  }

  // Existing rows we already have, keyed by SN.
  const { data: existing } = await supabase
    .from('merchant_devices')
    .select('id, device_sn, claimed_at');
  const existingBySn = new Map((existing || []).map(r => [r.device_sn, r]));

  // Distill the cloud-speaker payload into a stable shape we control. Keeping
  // a slim projection (instead of dumping the whole record) avoids leaking
  // HEMI-side metadata churn into our schema.
  //
  // signalValue picks the active link's strength: WiFi → wifi_signal, else
  // cellular signal_value. The bug it fixes: a device on WiFi was showing
  // -90 dBm "poor" bars because we always read signal_value (the SIM
  // signal, which is unrelated to the active link).
  const distill = (d: any) => {
    const networkMode = d.network_mode;
    const isWifi = (networkMode || '').toUpperCase() === 'WIFI';
    return {
      deviceModel: d.deviceModel,
      networkStatus: d.networkStatus,
      networkMode,
      wifiName: d.wifi_name,
      wifiSignal: d.wifi_signal,
      cellSignal: d.signal_value,
      // Active-link signal — picks WiFi vs cellular based on the link in use
      signalValue: isWifi ? (d.wifi_signal || d.signal_value) : d.signal_value,
      batteryPercent: d.battery_percent,
      batteryVoltage: d.battery_voltage,
      language: d.language,
      firmware: {
        fourG: d.fourG_fw_version,
        wifi: d.wifi_fw_version,
        audio: d.audio_version,
        hardware: d.hardware_version,
        protocol: d.protocol_version,
      },
      storageRemainBytes: d.file_storage_remain_size,
      lastReportAt: d.lastReportDataTime,
      activeAt: d.activeTime,
      ip: d.ip,
      cloudId: d.id,
      ownerName: d.ownerName,
    };
  };

  const nowIso = new Date().toISOString();
  let added = 0;
  let alreadyClaimed = 0;
  let alreadyPending = 0;
  const newRows: any[] = [];
  const updates: Array<{ device_sn: string; cloud_state: any; last_synced_at: string; last_seen_at: string | null }> = [];

  for (const d of list.devices) {
    const sn = d.deviceNumber;
    if (!sn) continue;
    const cloudState = distill(d);
    const lastSeen = d.lastReportDataTime ? new Date(d.lastReportDataTime).toISOString() : null;
    const have = existingBySn.get(sn);
    if (have) {
      have.claimed_at ? alreadyClaimed++ : alreadyPending++;
      updates.push({ device_sn: sn, cloud_state: cloudState, last_synced_at: nowIso, last_seen_at: lastSeen });
      continue;
    }
    newRows.push({
      device_sn: sn,
      device_secret: randomBytes(24).toString('base64url'),
      owner_user_id: null,
      model: (d.deviceModel || 'y68').toLowerCase().startsWith('y68') ? 'y68' : 'soundbox',
      profile: 'merchant',
      status: 'active',
      cloud_state: cloudState,
      last_synced_at: nowIso,
      last_seen_at: lastSeen,
    });
  }

  if (newRows.length > 0) {
    const { error } = await supabase.from('merchant_devices').insert(newRows);
    if (error) {
      console.error('[HEMI] sync insert failed:', error);
      return res.status(500).json({ error: error.message });
    }
    added = newRows.length;

    // Auto-push activation QR onto each newly imported device's idle screen.
    // Best-effort and parallel — a slow HEMI response should never stall sync.
    Promise.all(newRows.map(r => pushClaimScreen(r.device_sn).catch(() => {})))
      .catch(() => {});
  }

  // Refresh cloud_state for all existing rows in parallel. Per-row updates
  // because Supabase doesn't support multi-row UPDATEs without an upsert.
  if (updates.length > 0) {
    await Promise.all(updates.map(u =>
      supabase
        .from('merchant_devices')
        .update({
          cloud_state: u.cloud_state,
          last_synced_at: u.last_synced_at,
          last_seen_at: u.last_seen_at,
        })
        .eq('device_sn', u.device_sn)
        .then(() => {}),
    ));
  }

  return res.status(200).json({
    summary: {
      remote_total: list.devices.length,
      local_already_claimed: alreadyClaimed,
      local_pending_claim: alreadyPending,
      newly_imported: added,
    },
    new_devices: newRows.map(r => ({
      device_sn: r.device_sn,
      claim_url: `${FRONTEND_URL}/claim?sn=${encodeURIComponent(r.device_sn)}`,
    })),
  });
}

// ─── POS push: send a price to a paired device → device shows a QR ───────
// Body: { device_sn, amount, description?, profile? }. Auth = merchant who
// owns the device. Used by the POS ("ring up an item, send to terminal").
//
// Flow:
//   1. Look up device, verify caller owns it
//   2. Create a P2P checkout session crediting the owner's wallet
//   3. Push QR to the device via /api/set_qr_code_data
//   4. Return the sessionId so the POS can poll status / show the customer
export async function handleHemiPushAmount(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const userId = await getAuthenticatedUserId(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { device_sn, amount, description } = (req.body || {}) as {
    device_sn?: string;
    amount?: number;
    description?: string;
  };
  if (!device_sn || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'device_sn_and_amount_required' });
  }

  const { data: device } = await supabase
    .from('merchant_devices')
    .select('device_sn, owner_user_id, terminal_label, status, claimed_at')
    .eq('device_sn', device_sn)
    .maybeSingle();

  if (!device) return res.status(404).json({ error: 'device_not_found' });
  if (device.status !== 'active') return res.status(403).json({ error: 'device_disabled' });
  if (!device.claimed_at || !device.owner_user_id) {
    return res.status(409).json({ error: 'device_not_claimed' });
  }
  if (device.owner_user_id !== userId) {
    return res.status(403).json({ error: 'not_your_device' });
  }

  const { data: owner } = await supabase
    .from('users')
    .select('first_name, last_name, username, profile_picture')
    .eq('id', userId)
    .single();
  const ownerName = owner
    ? `${owner.first_name || ''} ${owner.last_name || ''}`.trim() || owner.username || 'Merchant'
    : 'Merchant';

  // Create a P2P checkout session — same shape as the keypad inbound flow.
  const sessionId = `cs_${randomUUID().replace(/-/g, '')}`;
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  const { data: session, error: sessErr } = await supabase
    .from('checkout_sessions')
    .insert({
      external_id: sessionId,
      merchant_id: null,
      status: 'OPEN',
      amount,
      currency_code: 'SLE',
      description: description || (device.terminal_label
        ? `${ownerName} · ${device.terminal_label}`
        : `Payment to ${ownerName}`),
      merchant_name: ownerName,
      merchant_logo_url: owner?.profile_picture || null,
      brand_color: '#4F46E5',
      payment_methods: { qr: true, card: true, mobile: false },
      metadata: {
        type: 'p2p',
        recipientId: userId,
        recipientName: ownerName,
        device_sn: device.device_sn,
        terminal_label: device.terminal_label || null,
        source: 'pos_push',
        expectedAmount: amount,
      },
      expires_at: expiresAt.toISOString(),
    })
    .select('external_id')
    .single();

  if (sessErr || !session) {
    console.error('[HEMI] PushAmount session create failed:', sessErr);
    return res.status(500).json({ error: 'session_create_failed' });
  }

  const qrText = `${CHECKOUT_URL}/scan-pay/${session.external_id}`;
  const push = await setQrCodeData({
    deviceSn: device.device_sn,
    amountDue: amount,
    orderId: session.external_id,
    qrText,
    amountLabel: amount.toFixed(2),
  });

  if (!push.ok) {
    await supabase
      .from('checkout_sessions')
      .update({ status: 'EXPIRED', metadata: { device_sn: device.device_sn, push_error: push.error } })
      .eq('external_id', session.external_id);
    return res.status(502).json({ error: 'device_push_failed', detail: push.error });
  }

  return res.status(200).json({
    sessionId: session.external_id,
    deviceSn: device.device_sn,
    amount,
    expiresIn: SESSION_TIMEOUT_SECONDS,
  });
}
