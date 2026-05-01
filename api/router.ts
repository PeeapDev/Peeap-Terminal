/**
 * Single Vercel function dispatching every Terminal route.
 *
 * Why one function: cold-start is paid once per request, not per file.
 * The Card monorepo's api-deploy uses the same pattern. Path matching is
 * cheap; cold-start is not.
 *
 * URL shape (all behind `https://hemi.peeap.com/`):
 *
 *   GET  /api/health                                — liveness probe
 *
 *   POST /api/hemi/devices/register                  — admin: stamp a new SN into inventory
 *   GET  /api/hemi/devices                           — merchant's device list
 *   GET  /api/hemi/claim-by-sn?sn=<sn>               — info before claim
 *   POST /api/hemi/claim-by-sn                       — claim by SN
 *   POST /api/hemi/devices/:sn/release               — owner: unpair device, paint factory
 *   POST /api/hemi/devices/:sn/factory-reset         — escape hatch — reconciler in disguise
 *   POST /api/hemi/devices/:sn/end-shift             — owner: force-close active shift
 *   POST /api/hemi/devices/:sn/bind-event            — owner: bind event for gate-scan mode
 *   POST /api/hemi/devices/:sn/(test-sound|test-qr|reset-screen|play-audio|refresh|ping)
 *                                                    — owner: per-device actions
 *   PATCH /api/hemi/devices/:sn                      — owner: profile / label / status
 *   GET   /api/hemi/my-events                        — events bindable by the merchant
 *
 *   POST /api/hemi/devices/:sn/audio                 — owner: upload custom audio
 *   GET  /api/hemi/devices/:sn/audio/:taskId         — audio approval status
 *   GET  /api/hemi/assets                            — owner: list uploaded assets
 *   GET  /api/admin/hemi/assets                      — admin: review queue
 *   POST /api/admin/hemi/assets/:id/review           — admin: approve / reject
 *
 *   POST /api/hemi/keypad-inbound                    — cloud-speaker callback (no-auth, signature-checked inside)
 *   POST /api/hemi/admin-command                     — admin: arbitrary cloud-speaker passthrough
 *   POST /api/hemi/push-amount                       — admin: queue an amount on a device
 *   POST /api/hemi/push-claim-screen                 — admin: paint activation QR
 *   GET  /api/admin/hemi/devices                     — admin: full fleet view with owners
 *   GET  /api/admin/hemi/live                        — admin: live cloud-speaker pull
 *   POST /api/hemi/sync                              — admin: import unknown SNs from cloud-speaker
 *
 *   POST /api/hemi/shift/start                       — staff: start their shift
 *   POST /api/hemi/shift/end                         — staff: end their own shift
 *   POST /api/hemi/bulk-provision                    — admin: claim N SNs at once
 *
 *   POST /api/events/gate-verify                     — attendee: device-scan ticket validation
 *
 *   POST /api/cron/hemi-ping                         — fleet ping + reconciler (auth: CRON_SECRET)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  handleHemiDeviceRegister,
  handleHemiDeviceList,
  handleHemiClaimBySn,
  handleHemiDeviceClaim,
  handleHemiDeviceRelease,
  handleHemiDeviceFactoryReset,
  handleHemiDeviceReportStolen,
  handleHemiDeviceEndShift,
  handleHemiDeviceBindEvent,
  handleHemiMyEvents,
  handleHemiDeviceAction,
  handleHemiDeviceUpdate,
  handleHemiDeviceAudioUpload,
  handleHemiAudioTaskStatus,
  handleHemiMerchantAssetList,
  handleHemiAdminAssetQueue,
  handleHemiAdminAssetReview,
  handleHemiKeypadInbound,
  handleHemiAdminCommand,
  handleHemiPushAmount,
  handleHemiPushClaimScreen,
  handleHemiAdminDeviceList,
  handleHemiAdminLiveDevices,
  handleHemiSync,
  handleHemiShiftStart,
  handleHemiShiftEnd,
  handleHemiBulkProvision,
  handleCronHemiPing,
} from '../lib/handlers/hemi';
import { handleEventGateVerify } from '../lib/handlers/event-gate';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Permissive CORS — Terminal is called from my.peeap.com (merchant
  // settings) and the attendee Peeap web app, plus cloud-speaker
  // callbacks (no Origin). Same policy as the main API.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Strip the leading `/api/` and any trailing slash so the route table
  // matches against canonical path segments.
  const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/^\/+api\/+/, '').replace(/\/+$/, '');

  try {
    if (path === 'health' || path === '') {
      return res.status(200).json({ ok: true, service: 'peeap-terminal' });
    }

    // Synchronous reconciler debug — auth: CRON_SECRET. Calls
    // reconcileDeviceScreen for the given SN and returns warnings so
    // we can see exactly which cloud-speaker paint failed. Used to
    // diagnose stuck-screen issues end-to-end without grepping logs.
    const reconcileMatch = path.match(/^debug\/reconcile\/([^/]+)$/);
    if (reconcileMatch) {
      const authHeader = req.headers.authorization || '';
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      const sn = decodeURIComponent(reconcileMatch[1]);
      const { reconcileDeviceScreen } = await import('../lib/services/device-reconciler');
      const result = await reconcileDeviceScreen(sn);
      return res.status(200).json(result);
    }

    // Wire-level cloud-speaker debug — returns the raw response of each
    // paint call so we can see what HEMI is actually doing with our
    // packets. Auth: CRON_SECRET.
    const wireMatch = path.match(/^debug\/wire\/([^/]+)$/);
    if (wireMatch) {
      const authHeader = req.headers.authorization || '';
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      const sn = decodeURIComponent(wireMatch[1]);
      const apiBase = (process.env.HEMI_BASE_URL || 'https://api.cloud-speaker.com').trim();
      const soundboxBase = (process.env.HEMI_SOUNDBOX_BASE || 'http://47.254.244.245:8188').trim();
      const apiKey = (process.env.HEMI_API_KEY || '').trim();
      if (!apiKey) return res.status(500).json({ error: 'HEMI_API_KEY not set' });

      // Match real updateHomeScreen field names exactly (qrcode_1_content
      // not qrCodeText, label_1_content not topText, etc.) — these come
      // from the HEMI soundbox webhook contract documented elsewhere.
      const requestId = `wire_${Date.now()}`;
      const homeBody = {
        deviceNumber: sn,
        requestId,
        timeStamp: Math.floor(Date.now() / 1000),
        qrcode_1_content: `https://my.peeap.com/claim?sn=${encodeURIComponent(sn)}`,
        label_1_content: 'Scan with Peeap',
        label_1_height: 32,
        label_3_content: 'to activate',
        label_3_height: 24,
      };
      const homeResp = await fetch(`${soundboxBase}/webhook/update_home_screen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify(homeBody),
      }).then(async r => ({ status: r.status, body: await r.text() })).catch((e: any) => ({ status: 0, body: e?.message }));

      // set_payment_result lives on api.cloud-speaker.com (not soundbox).
      const dismissResp = await fetch(`${apiBase}/api/set_payment_result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({
          deviceNumber: sn,
          playPaymentAmount: 0,
          orderId: `wire_${Date.now()}`,
        }),
      }).then(async r => ({ status: r.status, body: await r.text() })).catch((e: any) => ({ status: 0, body: e?.message }));

      // set_qr_code_data with the real nested screenContent shape from
      // the production setQrCodeData function (not the flat shape).
      const overwriteResp = await fetch(`${apiBase}/api/set_qr_code_data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({
          deviceNumber: sn,
          amountDue: 0,
          orderId: `wire_${Date.now()}`,
          timeOut: 5,
          screenContent: {
            wait_payment_screen_qrcode_1_config: {
              txt: `https://my.peeap.com/claim?sn=${encodeURIComponent(sn)}`,
            },
            wait_payment_screen_label_3_config: { txt: 'Activate' },
          },
        }),
      }).then(async r => ({ status: r.status, body: await r.text() })).catch((e: any) => ({ status: 0, body: e?.message }));

      // Use sendManualMessage so cloudSpeakerFetch auto-refreshes the
      // user token (HEMI_USER_TOKEN env was stale from initial copy).
      const { sendManualMessage } = await import('../lib/handlers/hemi');
      const manualHomeResp = await sendManualMessage({
        deviceSn: sn,
        packetType: 'update_home_screen',
        content: {
          qrcode_1_content: `https://my.peeap.com/claim?sn=${encodeURIComponent(sn)}`,
          label_1_content: 'Scan with Peeap',
          label_1_height: 32,
          label_3_content: 'to activate',
          label_3_height: 24,
        },
      });
      const manualPaymentResp = await sendManualMessage({
        deviceSn: sn,
        packetType: 'set_payment_result',
        content: { playPaymentAmount: 0, orderId: `manual_${Date.now()}` },
      });
      const manualQrResp = await sendManualMessage({
        deviceSn: sn,
        packetType: 'set_qr_code_data',
        content: {
          orderId: `manual_${Date.now()}`,
          qrCodeData: `https://my.peeap.com/claim?sn=${encodeURIComponent(sn)}`,
          amountDue: 0,
          amountLabel: 'Activate',
          timeOutSec: 5,
        },
      });

      // The real fix: set_device_info → static_qrcode_content. This is
      // the device's permanent idle QR (not an overlay) and goes through
      // /manual_message + user-token auth which actually works.
      const staticQrResp = await sendManualMessage({
        deviceSn: sn,
        packetType: 'set_device_info',
        content: {
          static_qrcode_content: `https://my.peeap.com/claim?sn=${encodeURIComponent(sn)}`,
        },
      });

      // ack_payment dismisses the current payment cycle (which is what
      // was leaving the wait-payment overlay stuck on screen).
      const ackPaymentResp = await sendManualMessage({
        deviceSn: sn,
        packetType: 'set_device_info',
        content: { ack_payment: true },
      });

      return res.status(200).json({
        device_sn: sn,
        soundbox_base: soundboxBase,
        api_base: apiBase,
        // X-API-Key path
        update_home_screen: homeResp,
        set_payment_result: dismissResp,
        set_qr_code_data_overwrite: overwriteResp,
        // user-token portal path (with auto-refresh)
        manual_update_home: manualHomeResp,
        manual_set_payment: manualPaymentResp,
        manual_set_qr_code: manualQrResp,
        // The real paint path
        static_qr_set: staticQrResp,
        ack_payment: ackPaymentResp,
      });
    }

    // ── Cron ────────────────────────────────────────────────────────────
    if (path === 'cron/hemi-ping') {
      return await handleCronHemiPing(req, res);
    }

    // ── Event gate ─────────────────────────────────────────────────────
    if (path === 'events/gate-verify') {
      return await handleEventGateVerify(req, res);
    }

    // ── HEMI device lifecycle ──────────────────────────────────────────
    if (path === 'hemi/devices/register') {
      return await handleHemiDeviceRegister(req, res);
    }
    if (path === 'hemi/devices') {
      return await handleHemiDeviceList(req, res);
    }
    if (path === 'hemi/claim-by-sn') {
      return await handleHemiClaimBySn(req, res);
    }
    if (path === 'hemi/my-events') {
      return await handleHemiMyEvents(req, res);
    }

    // Per-device routes — `/hemi/devices/:sn/...`
    const deviceMatch = path.match(/^hemi\/devices\/([^/]+)(?:\/(.+))?$/);
    if (deviceMatch) {
      const sn = decodeURIComponent(deviceMatch[1]);
      const sub = deviceMatch[2];

      if (!sub) {
        // PATCH update or GET show — handler dispatches by method
        return await handleHemiDeviceUpdate(req, res, sn);
      }

      switch (sub) {
        case 'release':
          return await handleHemiDeviceRelease(req, res, sn);
        case 'factory-reset':
          return await handleHemiDeviceFactoryReset(req, res, sn);
        case 'report-stolen':
          return await handleHemiDeviceReportStolen(req, res, sn);
        case 'end-shift':
          return await handleHemiDeviceEndShift(req, res, sn);
        case 'bind-event':
          return await handleHemiDeviceBindEvent(req, res, sn);
        case 'audio':
          return await handleHemiDeviceAudioUpload(req, res, sn);
      }

      // Audio task status — `/hemi/devices/:sn/audio/:taskId`
      // (sn is in the URL but the handler takes only taskId — the
      // device-sn association lives on the audio_tasks row.)
      const audioStatus = sub.match(/^audio\/([^/]+)$/);
      if (audioStatus) {
        return await handleHemiAudioTaskStatus(req, res, decodeURIComponent(audioStatus[1]));
      }

      // Per-device actions — `/hemi/devices/:sn/:action`
      const actionable = ['test-sound', 'test-qr', 'reset-screen', 'play-audio', 'refresh', 'ping'];
      if (actionable.includes(sub)) {
        return await handleHemiDeviceAction(req, res, sn, sub as any);
      }
    }

    // ── HEMI shift handoff ─────────────────────────────────────────────
    if (path === 'hemi/shift/start') return await handleHemiShiftStart(req, res);
    if (path === 'hemi/shift/end') return await handleHemiShiftEnd(req, res);

    // ── HEMI assets / audio ────────────────────────────────────────────
    if (path === 'hemi/assets') return await handleHemiMerchantAssetList(req, res);
    if (path === 'admin/hemi/assets') return await handleHemiAdminAssetQueue(req, res);
    const adminReview = path.match(/^admin\/hemi\/assets\/([^/]+)\/review$/);
    if (adminReview) {
      return await handleHemiAdminAssetReview(req, res, decodeURIComponent(adminReview[1]));
    }

    // ── HEMI cloud-speaker callbacks + admin ───────────────────────────
    // Keypad inbound URL is `/api/hemi/keypad-inbound/<device_secret>`
    // — the secret in the path doubles as auth (cloud-speaker has no
    // signing on outbound webhooks).
    const keypadMatch = path.match(/^hemi\/keypad-inbound\/([^/]+)$/);
    if (keypadMatch) {
      return await handleHemiKeypadInbound(req, res, decodeURIComponent(keypadMatch[1]));
    }
    // Device claim URL is `/api/hemi/claim/<device_secret>` — same
    // shape as keypad-inbound: secret-in-path acts as authorization.
    const claimMatch = path.match(/^hemi\/claim\/([^/]+)$/);
    if (claimMatch) {
      return await handleHemiDeviceClaim(req, res, decodeURIComponent(claimMatch[1]));
    }
    if (path === 'hemi/admin-command') return await handleHemiAdminCommand(req, res);
    if (path === 'hemi/push-amount') return await handleHemiPushAmount(req, res);
    if (path === 'hemi/push-claim-screen') return await handleHemiPushClaimScreen(req, res);
    if (path === 'admin/hemi/devices') return await handleHemiAdminDeviceList(req, res);
    if (path === 'admin/hemi/live') return await handleHemiAdminLiveDevices(req, res);
    if (path === 'hemi/sync') return await handleHemiSync(req, res);
    if (path === 'hemi/bulk-provision') return await handleHemiBulkProvision(req, res);

    return res.status(404).json({ error: 'route_not_found', path });
  } catch (err: any) {
    console.error('[router] unhandled error:', err);
    return res.status(500).json({ error: err?.message || 'internal_error' });
  }
}
