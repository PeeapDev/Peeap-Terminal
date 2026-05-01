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
