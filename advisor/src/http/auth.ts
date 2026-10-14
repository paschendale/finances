import { jwtVerify } from 'jose';
import type { Context, Next } from 'hono';

export interface Actor {
  id: string; // e.g. "web" (the app's JWT carries only role+exp)
  role: string;
}

export function makeAuth(jwtSecret: string) {
  const key = new TextEncoder().encode(jwtSecret);
  return async function auth(c: Context, next: Next) {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (c.req.query('access_token') ?? '');
    if (!token) return c.json({ error: 'missing bearer token' }, 401);
    try {
      const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
      if (payload.role !== 'authenticated') return c.json({ error: 'wrong role' }, 401);
      c.set('actor', { id: 'web', role: String(payload.role) } satisfies Actor);
      await next();
      return;
    } catch {
      return c.json({ error: 'invalid or expired token' }, 401);
    }
  };
}
