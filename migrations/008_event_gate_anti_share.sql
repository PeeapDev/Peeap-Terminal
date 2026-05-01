-- Anti-share signals on event gate consumes.
--
-- The HEMI device-scan flow shows a static QR. A photograph of that QR
-- is functionally identical to the QR — anyone can scan the photo from
-- anywhere. Tickets are still bound to user_id so a non-ticketed friend
-- can't enter, but a malicious actor can WhatsApp the photo with
-- "scan to verify early!" and trick legitimate ticket-holders into
-- burning their tickets at home.
--
-- This migration adds two forensics columns we record on every consume:
--   consumed_ip          — the client IP at consume time
--   consumed_user_agent  — the browser/UA string
--
-- Together with the existing consumed_at + consumed_device_sn, these let
-- us spot a WhatsApp-share burst (many consumes from many distinct
-- subnets within a few seconds) post-hoc and let the rate-limit code in
-- event-gate.ts decide whether to throttle the device.
--
-- Run in Supabase SQL Editor.

ALTER TABLE event_tickets
  ADD COLUMN IF NOT EXISTS consumed_ip         text,
  ADD COLUMN IF NOT EXISTS consumed_user_agent text;

-- Tighter index for the per-device rate-limit query
-- (count of consumes for a device in the last N seconds).
CREATE INDEX IF NOT EXISTS idx_event_tickets_consumed_device_recent
  ON event_tickets(consumed_device_sn, consumed_at)
  WHERE consumed_at IS NOT NULL;
