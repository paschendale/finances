import { Hono } from 'hono';
import type { AppContext } from '../../context.js';
import type { Actor } from '../auth.js';
import { many } from '../../db/client.js';
import { reconciliationDetail, reconciliationHistory } from '../../plan/reconcile.js';

type Env = { Variables: { actor: Actor } };

/** Read endpoints the web app uses for the Accounts cards and Ledger glyph details. */
export function accountRoutes(ctx: AppContext): Hono<Env> {
  const app = new Hono<Env>();

  app.get('/accounts/reconciliation-status', async (c) => {
    const rows = await many(
      ctx.db,
      `SELECT s.*, h.full_name AS account_name, a.last_checked FROM account_reconciliation_status s
       JOIN account_names_hierarchical h ON h.id = s.account_id JOIN accounts a ON a.id = s.account_id
       ORDER BY h.full_name`,
    );
    return c.json(rows);
  });

  app.get('/accounts/:id/reconciliations', async (c) => c.json(await reconciliationHistory(ctx.db, c.req.param('id'), Number(c.req.query('limit') ?? 12))));

  app.get('/reconciliations/:id', async (c) => {
    const r = await reconciliationDetail(ctx.db, c.req.param('id'));
    if (!r) return c.json({ error: 'not found' }, 404);
    return c.json(r);
  });

  app.get('/stats', async (c) => {
    const row = await many(
      ctx.db,
      `SELECT (SELECT count(*) FROM advisor_plans WHERE status = 'pending_approval')::int AS pending_plans,
              (SELECT count(*) FROM advisor_conversations WHERE status = 'active')::int AS active_conversations,
              (SELECT count(*) FROM advisor_statements WHERE status IN ('received','parsed'))::int AS statements_waiting`,
    );
    return c.json(row[0] ?? {});
  });

  return app;
}
