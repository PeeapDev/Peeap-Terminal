/**
 * Device-screen reconciler — single source of truth for what should be
 * showing on a HEMI device, given its DB state.
 *
 * Why this exists
 * ───────────────
 * Before: every handler that mutated a device (release / update / claim /
 * bind-event / end-shift / manual SQL) had to remember to (a) write the
 * DB row, (b) paint the home screen, (c) dismiss the wait-payment screen
 * if the previous mode parked the device there, (d) unbind events.
 * Six handlers × four steps = 24 cells, any of which can be empty and
 * leave a device stuck. Today we shipped three deploys closing three
 * different empty cells.
 *
 * After: every handler does (1) mutate the DB, (2) call
 * `reconcileDeviceScreen(deviceSn)`. The reconciler reads the current DB
 * state and brings the device into agreement with it. It is idempotent —
 * calling it twice is safe — and it is the only place that decides what
 * to paint.
 *
 * The fleet-ping cron also calls it on every tick for every online
 * device, so any drift (paint failed, manual SQL change, network blip)
 * self-heals within ~5 minutes without merchant action or support
 * intervention.
 *
 * Adding a new device profile is a one-place change here, not a six-
 * handler audit.
 */

import { supabase } from '../_shared';
import {
  updateHomeScreen,
  setQrCodeData,
  setPaymentResult,
  sendManualMessage,
} from '../handlers/hemi';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://my.peeap.com';

export type DeviceTargetState =
  | { kind: 'unclaimed' }
  | { kind: 'merchant_idle'; ownerUserId: string; terminalLabel: string | null }
  | { kind: 'event_gate'; ownerUserId: string; eventId: string; eventTitle: string };

export interface ReconcileResult {
  deviceSn: string;
  targetKind: DeviceTargetState['kind'];
  painted: boolean;
  warnings: string[];
}

/**
 * Compute the target screen state from DB rows.
 * Pure function — no side effects, easy to test.
 */
async function computeTargetState(deviceSn: string): Promise<DeviceTargetState | null> {
  const { data: device } = await supabase
    .from('merchant_devices')
    .select('owner_user_id, profile, terminal_label, status')
    .eq('device_sn', deviceSn)
    .maybeSingle();

  if (!device) return null;
  if (device.status === 'disabled' || device.status === 'lost') {
    // Disabled / lost devices: leave them at factory image. The reconciler
    // treats this as "unclaimed" so the screen goes blank and the device
    // can't be confused for an active terminal.
    return { kind: 'unclaimed' };
  }
  if (!device.owner_user_id) {
    return { kind: 'unclaimed' };
  }

  if (device.profile === 'event_gate') {
    const { data: event } = await supabase
      .from('events')
      .select('id, title')
      .eq('gate_device_sn', deviceSn)
      .eq('validation_mode', 'device_scan')
      .maybeSingle();
    if (event) {
      return {
        kind: 'event_gate',
        ownerUserId: device.owner_user_id,
        eventId: event.id,
        eventTitle: event.title || 'Event',
      };
    }
    // Profile is event_gate but no event bound — we treat this as
    // merchant_idle so the device shows factory image instead of a
    // dangling "Pending event setup" page.
  }

  return {
    kind: 'merchant_idle',
    ownerUserId: device.owner_user_id,
    terminalLabel: device.terminal_label,
  };
}

/**
 * Bring the device's screen into agreement with the DB.
 *
 * The two-screen device model:
 *   - idle home (update_home_screen, no timeout)
 *   - wait-payment (set_qr_code_data, has a timeout)
 *
 * Some flows (event_gate bind, mid-payment) park the device on the
 * wait-payment screen with a long timeout. A new home-screen paint is
 * INVISIBLE while wait-payment is up, so we always issue a
 * setPaymentResult(amount=0) afterwards to dismiss wait-payment and
 * force the device back to home where the new image is visible.
 *
 * The exception is `event_gate`: that mode WANTS the wait-payment screen
 * displayed (it shows the gate QR), so we paint both screens with the
 * gate URL and DON'T dismiss.
 */
export async function reconcileDeviceScreen(deviceSn: string): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    deviceSn,
    targetKind: 'unclaimed',
    painted: false,
    warnings: [],
  };

  const target = await computeTargetState(deviceSn);
  if (!target) {
    result.warnings.push('device_not_in_inventory');
    return result;
  }
  result.targetKind = target.kind;

  switch (target.kind) {
    case 'unclaimed': {
      // Factory home image (empty payload = factory default), then dismiss
      // any stuck wait-payment layer so the factory image is visible.
      // Also reset audio override so the next claimer doesn't inherit
      // the previous merchant's voice.
      const tasks = [
        updateHomeScreen({ deviceSn, qrText: '', topLabel: '', bottomLabel: '' }).catch(
          (e: any) => result.warnings.push(`home_paint:${e?.message || 'err'}`),
        ),
        setPaymentResult({
          deviceSn,
          amount: 0,
          orderId: `reconcile_unclaimed_${Date.now()}`,
        }).catch((e: any) => result.warnings.push(`dismiss_wait:${e?.message || 'err'}`)),
        sendManualMessage({
          deviceSn,
          packetType: 'set_device_info',
          content: { play_audio: '' },
        }).catch((e: any) => result.warnings.push(`audio_reset:${e?.message || 'err'}`)),
      ];
      await Promise.all(tasks);
      result.painted = result.warnings.length === 0;
      return result;
    }

    case 'merchant_idle': {
      // Factory home + dismiss wait-payment. We don't paint a merchant
      // QR on idle anymore — see pushMerchantHomeScreen comment.
      const tasks = [
        updateHomeScreen({ deviceSn, qrText: '', topLabel: '', bottomLabel: '' }).catch(
          (e: any) => result.warnings.push(`home_paint:${e?.message || 'err'}`),
        ),
        setPaymentResult({
          deviceSn,
          amount: 0,
          orderId: `reconcile_idle_${Date.now()}`,
        }).catch((e: any) => result.warnings.push(`dismiss_wait:${e?.message || 'err'}`)),
      ];
      await Promise.all(tasks);
      result.painted = result.warnings.length === 0;
      return result;
    }

    case 'event_gate': {
      // Event mode: paint BOTH screens with the gate URL. Wait-payment
      // gets a 24h timeout so a stray keypad doesn't dump it back to
      // home mid-event.
      const gateUrl = `${FRONTEND_URL}/g?event=${encodeURIComponent(target.eventId)}&device=${encodeURIComponent(deviceSn)}`;
      const orderId = `reconcile_gate_${Date.now()}`;
      const tasks = [
        updateHomeScreen({
          deviceSn,
          qrText: gateUrl,
          topLabel: target.eventTitle.slice(0, 20),
          bottomLabel: 'Show pass to scan',
        }).catch((e: any) => result.warnings.push(`home_paint:${e?.message || 'err'}`)),
        setQrCodeData({
          deviceSn,
          amountDue: 0,
          orderId,
          qrText: gateUrl,
          amountLabel: target.eventTitle.slice(0, 20),
          timeOutSec: 86400,
        }).catch((e: any) => result.warnings.push(`wait_paint:${e?.message || 'err'}`)),
      ];
      await Promise.all(tasks);
      result.painted = result.warnings.length === 0;
      return result;
    }
  }
}

/**
 * Reconcile every online device. Called from the fleet-ping cron
 * (handleCronHemiPing) after the bulk-state pull. Drift-correcting:
 * any device whose visible screen has fallen out of sync with its DB
 * state is brought back into agreement within one cron tick (~5 min
 * worst case via GitHub Actions schedule).
 */
export async function reconcileAllOnlineDevices(): Promise<{
  total: number;
  reconciled: number;
  warnings: number;
}> {
  // Pull the small set of devices that are online and in scope. We
  // limit to claimed-OR-recently-seen so we don't hammer cloud-speaker
  // every 5 min on inventory we haven't shipped.
  const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: devices } = await supabase
    .from('merchant_devices')
    .select('device_sn, last_seen_at')
    .gte('last_seen_at', cutoff);

  const list = devices || [];
  let reconciled = 0;
  let warnings = 0;

  // Concurrency-limited fan-out (cloud-speaker isn't infinite). 5 in
  // flight at a time is a safe default for SL fleet sizes.
  const BATCH = 5;
  for (let i = 0; i < list.length; i += BATCH) {
    const slice = list.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map(d => reconcileDeviceScreen(d.device_sn).catch(err => ({
        deviceSn: d.device_sn,
        targetKind: 'unclaimed' as const,
        painted: false,
        warnings: [err?.message || 'unknown_err'],
      }))),
    );
    for (const r of results) {
      if (r.painted) reconciled++;
      if (r.warnings.length) warnings++;
    }
  }

  return { total: list.length, reconciled, warnings };
}
