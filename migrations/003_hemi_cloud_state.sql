-- HEMI cloud-speaker state cache
-- Stores the latest snapshot of device data from /paging_devices on each sync,
-- so the admin dashboard can show live battery/signal/network/firmware without
-- calling cloud-speaker on every page load.
-- Run in Supabase SQL Editor.

ALTER TABLE merchant_devices
  ADD COLUMN IF NOT EXISTS cloud_state    jsonb,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_merchant_devices_last_synced
  ON merchant_devices(last_synced_at DESC NULLS LAST);
