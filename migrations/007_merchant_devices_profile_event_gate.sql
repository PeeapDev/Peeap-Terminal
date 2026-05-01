-- merchant_devices.profile: add 'event_gate' to the allowed values.
--
-- Migration 001 originally locked the constraint to
-- ('merchant','transport','pos','fuel','supermarket'). The HEMI terminal
-- UI exposes 'event_gate' as a service mode for ticket-validation gates,
-- so the constraint needs to allow it before the merchant can flip a
-- claimed device into that mode.
--
-- Run in Supabase SQL Editor.

ALTER TABLE merchant_devices DROP CONSTRAINT IF EXISTS merchant_devices_profile_chk;
ALTER TABLE merchant_devices ADD CONSTRAINT merchant_devices_profile_chk
  CHECK (profile IN ('merchant', 'transport', 'pos', 'fuel', 'supermarket', 'event_gate'));
