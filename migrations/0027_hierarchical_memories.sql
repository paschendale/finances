-- 0027_hierarchical_memories.sql
-- Ensure match_description_memory returns full hierarchical account names

DROP VIEW IF EXISTS description_memories_with_names;
CREATE OR REPLACE VIEW description_memories_with_names AS
SELECT 
    m.description,
    m.normalized_description,
    m.category_id,
    c.full_name as category_name,
    c.type as category_type,
    m.account_id,
    a.full_name as account_name,
    a.type as account_type,
    m.currency,
    m.usage_count,
    m.last_used_at,
    m.updated_at
FROM description_memories m
LEFT JOIN account_names_hierarchical c ON m.category_id = c.id
LEFT JOIN account_names_hierarchical a ON m.account_id = a.id;

-- Update match_description_memory to return full names from the updated view
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
    FROM description_memories_with_names v
    WHERE similarity(v.normalized_description, v_norm_input) > 0.2
       OR v.normalized_description ILIKE '%' || v_norm_input || '%'
       OR v_norm_input ILIKE '%' || v.normalized_description || '%'
    ORDER BY score DESC
    LIMIT 5;
END;
$$ LANGUAGE plpgsql;
