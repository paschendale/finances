-- 0058_sms_events.sql
-- Card purchase alerts forwarded from the phone by SMS are advisor events like mail and Discord
-- messages: one row per message, so a text forwarded twice is recorded once.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'advisor_events'::regclass AND conname = 'advisor_events_source_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%sms%'
  ) THEN
    ALTER TABLE advisor_events DROP CONSTRAINT advisor_events_source_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'advisor_events'::regclass AND conname = 'advisor_events_source_check'
  ) THEN
    ALTER TABLE advisor_events ADD CONSTRAINT advisor_events_source_check
      CHECK (source IN ('discord', 'gmail', 'web', 'scheduler', 'sms'));
  END IF;
END $$;
