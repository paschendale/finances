-- 0025_normalize_memories.sql
-- Add normalization to description_memories and match functions

CREATE EXTENSION IF NOT EXISTS unaccent;

-- Helper function to normalize strings
CREATE OR REPLACE FUNCTION normalize_text(p_input TEXT)
RETURNS TEXT AS $$
BEGIN
    RETURN trim(regexp_replace(
        lower(unaccent(p_input)),
        '[^a-z0-9 ]', '', 'g'
    ));
END;
$$ LANGUAGE plpgsql;

-- Add normalized_description column
ALTER TABLE description_memories ADD COLUMN IF NOT EXISTS normalized_description TEXT;

-- Update existing memories
UPDATE description_memories SET normalized_description = normalize_text(description);

-- Index for normalized matching
CREATE INDEX IF NOT EXISTS description_memories_norm_trgm_idx ON description_memories USING gin (normalized_description gin_trgm_ops);

-- Trigger to keep it in sync
CREATE OR REPLACE FUNCTION sync_normalized_description()
RETURNS TRIGGER AS $$
BEGIN
    NEW.normalized_description := normalize_text(NEW.description);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_normalize_description ON description_memories;
CREATE TRIGGER trg_normalize_description
BEFORE INSERT OR UPDATE ON description_memories
FOR EACH ROW
EXECUTE FUNCTION sync_normalized_description();

-- Update match_description_memory to use normalized input and data
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
DECLARE
    v_norm_input TEXT;
BEGIN
    v_norm_input := normalize_text(p_input);
    
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
        similarity(v.normalized_description, v_norm_input)::REAL as similarity,
        (similarity(v.normalized_description, v_norm_input)::REAL * 1.0 + 
         least(v.usage_count::REAL / 100.0, 0.5) + 
         (CASE WHEN v.last_used_at > now() - interval '1 month' THEN 0.2 ELSE 0 END))::REAL as score
    FROM (
        SELECT m.*, 
               c.name as category_name, c.type as category_type,
               a.name as account_name, a.type as account_type
        FROM description_memories m
        LEFT JOIN accounts c ON m.category_id = c.id
        LEFT JOIN accounts a ON m.account_id = a.id
    ) v
    WHERE similarity(v.normalized_description, v_norm_input) > 0.2
       OR v.normalized_description ILIKE '%' || v_norm_input || '%'
       OR v_norm_input ILIKE '%' || v.normalized_description || '%'
    ORDER BY score DESC
    LIMIT 5;
END;
$$ LANGUAGE plpgsql;
