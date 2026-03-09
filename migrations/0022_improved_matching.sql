-- 0022_improved_matching.sql
-- Improve learning and matching mechanism for QuickEntry

-- Enable pg_trgm for fuzzy matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Update description_memories table
ALTER TABLE description_memories ADD COLUMN IF NOT EXISTS usage_count INT DEFAULT 1;
ALTER TABLE description_memories ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP WITH TIME ZONE DEFAULT now();

-- Add trigram index for fast similarity search
CREATE INDEX IF NOT EXISTS description_memories_trgm_idx ON description_memories USING gin (description gin_trgm_ops);

-- Create account_aliases table
CREATE TABLE IF NOT EXISTS account_aliases (
    alias TEXT PRIMARY KEY,
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE
);

-- Add trigram index for account aliases
CREATE INDEX IF NOT EXISTS account_aliases_trgm_idx ON account_aliases USING gin (alias gin_trgm_ops);

-- Seed some default aliases
INSERT INTO account_aliases (alias, account_id)
SELECT 'nubank', id FROM accounts WHERE name = 'nubank' AND type = 'asset'
ON CONFLICT DO NOTHING;

INSERT INTO account_aliases (alias, account_id)
SELECT 'nu', id FROM accounts WHERE name = 'nubank' AND type = 'asset'
ON CONFLICT DO NOTHING;

INSERT INTO account_aliases (alias, account_id)
SELECT 'nu cartao', id FROM accounts WHERE name = 'nubank' AND type = 'liability'
ON CONFLICT DO NOTHING;

INSERT INTO account_aliases (alias, account_id)
SELECT 'cartao nu', id FROM accounts WHERE name = 'nubank' AND type = 'liability'
ON CONFLICT DO NOTHING;

INSERT INTO account_aliases (alias, account_id)
SELECT 'itau', id FROM accounts WHERE name = 'itau' AND type = 'asset'
ON CONFLICT DO NOTHING;

-- Update the view for description memories
DROP VIEW IF EXISTS description_memories_with_names;
CREATE OR REPLACE VIEW description_memories_with_names AS
SELECT 
    m.description,
    m.category_id,
    c.name as category_name,
    c.type as category_type,
    m.account_id,
    a.name as account_name,
    a.type as account_type,
    m.currency,
    m.usage_count,
    m.last_used_at,
    m.updated_at
FROM description_memories m
LEFT JOIN accounts c ON m.category_id = c.id
LEFT JOIN accounts a ON m.account_id = a.id;

-- Function to match description memories using fuzzy search
CREATE OR REPLACE FUNCTION match_description_memory(p_input TEXT)
RETURNS TABLE (
    description TEXT,
    category_id UUID,
    category_name TEXT,
    category_type TEXT,
    account_id UUID,
    account_name TEXT,
    account_type TEXT,
    currency TEXT,
    similarity REAL,
    score REAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        v.description,
        v.category_id,
        v.category_name,
        v.category_type,
        v.account_id,
        v.account_name,
        v.account_type,
        v.currency,
        similarity(v.description, p_input) as similarity,
        (similarity(v.description, p_input) * 1.0 + 
         least(v.usage_count::REAL / 100.0, 0.5) + 
         (CASE WHEN v.last_used_at > now() - interval '1 month' THEN 0.2 ELSE 0 END)) as score
    FROM description_memories_with_names v
    WHERE similarity(v.description, p_input) > 0.2
    ORDER BY score DESC
    LIMIT 5;
END;
$$ LANGUAGE plpgsql;

-- Function to match accounts using aliases and fuzzy search
CREATE OR REPLACE FUNCTION match_account(p_input TEXT)
RETURNS TABLE (
    account_id UUID,
    account_name TEXT,
    full_name TEXT,
    type TEXT,
    similarity REAL
) AS $$
BEGIN
    -- 1. Try exact match on name or full_name
    RETURN QUERY
    SELECT a.id, a.name, a.full_name, a.type, 1.0::REAL as similarity
    FROM account_names_hierarchical a
    WHERE a.name ILIKE p_input OR a.full_name ILIKE p_input
    LIMIT 1;

    IF FOUND THEN RETURN; END IF;

    -- 2. Try alias match (fuzzy)
    RETURN QUERY
    SELECT a.id, a.name, a.full_name, a.type, similarity(al.alias, p_input) as similarity
    FROM account_aliases al
    JOIN account_names_hierarchical a ON al.account_id = a.id
    WHERE similarity(al.alias, p_input) > 0.3
    ORDER BY similarity DESC
    LIMIT 1;

    IF FOUND THEN RETURN; END IF;

    -- 3. Try fuzzy match on full_name
    RETURN QUERY
    SELECT a.id, a.name, a.full_name, a.type, similarity(a.full_name, p_input) as similarity
    FROM account_names_hierarchical a
    WHERE similarity(a.full_name, p_input) > 0.2
    ORDER BY similarity DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;
