-- 0024_fix_rpc_types.sql
-- Fix type mismatch in match_description_memory and match_account RPCs

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
        similarity(v.description, p_input)::REAL as similarity,
        (similarity(v.description, p_input)::REAL * 1.0 + 
         least(v.usage_count::REAL / 100.0, 0.5) + 
         (CASE WHEN v.last_used_at > now() - interval '1 month' THEN 0.2 ELSE 0 END))::REAL as score
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
    SELECT a.id, a.name, a.full_name, a.type, similarity(al.alias, p_input)::REAL as similarity
    FROM account_aliases al
    JOIN account_names_hierarchical a ON al.account_id = a.id
    WHERE similarity(al.alias, p_input) > 0.3
    ORDER BY similarity DESC
    LIMIT 1;

    IF FOUND THEN RETURN; END IF;

    -- 3. Try fuzzy match on full_name
    RETURN QUERY
    SELECT a.id, a.name, a.full_name, a.type, similarity(a.full_name, p_input)::REAL as similarity
    FROM account_names_hierarchical a
    WHERE similarity(a.full_name, p_input) > 0.2
    ORDER BY similarity DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;
