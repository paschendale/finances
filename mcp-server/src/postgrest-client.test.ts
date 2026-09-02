import { afterEach, describe, expect, it, vi } from 'vitest';
import { callRpc, getView, op } from './postgrest-client';
import { PostgrestApiError } from './errors';
import type { Env, ToolCtx } from './types';

const env: Env = { POSTGREST_URL: 'http://localhost:3000' };

function makeJwt(): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 }));
  return `${header}.${payload}.signature`;
}

function ctxWithToken(): ToolCtx {
  return { rawToken: `token-${Math.random()}`, env };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('op', () => {
  it('produces the exact PostgREST operator strings used by the frontend', () => {
    expect(op.eq('abc')).toBe('eq.abc');
    expect(op.gte('2026-01-01')).toBe('gte.2026-01-01');
    expect(op.lte('2026-12-31')).toBe('lte.2026-12-31');
    expect(op.ilike('padaria')).toBe('ilike.*padaria*');
    expect(op.inList(['a', 'b'])).toBe('in.(a,b)');
    expect(op.overlaps(['a', 'b'])).toBe('ov.{a,b}');
  });
});

describe('callRpc / getView', () => {
  it('calls the RPC endpoint with the JWT bearer header and JSON body', async () => {
    const jwt = makeJwt();
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.includes('login_with_token')) return new Response(JSON.stringify(jwt), { status: 200 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    const ctx = ctxWithToken();
    const result = await callRpc(ctx, 'create_transaction', { p_date: '2026-01-01' });

    expect(result).toEqual({ ok: true });
    const rpcCall = calls.find((c) => c.url.includes('/rpc/create_transaction'));
    expect(rpcCall).toBeDefined();
    expect(rpcCall!.init?.method).toBe('POST');
    expect((rpcCall!.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${jwt}`);
    expect(rpcCall!.init?.body).toBe(JSON.stringify({ p_date: '2026-01-01' }));
  });

  it('calls the view endpoint with query params and the JWT bearer header', async () => {
    const jwt = makeJwt();
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.includes('login_with_token')) return new Response(JSON.stringify(jwt), { status: 200 });
        return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
      })
    );

    const ctx = ctxWithToken();
    const params = new URLSearchParams({ order: 'date.desc' });
    const result = await getView(ctx, 'account_balances', params);

    expect(result).toEqual([{ id: 1 }]);
    const viewCall = calls.find((c) => c.url.includes('/account_balances'));
    expect(viewCall!.url).toBe('http://localhost:3000/account_balances?order=date.desc');
    expect((viewCall!.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${jwt}`);
  });

  it('maps a PostgREST error body to PostgrestApiError', async () => {
    const jwt = makeJwt();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('login_with_token')) return new Response(JSON.stringify(jwt), { status: 200 });
        return new Response(
          JSON.stringify({
            code: 'P0001',
            message: 'Transaction is not balanced: SUM(amount_base) = 50.00',
            details: null,
            hint: null,
          }),
          { status: 400 }
        );
      })
    );

    const ctx = ctxWithToken();
    await expect(callRpc(ctx, 'create_transaction', {})).rejects.toMatchObject({
      code: 'P0001',
      message: 'Transaction is not balanced: SUM(amount_base) = 50.00',
      httpStatus: 400,
    });
  });

  it('falls back to a generic error when the error body is not JSON', async () => {
    const jwt = makeJwt();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('login_with_token')) return new Response(JSON.stringify(jwt), { status: 200 });
        return new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' });
      })
    );

    const ctx = ctxWithToken();
    const err = await callRpc(ctx, 'create_transaction', {}).catch((e) => e);
    expect(err).toBeInstanceOf(PostgrestApiError);
    expect((err as PostgrestApiError).httpStatus).toBe(500);
    expect((err as PostgrestApiError).code).toBeNull();
  });
});
