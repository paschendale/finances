import { describe, expect, it } from 'vitest';
import worker from './index';
import type { Env } from './types';

const env: Env = { POSTGREST_URL: 'http://localhost:3000' };
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

describe('index.ts request gate', () => {
  it('rejects /mcp with 401 when no Authorization header is present', async () => {
    const request = new Request('https://example.com/mcp', { method: 'POST' });
    const res = await worker.fetch(request, env, ctx);
    expect(res.status).toBe(401);
  });

  it('rejects /mcp with 401 when the Authorization header is not a well-formed Bearer token', async () => {
    const request = new Request('https://example.com/mcp', {
      method: 'POST',
      headers: { Authorization: 'Basic somecreds' },
    });
    const res = await worker.fetch(request, env, ctx);
    expect(res.status).toBe(401);
  });

  it('rejects /mcp with 401 when the Bearer token is empty', async () => {
    const request = new Request('https://example.com/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer    ' },
    });
    const res = await worker.fetch(request, env, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 404 for any path other than /mcp, before the auth gate', async () => {
    const request = new Request('https://example.com/other', { method: 'GET' });
    const res = await worker.fetch(request, env, ctx);
    expect(res.status).toBe(404);
  });
});
