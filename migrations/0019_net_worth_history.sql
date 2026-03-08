-- Function to fetch Net Worth (Assets + Liabilities) history daily
CREATE OR REPLACE FUNCTION get_net_worth_history(p_start_date DATE, p_end_date DATE)
RETURNS TABLE (
    date DATE,
    net_worth NUMERIC,
    assets NUMERIC,
    liabilities NUMERIC
) AS $$
DECLARE
    v_initial_assets NUMERIC;
    v_initial_liabilities NUMERIC;
BEGIN
    -- 1. Get initial balances at p_start_date - 1
    SELECT COALESCE(SUM(balance), 0) INTO v_initial_assets 
    FROM get_balances_at((p_start_date - INTERVAL '1 day')::DATE) 
    WHERE account_type = 'asset';

    SELECT COALESCE(SUM(balance), 0) INTO v_initial_liabilities 
    FROM get_balances_at((p_start_date - INTERVAL '1 day')::DATE) 
    WHERE account_type = 'liability';

    -- 2. Return daily cumulative net worth
    RETURN QUERY
    WITH daily_changes AS (
        SELECT 
            t.date,
            SUM(CASE WHEN a.type = 'asset' THEN e.amount_base ELSE 0 END) as asset_change,
            SUM(CASE WHEN a.type = 'liability' THEN e.amount_base ELSE 0 END) as liability_change
        FROM transactions t
        JOIN entries e ON t.id = e.transaction_id
        JOIN accounts a ON e.account_id = a.id
        WHERE t.date >= p_start_date AND t.date <= p_end_date
        GROUP BY t.date
    ),
    all_dates AS (
        SELECT generate_series(p_start_date, p_end_date, '1 day')::DATE as date
    ),
    cumulative AS (
        SELECT 
            d.date,
            COALESCE(SUM(dc.asset_change) OVER (ORDER BY d.date), 0) as cum_asset_change,
            COALESCE(SUM(dc.liability_change) OVER (ORDER BY d.date), 0) as cum_liability_change
        FROM all_dates d
        LEFT JOIN daily_changes dc ON d.date = dc.date
    )
    SELECT 
        c.date,
        (v_initial_assets + c.cum_asset_change + v_initial_liabilities + c.cum_liability_change) as net_worth,
        (v_initial_assets + c.cum_asset_change) as assets,
        (v_initial_liabilities + c.cum_liability_change) as liabilities
    FROM cumulative c
    ORDER BY c.date;
END;
$$ LANGUAGE plpgsql;
