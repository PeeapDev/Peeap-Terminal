-- Enable Supabase Realtime on merchant_devices so the merchant Terminal
-- page + header indicator can listen for live cloud_state changes instead
-- of polling every 15 s.
--
-- Two things are needed:
--  1) REPLICA IDENTITY FULL — so UPDATE events include the full row data
--     (otherwise listeners only get primary keys and have to refetch).
--  2) Add the table to the `supabase_realtime` publication so the
--     Realtime server tails its WAL stream.
--
-- Run in Supabase SQL Editor.

ALTER TABLE merchant_devices REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE merchant_devices;
    EXCEPTION
      WHEN duplicate_object THEN
        -- Already in the publication; nothing to do.
        NULL;
    END;
  ELSE
    -- Project doesn't have the supabase_realtime publication. Realtime
    -- broadcast won't fire until it's created in the dashboard
    -- (Database → Replication).
    RAISE NOTICE 'supabase_realtime publication missing — enable Realtime in the Supabase dashboard.';
  END IF;
END $$;
