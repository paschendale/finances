import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve, type ServerType } from '@hono/node-server';
import { ZodError } from 'zod';
import type { AppContext } from '../context.js';
import { makeAuth, type Actor } from './auth.js';
import { chatRoutes } from './routes/chat.js';
import { planRoutes } from './routes/plans.js';
import { uploadRoutes } from './routes/uploads.js';
import { healthRoutes } from './routes/health.js';
import { accountRoutes } from './routes/accounts.js';
import { scoped } from '../log.js';

const log = scoped('http');

type Env = { Variables: { actor: Actor } };

/** PUBLIC_WEB_ORIGINS entries: exact origins, `*`, or `https://*.example.pages.dev` (one wildcard label). */
export function originMatcher(pattern: string): (origin: string) => boolean {
  if (pattern === '*') return () => true;
  if (!pattern.includes('*')) return (o) => o === pattern;
  const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9-]+') + '$', 'i');
  return (o) => re.test(o);
}

export function createHttpApp(ctx: AppContext): Hono<Env> {
  const app = new Hono<Env>();
  const allowed = ctx.config.webOrigins.map((o) => originMatcher(o));
  app.use(
    '*',
    cors({
      origin: (origin) => (allowed.some((m) => m(origin)) ? origin : ''),
      allowHeaders: ['Authorization', 'Content-Type'],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  );
  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: 'invalid request', issues: err.issues }, 400);
    log.error({ err, path: c.req.path }, 'request failed');
    return c.json({ error: (err as Error).message ?? 'internal error' }, 500);
  });
  app.route('/', healthRoutes(ctx));
  const api = new Hono<Env>();
  api.use('*', makeAuth(ctx.config.JWT_SECRET));
  api.route('/', chatRoutes(ctx));
  api.route('/', planRoutes(ctx));
  api.route('/', uploadRoutes(ctx));
  api.route('/', accountRoutes(ctx));
  app.route('/', api);
  return app;
}

export function startHttpServer(ctx: AppContext): ServerType {
  const app = createHttpApp(ctx);
  return serve({ fetch: app.fetch, port: ctx.config.PORT, hostname: '0.0.0.0' }, (info) => {
    log.info({ port: info.port }, 'HTTP API listening');
  });
}
