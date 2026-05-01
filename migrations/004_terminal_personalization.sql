-- Terminal personalization: merchant-uploaded audio + brand images that
-- require admin approval before they can be activated on a device.
--
-- Why approval: a merchant could upload an audio that says "payment failed"
-- after a successful payment, or a brand image impersonating Peeap. Every
-- asset goes to a queue; an admin reviews + approves before the merchant
-- can activate it on their device.
--
-- Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS merchant_terminal_assets (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_sn                text REFERENCES merchant_devices(device_sn) ON DELETE SET NULL,
  asset_type               text NOT NULL,
  display_name             text NOT NULL,
  original_filename        text NOT NULL,
  mime_type                text NOT NULL,
  size_bytes               integer NOT NULL,
  storage_url              text,
  cloud_speaker_filename   text,
  cloud_speaker_task_id    text,
  status                   text NOT NULL DEFAULT 'pending',
  rejection_reason         text,
  submitted_at             timestamptz NOT NULL DEFAULT now(),
  reviewed_by_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at              timestamptz,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT mta_asset_type_chk CHECK (asset_type IN ('audio', 'idle_image', 'loading_image')),
  CONSTRAINT mta_status_chk     CHECK (status IN ('pending', 'approved', 'rejected', 'archived'))
);

CREATE INDEX IF NOT EXISTS idx_mta_merchant
  ON merchant_terminal_assets(merchant_user_id, status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_mta_pending_queue
  ON merchant_terminal_assets(submitted_at ASC) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_mta_device
  ON merchant_terminal_assets(device_sn) WHERE device_sn IS NOT NULL;
