-- 0026_improve_account_match.sql
-- Improve match_account to use ILIKE for partial matches as fallback

CREATE OR REPLACE FUNCTION match_account(p_input TEXT)
RETURNS TABLE (
    account_id UUID,
    account_name TEXT,
    full_name TEXT,
    type TEXT,
    similarity REAL
) AS $$
BEGIN
    -- 1. Try exact match on name or full_name (case-insensitive)
    RETURN QUERY
    SELECT a.id, a.name, a.full_name, a.type, 1.0::REAL as similarity
    FROM account_names_hierarchical a
    WHERE a.name ILIKE p_input OR a.full_name ILIKE p_input
    LIMIT 1;

    IF FOUND THEN RETURN; END IF;

    -- 2. Try alias match (case-insensitive)
    RETURN QUERY
    SELECT a.id, a.name, a.full_name, a.type, 1.0::REAL as similarity
    FROM account_aliases al
    JOIN account_names_hierarchical a ON al.account_id = a.id
    WHERE al.alias ILIKE p_input
    LIMIT 1;

    IF FOUND THEN RETURN; END IF;

    -- 3. Try partial name/alias match with ILIKE
    RETURN QUERY
    SELECT a.id, a.name, a.full_name, a.type, 0.8::REAL as similarity
    FROM account_names_hierarchical a
    WHERE a.name ILIKE '%' || p_input || '%' OR a.full_name ILIKE '%' || p_input || '%'
    LIMIT 1;

    IF FOUND THEN RETURN; END IF;

    -- 4. Try alias fuzzy match
    RETURN QUERY
    SELECT a.id, a.name, a.full_name, a.type, similarity(al.alias, p_input)::REAL as similarity
    FROM account_aliases al
    JOIN account_names_hierarchical a ON al.account_id = a.id
    WHERE similarity(al.alias, p_input) > 0.2
    ORDER BY similarity DESC
    LIMIT 1;

    IF FOUND THEN RETURN; END IF;

    -- 5. Try fuzzy match on full_name
    RETURN QUERY
    SELECT a.id, a.name, a.full_name, a.type, similarity(a.full_name, p_input)::REAL as similarity
    FROM account_names_hierarchical a
    WHERE similarity(a.full_name, p_input) > 0.1
    ORDER BY similarity DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;
