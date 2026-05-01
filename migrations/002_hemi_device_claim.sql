-- HEMI device self-pairing (Scenario B)
-- - claimed_at: null = pre-provisioned and idle on shelf, set = active for owner
-- - owner_user_id is nullable for pre-provisioned rows
-- Run in Supabase SQL Editor.

ALTER TABLE merchant_devices
  ALTER COLUMN owner_user_id DROP NOT NULL;

ALTER TABLE merchant_devices
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- Defensive: rows that have an owner are considered claimed; backfill for any
-- pre-existing rows so the active scan-pay flow keeps working.
UPDATE merchant_devices
   SET claimed_at = COALESCE(claimed_at, created_at)
 WHERE owner_user_id IS NOT NULL AND claimed_at IS NULL;

-- Fast lookup of unclaimed devices by secret (used by the claim endpoint)
CREATE INDEX IF NOT EXISTS idx_merchant_devices_unclaimed
  ON merchant_devices(device_secret)
  WHERE claimed_at IS NULL AND status = 'active';
