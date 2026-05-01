-- HEMI scan-to-pay device integration
-- Tables: merchant_devices, device_shifts
-- Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS merchant_devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_sn       text NOT NULL UNIQUE,
  device_secret   text NOT NULL UNIQUE,
  owner_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model           text NOT NULL DEFAULT 'y68',
  profile         text NOT NULL DEFAULT 'merchant',
  terminal_label  text,
  profile_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'active',
  last_seen_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchant_devices_profile_chk
    CHECK (profile IN ('merchant','transport','pos','fuel','supermarket')),
  CONSTRAINT merchant_devices_model_chk
    CHECK (model IN ('y68','soundbox','screen','keyboard')),
  CONSTRAINT merchant_devices_status_chk
    CHECK (status IN ('active','disabled','lost'))
);

CREATE INDEX IF NOT EXISTS idx_merchant_devices_owner
  ON merchant_devices(owner_user_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS device_shifts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_sn       text NOT NULL REFERENCES merchant_devices(device_sn) ON DELETE CASCADE,
  staff_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  opened_via      text NOT NULL DEFAULT 'app',
  cash_collected  numeric(14,2),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT device_shifts_opened_via_chk
    CHECK (opened_via IN ('pin','claim_qr','app'))
);

-- One open shift per device at any time
CREATE UNIQUE INDEX IF NOT EXISTS uniq_device_shifts_open
  ON device_shifts(device_sn) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_device_shifts_staff
  ON device_shifts(staff_user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_device_shifts_device
  ON device_shifts(device_sn, started_at DESC);
