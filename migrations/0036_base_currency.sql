-- Seed base_currency in global_settings
-- This is the currency all amount_base values are stored in.
INSERT INTO global_settings (key, value)
VALUES ('base_currency', 'BRL')
ON CONFLICT (key) DO NOTHING;
