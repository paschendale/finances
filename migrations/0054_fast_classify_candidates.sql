-- Migration 0054: make classify_candidates fast on real history
--
-- On ~10k transactions one call took ~3 s: the transaction_lines view normalized every description
-- and raw statement text per row and the scorer compared all of them. This migration
--   * stores the normalized texts on transactions as generated columns (norm_description, norm_raw);
--   * indexes them with pg_trgm GIN indexes;
--   * reads them from the view instead of recomputing;
--   * pre-filters the scorer with trigram operators (%, <%) at the eligibility threshold, so only
--     rows that could be eligible are scored. Results are unchanged; only the work shrinks.
-- Signature and result shape of classify_candidates are unchanged.

BEGIN;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS norm_description TEXT GENERATED ALWAYS AS (normalize_text(description)) STORED;
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS norm_raw TEXT GENERATED ALWAYS AS (normalize_merchant(metadata #>> '{statement_line,raw}')) STORED;

CREATE INDEX IF NOT EXISTS idx_transactions_norm_description_trgm ON transactions USING gin (norm_description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_transactions_norm_raw_trgm ON transactions USING gin (norm_raw gin_trgm_ops) WHERE norm_raw IS NOT NULL;

CREATE OR REPLACE VIEW transaction_lines AS
SELECT
  e.id                                   AS entry_id,
  t.id                                   AS transaction_id,
  t.date,
  t.created_at,
  t.description,
  t.norm_description                     AS norm_description,
  t.metadata #>> '{statement_line,raw}'  AS raw,
  t.norm_raw                             AS norm_raw,
  safe_timestamptz(t.metadata #>> '{statement_line,posted_at}') AS posted_at,
  e.account_id                           AS category_id,
  c.full_name                            AS category_name,
  c.type                                 AS category_type,
  e.amount_base,
  abs(e.amount_base)                     AS amount,
  ca.account_id                          AS asset_account_id,
  ca.currency
FROM entries e
JOIN transactions t ON t.id = e.transaction_id
JOIN accounts cat ON cat.id = e.account_id
JOIN account_names_hierarchical c ON c.id = e.account_id
LEFT JOIN LATERAL (
  SELECT e2.account_id, e2.currency
  FROM entries e2
  JOIN accounts a2 ON a2.id = e2.account_id
  WHERE e2.transaction_id = t.id
    AND a2.type IN ('asset', 'liability', 'equity')
  ORDER BY (e2.amount < 0) DESC, e2.created_at
  LIMIT 1
) ca ON true
WHERE cat.type IN ('expense', 'income')
  AND COALESCE(cat.hidden, false) = false;

CREATE OR REPLACE FUNCTION classify_candidates(
  p_description TEXT,
  p_amount      NUMERIC     DEFAULT NULL,
  p_account_id  UUID        DEFAULT NULL,
  p_date        DATE        DEFAULT NULL,
  p_posted_at   TIMESTAMPTZ DEFAULT NULL,
  p_raw         TEXT        DEFAULT NULL,
  p_limit       INT         DEFAULT 5
) RETURNS TABLE (
  category_id           UUID,
  category_name         TEXT,
  category_type         TEXT,
  canonical_description TEXT,
  account_id            UUID,
  account_name          TEXT,
  account_type          TEXT,
  currency              TEXT,
  score                 NUMERIC,
  confidence            NUMERIC,
  n_matches             INT,
  factors               JSONB
) AS $$
DECLARE
  w          JSONB;
  w_name     NUMERIC; w_raw NUMERIC; w_amount NUMERIC; w_account NUMERIC; w_time NUMERIC;
  v_k        INT;     v_months INT;
  v_norm_in  TEXT;    v_norm_raw TEXT;
  v_alias    merchant_aliases%ROWTYPE;
  v_has_alias BOOLEAN := false;
  v_norm_canon TEXT := '';
BEGIN
  -- pg_trgm operators used by the pre-filter: match the eligibility bar (f_name >= 0.25)
  PERFORM set_config('pg_trgm.similarity_threshold', '0.25', true);
  PERFORM set_config('pg_trgm.word_similarity_threshold', '0.25', true);
  SELECT value::jsonb INTO w FROM global_settings WHERE key = 'classifier_weights';
  w := COALESCE(w, '{}'::jsonb);
  w_name    := COALESCE((w->>'name')::numeric, 0.40);
  w_raw     := COALESCE((w->>'raw')::numeric, 0.20);
  w_amount  := COALESCE((w->>'amount')::numeric, 0.15);
  w_account := COALESCE((w->>'account')::numeric, 0.10);
  w_time    := COALESCE((w->>'time')::numeric, 0.10);
  v_k       := GREATEST(1, COALESCE((w->>'k')::int, 8));
  v_months  := GREATEST(1, COALESCE((w->>'history_months')::int, 24));

  v_norm_in  := normalize_text(COALESCE(p_description, ''));
  v_norm_raw := CASE WHEN p_raw IS NULL OR btrim(p_raw) = '' THEN NULL ELSE normalize_merchant(p_raw) END;
  IF v_norm_raw = '' THEN v_norm_raw := NULL; END IF;

  IF v_norm_raw IS NOT NULL THEN
    SELECT * INTO v_alias FROM merchant_aliases ma WHERE ma.raw_normalized = v_norm_raw;
    IF FOUND THEN
      v_has_alias := true;
      v_norm_canon := normalize_text(v_alias.canonical_description);
    END IF;
  END IF;

  IF v_norm_in = '' THEN
    v_norm_in := COALESCE(v_norm_canon, '');
    IF v_norm_in = '' THEN v_norm_in := COALESCE(v_norm_raw, ''); END IF;
  END IF;
  IF v_norm_in = '' AND v_norm_raw IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH scored AS (
    SELECT
      tl.*,
      GREATEST(
        similarity(tl.norm_description, v_norm_in),
        word_similarity(v_norm_in, tl.norm_description),
        CASE WHEN tl.norm_raw IS NOT NULL
             THEN GREATEST(similarity(tl.norm_raw, v_norm_in), word_similarity(v_norm_in, tl.norm_raw)) ELSE 0 END,
        CASE WHEN v_has_alias AND v_norm_canon <> ''
             THEN GREATEST(similarity(tl.norm_description, v_norm_canon), word_similarity(v_norm_canon, tl.norm_description)) ELSE 0 END
      )::numeric AS f_name,
      CASE WHEN tl.norm_raw IS NOT NULL AND v_norm_raw IS NOT NULL
           THEN GREATEST(similarity(tl.norm_raw, v_norm_raw), word_similarity(v_norm_raw, tl.norm_raw))::numeric ELSE 0 END AS f_raw,
      CASE
        WHEN p_amount IS NULL OR tl.amount = 0 THEN 0
        WHEN abs(tl.amount - abs(p_amount)) < 0.005 THEN 1.0
        WHEN abs(tl.amount - abs(p_amount)) <= 0.10 * abs(p_amount) THEN 0.7
        WHEN tl.amount BETWEEN abs(p_amount) / 10 AND abs(p_amount) * 10 THEN 0.3
        ELSE 0
      END::numeric AS f_amount,
      CASE WHEN p_account_id IS NOT NULL AND tl.asset_account_id = p_account_id THEN 1.0 ELSE 0 END::numeric AS f_account,
      CASE WHEN p_date IS NULL THEN 0 ELSE
        0.5 * (extract(dow from tl.date) = extract(dow from p_date))::int
        + 0.3 * (abs(extract(day from tl.date) - extract(day from p_date)) <= 1)::int
        + CASE WHEN p_posted_at IS NOT NULL AND tl.posted_at IS NOT NULL THEN
            0.2 * (LEAST(abs(extract(hour from tl.posted_at) - extract(hour from p_posted_at)),
                         24 - abs(extract(hour from tl.posted_at) - extract(hour from p_posted_at))) <= 2)::int
          ELSE 0 END
      END::numeric AS f_time,
      exp(-GREATEST(0, CURRENT_DATE - tl.date)::numeric / 365.0)::numeric AS recency
    FROM transaction_lines tl
    WHERE tl.date >= (CURRENT_DATE - (v_months || ' months')::interval)::date
      -- Trigram pre-filter on the stored normalized columns (GIN indexes, migration 0054). The
      -- thresholds are set to the eligibility bar below, so this is a superset of `eligible`.
      AND tl.transaction_id IN (
        SELECT t.id FROM transactions t
        WHERE t.date >= (CURRENT_DATE - (v_months || ' months')::interval)::date
          AND (
               (v_norm_in <> '' AND (t.norm_description % v_norm_in OR v_norm_in <% t.norm_description))
            OR (v_norm_in <> '' AND t.norm_raw IS NOT NULL AND (t.norm_raw % v_norm_in OR v_norm_in <% t.norm_raw))
            OR (v_has_alias AND v_norm_canon <> '' AND (t.norm_description % v_norm_canon OR v_norm_canon <% t.norm_description))
            OR (v_norm_raw IS NOT NULL AND t.norm_raw IS NOT NULL AND (t.norm_raw % v_norm_raw OR v_norm_raw <% t.norm_raw))
          )
      )
  ),
  eligible AS (
    SELECT s.*,
           (w_name * f_name + w_raw * f_raw + w_amount * f_amount + w_account * f_account + w_time * f_time) * recency AS tx_score
    FROM scored s
    WHERE f_name >= 0.25 OR f_raw >= 0.6
  ),
  ranked AS (
    SELECT e.*,
           row_number() OVER (PARTITION BY e.category_id ORDER BY tx_score DESC, e.date DESC) AS rn,
           count(*)     OVER (PARTITION BY e.category_id) AS n
    FROM eligible e
  ),
  descs AS (
    SELECT r.category_id, r.description, count(*) AS c,
           row_number() OVER (PARTITION BY r.category_id ORDER BY count(*) DESC, length(r.description) ASC, r.description) AS drn
    FROM ranked r GROUP BY r.category_id, r.description
  ),
  accts AS (
    SELECT r.category_id, r.asset_account_id, r.currency, count(*) AS c,
           row_number() OVER (PARTITION BY r.category_id ORDER BY count(*) DESC) AS arn
    FROM ranked r WHERE r.asset_account_id IS NOT NULL GROUP BY r.category_id, r.asset_account_id, r.currency
  ),
  per_cat AS (
    SELECT
      r.category_id,
      max(r.category_name) AS category_name,
      max(r.category_type) AS category_type,
      max(r.n)::int AS n_matches,
      ((sum(r.tx_score) FILTER (WHERE r.rn <= v_k)) * ln(1 + max(r.n)) / ln(1 + v_k))::numeric AS cat_score,
      round(avg(r.f_name) FILTER (WHERE r.rn <= v_k), 3)    AS a_name,
      round(avg(r.f_raw) FILTER (WHERE r.rn <= v_k), 3)     AS a_raw,
      round(avg(r.f_amount) FILTER (WHERE r.rn <= v_k), 3)  AS a_amount,
      round(avg(r.f_account) FILTER (WHERE r.rn <= v_k), 3) AS a_account,
      round(avg(r.f_time) FILTER (WHERE r.rn <= v_k), 3)    AS a_time,
      max(r.date) AS last_seen,
      count(*) FILTER (WHERE r.f_amount >= 1.0) AS same_amount_count,
      count(*) FILTER (WHERE r.f_account >= 1.0) AS same_account_count
    FROM ranked r
    GROUP BY r.category_id
  ),
  ordered AS (
    SELECT pc.*,
           row_number() OVER (ORDER BY pc.cat_score DESC, pc.n_matches DESC) AS rank,
           lead(pc.cat_score) OVER (ORDER BY pc.cat_score DESC, pc.n_matches DESC) AS next_score,
           first_value(pc.cat_score) OVER (ORDER BY pc.cat_score DESC, pc.n_matches DESC) AS top_score,
           count(*) OVER () AS n_cats
    FROM per_cat pc
  ),
  with_conf AS (
    SELECT o.*,
      CASE
        WHEN o.rank = 1 THEN
          LEAST(
            CASE WHEN o.n_cats = 1 THEN 0.9 ELSE 1.0 END,
            0.7 * (CASE WHEN o.cat_score > 0 THEN (o.cat_score - COALESCE(o.next_score, 0)) / o.cat_score ELSE 0 END)
            + 0.3 * LEAST(1.0, o.n_matches::numeric / 5.0)
          )
        ELSE
          (CASE WHEN o.top_score > 0 THEN o.cat_score / o.top_score ELSE 0 END)
          * (0.7 * (CASE WHEN o.cat_score > 0 THEN (o.cat_score - COALESCE(o.next_score, 0)) / o.cat_score ELSE 0 END)
             + 0.3 * LEAST(1.0, o.n_matches::numeric / 5.0))
      END AS conf
    FROM ordered o
  )
  SELECT
    wc.category_id,
    wc.category_name,
    wc.category_type,
    CASE WHEN v_has_alias THEN v_alias.canonical_description ELSE d.description END AS canonical_description,
    ac.asset_account_id AS account_id,
    an.full_name        AS account_name,
    an.type             AS account_type,
    ac.currency,
    round(wc.cat_score, 4)  AS score,
    round(wc.conf, 3)       AS confidence,
    wc.n_matches,
    jsonb_build_object(
      'name', wc.a_name, 'raw', wc.a_raw, 'amount', wc.a_amount, 'account', wc.a_account, 'time', wc.a_time,
      'n_matches', wc.n_matches, 'last_seen', wc.last_seen, 'alias', v_has_alias,
      'same_amount_count', wc.same_amount_count, 'same_account_count', wc.same_account_count,
      'modal_description', d.description
    ) AS factors
  FROM with_conf wc
  LEFT JOIN descs d ON d.category_id = wc.category_id AND d.drn = 1
  LEFT JOIN accts ac ON ac.category_id = wc.category_id AND ac.arn = 1
  LEFT JOIN account_names_hierarchical an ON an.id = ac.asset_account_id
  ORDER BY wc.rank
  LIMIT GREATEST(1, COALESCE(p_limit, 5));
END;
$$ LANGUAGE plpgsql STABLE;

NOTIFY pgrst, 'reload schema';

COMMIT;
