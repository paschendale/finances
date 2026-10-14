-- Migration 0050: derived, multi-factor classification (docs/ADVISOR.md §21)
--
-- Category suggestions are computed from the ledger itself at query time instead of being
-- read from the stored description_memories table. The only learned fact is
-- merchant_aliases: raw statement text → the short name the household uses.
--
--   merchant_aliases                 raw_normalized → canonical_description (+ last category)
--   normalize_merchant(text)         normalize_text + processor prefixes, legal suffixes, markers
--   transaction_lines                one row per category entry with its asset counterpart
--   classify_candidates(...)         ranked categories with per-factor evidence
--   match_description_memory(text)   thin wrapper over classify_candidates, same old shape
--   description_memories_with_names  derived aggregate over transaction_lines, same columns
--   learn_from_transaction(uuid)     alias upsert + last-used settings, used by the RPCs
--   create_transaction / update_transaction  stop writing description_memories
--
-- description_memories stays in place (never dropped) but is no longer written.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ---------------------------------------------------------------------------
-- merchant_aliases
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchant_aliases (
  raw_normalized        TEXT PRIMARY KEY,
  canonical_description TEXT NOT NULL,
  account_id            UUID REFERENCES accounts(id) ON DELETE SET NULL,
  source                TEXT NOT NULL DEFAULT 'plan' CHECK (source IN ('plan', 'manual', 'import')),
  hits                  INTEGER NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON merchant_aliases TO authenticated;

-- ---------------------------------------------------------------------------
-- normalize_merchant
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION normalize_merchant(p_input TEXT)
RETURNS TEXT AS $$
DECLARE
  s TEXT;
BEGIN
  IF p_input IS NULL THEN RETURN NULL; END IF;
  s := lower(unaccent(p_input));
  s := regexp_replace(s, '\s+', ' ', 'g');
  s := trim(s);
  -- processor / bank prefixes
  s := regexp_replace(s, '^(transferencia (enviada|recebida) pelo pix\s*-?\s*)', '', 'g');
  s := regexp_replace(s, '^(compra no (debito|credito)\s*-?\s*)', '', 'g');
  s := regexp_replace(s, '^(pagamento (de )?(boleto|fatura)\s*-?\s*)', '', 'g');
  s := regexp_replace(s, '^(pg\s*\*|pag\s*\*|mp\s*\*|mercadopago\s*\*|ifd\s*\*|uber\s*\*|ebn\s*\*|dl\s*\*|zul\s*\*|rec\s*\*|pix\s+)\s*', '', 'g');
  s := regexp_replace(s, '^(cielo|rede|getnet|stone|pagseguro|picpay)\s*\*\s*', '', 'g');
  -- installment markers: 3/6, 03/06, (3 de 6), parcela 3/6
  s := regexp_replace(s, '\(?\yparcela\s*\d{1,2}\s*(/|de)\s*\d{1,2}\)?', ' ', 'g');
  s := regexp_replace(s, '\(\s*\d{1,2}\s*de\s*\d{1,2}\s*\)', ' ', 'g');
  s := regexp_replace(s, '\y\d{1,2}\s*/\s*\d{1,2}\y', ' ', 'g');
  -- legal suffixes
  s := regexp_replace(s, '\y(ltda|me|epp|eireli|s\.?/?a\.?|sa|ltda\.?|cia)\y\.?', ' ', 'g');
  -- trailing UF code (optionally preceded by a dash)
  s := regexp_replace(s, '\s*-?\s+\y(ac|al|ap|am|ba|ce|df|es|go|ma|mt|ms|mg|pa|pb|pr|pe|pi|rj|rn|rs|ro|rr|sc|sp|se|to)\y\s*$', ' ', 'g');
  -- trailing digits / codes (store numbers, authorisation ids)
  s := regexp_replace(s, '(\s+\d+)+\s*$', ' ', 'g');
  s := regexp_replace(s, '[^a-z0-9 ]', ' ', 'g');
  s := regexp_replace(s, '\s+', ' ', 'g');
  RETURN trim(s);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

GRANT EXECUTE ON FUNCTION normalize_merchant(TEXT) TO authenticated;

-- normalize_text (0025) is a thin plpgsql wrapper; mark it immutable so views and indexes can use it.
CREATE OR REPLACE FUNCTION normalize_text(p_input TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN trim(regexp_replace(lower(unaccent(p_input)), '[^a-z0-9 ]', '', 'g'));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION safe_timestamptz(p_input TEXT)
RETURNS TIMESTAMPTZ AS $$
BEGIN
  RETURN p_input::timestamptz;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- transaction_lines: the classifier's only input
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW transaction_lines AS
SELECT
  e.id                                   AS entry_id,
  t.id                                   AS transaction_id,
  t.date,
  t.created_at,
  t.description,
  normalize_text(t.description)          AS norm_description,
  t.metadata #>> '{statement_line,raw}'  AS raw,
  CASE WHEN t.metadata #>> '{statement_line,raw}' IS NOT NULL
       THEN normalize_merchant(t.metadata #>> '{statement_line,raw}') END AS norm_raw,
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

GRANT SELECT ON transaction_lines TO authenticated;

-- ---------------------------------------------------------------------------
-- classifier weights (editable without a migration)
-- ---------------------------------------------------------------------------
INSERT INTO global_settings (key, value)
VALUES ('classifier_weights',
        '{"name":0.40,"raw":0.20,"amount":0.15,"account":0.10,"time":0.10,"history_months":24,"k":8}')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- classify_candidates
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS classify_candidates(TEXT, NUMERIC, UUID, DATE, TIMESTAMPTZ, TEXT, INT);

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

GRANT EXECUTE ON FUNCTION classify_candidates(TEXT, NUMERIC, UUID, DATE, TIMESTAMPTZ, TEXT, INT) TO authenticated;

-- ---------------------------------------------------------------------------
-- match_description_memory: same shape as before, derived from classify_candidates
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_description_memory(p_input TEXT)
RETURNS TABLE (
  description   TEXT,
  category_id   UUID,
  category_name TEXT,
  category_type TEXT,
  account_id    UUID,
  account_name  TEXT,
  account_type  TEXT,
  currency      TEXT,
  similarity    REAL,
  score         REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.canonical_description,
    c.category_id,
    c.category_name,
    c.category_type,
    c.account_id,
    c.account_name,
    c.account_type,
    c.currency,
    COALESCE((c.factors->>'name')::real, 0) AS similarity,
    c.confidence::real AS score
  FROM classify_candidates(p_input, NULL, NULL, NULL, NULL, NULL, 5) c;
END;
$$ LANGUAGE plpgsql STABLE;

GRANT EXECUTE ON FUNCTION match_description_memory(TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- description_memories_with_names: derived aggregate, same columns as 0027
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS description_memories_with_names;
CREATE VIEW description_memories_with_names AS
WITH combos AS (
  SELECT
    tl.norm_description,
    tl.description,
    tl.category_id,
    tl.asset_account_id,
    tl.currency,
    count(*)        AS n,
    max(tl.date)    AS last_date,
    max(tl.created_at) AS last_created
  FROM transaction_lines tl
  WHERE tl.norm_description <> ''
  GROUP BY tl.norm_description, tl.description, tl.category_id, tl.asset_account_id, tl.currency
),
ranked AS (
  SELECT
    c.*,
    row_number() OVER (PARTITION BY c.norm_description ORDER BY c.n DESC, c.last_date DESC, length(c.description)) AS rn,
    sum(c.n)        OVER (PARTITION BY c.norm_description) AS total_n,
    max(c.last_date) OVER (PARTITION BY c.norm_description) AS last_used,
    max(c.last_created) OVER (PARTITION BY c.norm_description) AS last_created_any
  FROM combos c
)
SELECT
  r.description,
  r.norm_description      AS normalized_description,
  r.category_id,
  cat.full_name           AS category_name,
  cat.type                AS category_type,
  r.asset_account_id      AS account_id,
  acc.full_name           AS account_name,
  acc.type                AS account_type,
  r.currency,
  r.total_n::int          AS usage_count,
  r.last_used::timestamptz AS last_used_at,
  r.last_created_any      AS updated_at
FROM ranked r
LEFT JOIN account_names_hierarchical cat ON cat.id = r.category_id
LEFT JOIN account_names_hierarchical acc ON acc.id = r.asset_account_id
WHERE r.rn = 1;

GRANT SELECT ON description_memories_with_names TO authenticated;

-- ---------------------------------------------------------------------------
-- learn_from_transaction: alias upsert + last-used settings (replaces the memory block)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION learn_from_transaction(p_transaction_id UUID)
RETURNS VOID AS $$
DECLARE
  v_category_id UUID;
  v_account_id  UUID;
  v_currency    TEXT;
  v_description TEXT;
  v_raw         TEXT;
  v_raw_norm    TEXT;
BEGIN
  SELECT t.description, t.metadata #>> '{statement_line,raw}'
  INTO v_description, v_raw
  FROM transactions t WHERE t.id = p_transaction_id;

  SELECT e.account_id INTO v_category_id
  FROM entries e JOIN accounts a ON e.account_id = a.id
  WHERE e.transaction_id = p_transaction_id AND a.type IN ('expense', 'income')
  LIMIT 1;
  IF v_category_id IS NULL THEN
    SELECT e.account_id INTO v_category_id
    FROM entries e WHERE e.transaction_id = p_transaction_id AND e.amount > 0 LIMIT 1;
  END IF;

  SELECT e.account_id, e.currency INTO v_account_id, v_currency
  FROM entries e JOIN accounts a ON e.account_id = a.id
  WHERE e.transaction_id = p_transaction_id
    AND a.type IN ('asset', 'liability', 'equity')
    AND e.account_id != COALESCE(v_category_id, '00000000-0000-0000-0000-000000000000'::UUID)
  ORDER BY (e.amount < 0) DESC
  LIMIT 1;
  IF v_account_id IS NULL THEN
    SELECT e.account_id, e.currency INTO v_account_id, v_currency
    FROM entries e
    WHERE e.transaction_id = p_transaction_id AND e.amount < 0
      AND e.account_id != COALESCE(v_category_id, '00000000-0000-0000-0000-000000000000'::UUID)
    LIMIT 1;
  END IF;

  IF v_raw IS NOT NULL AND v_description IS NOT NULL THEN
    v_raw_norm := normalize_merchant(v_raw);
    IF v_raw_norm <> '' AND normalize_text(v_description) <> '' THEN
      INSERT INTO merchant_aliases (raw_normalized, canonical_description, account_id, source)
      VALUES (v_raw_norm, v_description, v_category_id, 'plan')
      ON CONFLICT (raw_normalized) DO UPDATE SET
        canonical_description = EXCLUDED.canonical_description,
        account_id = COALESCE(EXCLUDED.account_id, merchant_aliases.account_id),
        hits = merchant_aliases.hits + 1,
        updated_at = now();
    END IF;
  END IF;

  IF v_account_id IS NOT NULL THEN
    INSERT INTO global_settings (key, value, updated_at)
    VALUES ('last_used_account_id', v_account_id::TEXT, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END IF;
  IF v_currency IS NOT NULL THEN
    INSERT INTO global_settings (key, value, updated_at)
    VALUES ('last_used_currency', v_currency, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- create_transaction / update_transaction without description_memories writes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_transaction(
  p_date DATE,
  p_description TEXT,
  p_entries JSONB,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB AS $$
DECLARE
  v_transaction_id UUID;
  v_entry JSONB;
  v_total_amount_base NUMERIC := 0;
  v_entry_count INTEGER := 0;
  v_result JSONB;
BEGIN
  INSERT INTO transactions (date, description, metadata)
  VALUES (p_date, p_description, COALESCE(p_metadata, '{}'::jsonb))
  RETURNING id INTO v_transaction_id;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
  LOOP
    INSERT INTO entries (transaction_id, account_id, amount, currency, exchange_rate, amount_base)
    VALUES (
      v_transaction_id,
      (v_entry->>'account_id')::UUID,
      (v_entry->>'amount')::NUMERIC,
      (v_entry->>'currency')::TEXT,
      COALESCE((v_entry->>'exchange_rate')::NUMERIC, 1.0),
      (v_entry->>'amount_base')::NUMERIC
    );
    v_total_amount_base := v_total_amount_base + (v_entry->>'amount_base')::NUMERIC;
    v_entry_count := v_entry_count + 1;
  END LOOP;

  IF v_entry_count < 2 THEN
    RAISE EXCEPTION 'Transaction must have at least two entries';
  END IF;
  IF v_total_amount_base <> 0 THEN
    RAISE EXCEPTION 'Transaction is not balanced: SUM(amount_base) = %', v_total_amount_base;
  END IF;

  PERFORM learn_from_transaction(v_transaction_id);

  SELECT jsonb_build_object(
    'id', t.id,
    'date', t.date,
    'description', t.description,
    'metadata', t.metadata,
    'entries', (SELECT jsonb_agg(e.*) FROM entries e WHERE e.transaction_id = t.id)
  ) INTO v_result
  FROM transactions t WHERE t.id = v_transaction_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION create_transaction(DATE, TEXT, JSONB, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION update_transaction(
  p_id UUID,
  p_date DATE,
  p_description TEXT,
  p_entries JSONB,
  p_metadata JSONB DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_entry JSONB;
  v_total_amount_base NUMERIC := 0;
  v_entry_count INTEGER := 0;
  v_result JSONB;
BEGIN
  UPDATE transactions
  SET date = p_date,
      description = p_description,
      metadata = CASE WHEN p_metadata IS NULL THEN metadata ELSE COALESCE(metadata, '{}'::jsonb) || p_metadata END,
      updated_at = now()
  WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction with ID % not found', p_id;
  END IF;

  DELETE FROM entries WHERE transaction_id = p_id;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
  LOOP
    INSERT INTO entries (transaction_id, account_id, amount, currency, exchange_rate, amount_base)
    VALUES (
      p_id,
      (v_entry->>'account_id')::UUID,
      (v_entry->>'amount')::NUMERIC,
      (v_entry->>'currency')::TEXT,
      COALESCE((v_entry->>'exchange_rate')::NUMERIC, 1.0),
      (v_entry->>'amount_base')::NUMERIC
    );
    v_total_amount_base := v_total_amount_base + (v_entry->>'amount_base')::NUMERIC;
    v_entry_count := v_entry_count + 1;
  END LOOP;

  IF v_entry_count < 2 THEN
    RAISE EXCEPTION 'Transaction must have at least two entries';
  END IF;
  IF v_total_amount_base <> 0 THEN
    RAISE EXCEPTION 'Transaction is not balanced: SUM(amount_base) = %', v_total_amount_base;
  END IF;

  PERFORM learn_from_transaction(p_id);

  SELECT jsonb_build_object(
    'id', t.id,
    'date', t.date,
    'description', t.description,
    'metadata', t.metadata,
    'entries', (
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.id,
        'account_id', e.account_id,
        'account_name', a.full_name,
        'account_type', a.type,
        'amount', e.amount,
        'currency', e.currency,
        'exchange_rate', e.exchange_rate,
        'amount_base', e.amount_base,
        'created_at', e.created_at
      ) ORDER BY e.created_at DESC)
      FROM entries e
      JOIN account_names_hierarchical a ON e.account_id = a.id
      WHERE e.transaction_id = t.id
    )
  ) INTO v_result
  FROM transactions t WHERE t.id = p_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION update_transaction(UUID, DATE, TEXT, JSONB, JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
