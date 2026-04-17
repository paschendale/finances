-- Fix account classifications in finances-territorial.
-- nu-caixinha was incorrectly typed as equity; it is a Nubank savings product (asset).
-- nu-conta (Nubank checking) was missing a subtype.
-- These UPDATEs match by name and affect 0 rows on databases that don't have these accounts.

UPDATE accounts
SET type = 'asset', subtype = 'checking'
WHERE name = 'nu-caixinha' AND type = 'equity';

UPDATE accounts
SET subtype = 'checking'
WHERE name = 'nu-conta' AND type = 'asset' AND (subtype IS NULL OR subtype = '');
