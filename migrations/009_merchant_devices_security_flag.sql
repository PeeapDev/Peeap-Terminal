-- Theft honeypot — when a merchant reports a device stolen, we DON'T
-- block subsequent claims. The device stays "active" in the eyes of
-- claimers; the next person to scan the activation QR succeeds. The
-- difference is invisible to them, but on our side every interaction
-- with a flagged device is logged with full identity (user_id, IP,
-- user_agent) so the fraud team has a dossier to hand to police.
--
-- Why honeypot vs hard block: a blocked device tells the holder it's
-- stolen, so they discard / resell to someone else and we lose the
-- trail. A silent honeypot recovers identity instead of just losing
-- the asset.
--
-- security_flag values:
--   NULL                 — normal device, no flag
--   'reported_stolen'    — original owner reported theft; honeypot active
--   'fraud_hold'         — admin-set hold; claimers blocked + transactions paused
--
-- reported_stolen_at / reported_stolen_by track who reported and when,
-- so we can show the original owner that their report is acted on and
-- the fraud team knows whose property it is.
--
-- Run in Supabase SQL Editor.

ALTER TABLE merchant_devices
  ADD COLUMN IF NOT EXISTS security_flag      text,
  ADD COLUMN IF NOT EXISTS reported_stolen_at timestamptz,
  ADD COLUMN IF NOT EXISTS reported_stolen_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE merchant_devices
  DROP CONSTRAINT IF EXISTS merchant_devices_security_flag_chk;
ALTER TABLE merchant_devices
  ADD CONSTRAINT merchant_devices_security_flag_chk
  CHECK (security_flag IS NULL OR security_flag IN ('reported_stolen', 'fraud_hold'));

CREATE INDEX IF NOT EXISTS idx_merchant_devices_security_flag
  ON merchant_devices(security_flag)
  WHERE security_flag IS NOT NULL;
