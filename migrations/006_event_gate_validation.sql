-- Event ticket validation modes: standard per-attendee QR vs HEMI device-scan.
--
-- 'attendee_qr' (default) — each ticket has its own QR; gate staff scans
-- with their phone using EventScannerPage. Works without HEMI hardware.
--
-- 'device_scan' — HEMI Y68/soundbox at the gate shows a static event QR.
-- Attendees scan the device with their Peeap app, which posts to
-- /api/events/gate-verify with the device_sn + event_id. The backend
-- checks the attendee has a paid event_ticket and marks it consumed
-- atomically. Optimised for high-throughput entry (no per-attendee
-- QR generation, no gate-staff phone needed).
--
-- Run in Supabase SQL Editor.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS validation_mode  text NOT NULL DEFAULT 'attendee_qr',
  ADD COLUMN IF NOT EXISTS gate_device_sn   text;

ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_validation_mode_chk;
ALTER TABLE events
  ADD CONSTRAINT events_validation_mode_chk
  CHECK (validation_mode IN ('attendee_qr', 'device_scan'));

-- One device can only be the active gate for one event at a time —
-- prevents an attendee scanning the device from being matched against
-- the wrong event. Filtered by published / live status if you have one.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_events_gate_device
  ON events(gate_device_sn)
  WHERE gate_device_sn IS NOT NULL;

-- Track which ticket was redeemed by whom and when (for double-scan
-- detection and audit). event_tickets already has a consumed_at if it
-- exists; otherwise add it.
ALTER TABLE event_tickets
  ADD COLUMN IF NOT EXISTS consumed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS consumed_device_sn text;

CREATE INDEX IF NOT EXISTS idx_event_tickets_consumed
  ON event_tickets(event_id, consumed_at);
