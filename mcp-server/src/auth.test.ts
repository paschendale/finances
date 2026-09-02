import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJwt, sha256Hex, withAuthRetry } from './auth';
import type { Env } from './types';

const env: Env = { POSTGREST_URL: 'http://localhost:3000' };

function makeJwt(expiresInSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ role: 'authenticated', exp: Math.floor(Date.now() / 1000) + expiresInSeconds }));
  return `${header}.${payload}.signature`;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sha256Hex', () => {
  it('matches a known SHA-256 test vector', async () => {
    // sha256("abc") — standard NIST test vector
    await expect(sha256Hex('abc')).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('getJwt', () => {
  it('fetches and caches a JWT, then serves subsequent calls from cache', async () => {
    const rawToken = `unique-token-${Math.random()}`;
    const jwt = makeJwt(7 * 24 * 60 * 60);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(jwt), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await getJwt(rawToken, env);
    expect(first).toBe(jwt);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Reuse the same raw token — should hit cache, not fetch again.
    const second = await getJwt(rawToken, env);
    expect(second).toBe(jwt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the cached JWT is expired', async () => {
    const rawToken = `expiring-token-${Math.random()}`;
    const soonExpiredJwt = makeJwt(1); // expires within the 60s safety window
    const freshJwt = makeJwt(7 * 24 * 60 * 60);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(soonExpiredJwt), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(freshJwt), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await getJwt(rawToken, env);
    expect(first).toBe(soonExpiredJwt);

    const second = await getJwt(rawToken, env);
    expect(second).toBe(freshJwt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws AuthError when login_with_token rejects the token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('invalid or revoked token', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getJwt(`bad-token-${Math.random()}`, env)).rejects.toThrow('Invalid or revoked access token');
  });
});

describe('withAuthRetry', () => {
  it('retries exactly once on a 401 and does not loop if the retry also 401s', async () => {
    const rawToken = `retry-token-${Math.random()}`;
    const jwt = makeJwt(7 * 24 * 60 * 60);
    // A fresh Response per call — Response bodies can only be read once, and getJwt is
    // expected to call this twice (initial exchange + forced re-exchange after the 401).
    const loginMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(jwt), { status: 200 })));
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('login_with_token')) return loginMock();
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const makeRequest = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const res = await withAuthRetry(rawToken, env, makeRequest);

    expect(res.status).toBe(401);
    expect(makeRequest).toHaveBeenCalledTimes(2); // initial + exactly one retry
    expect(loginMock).toHaveBeenCalledTimes(2); // initial exchange + forced re-exchange
  });

  it('returns the successful response without retrying when the first call succeeds', async () => {
    const rawToken = `ok-token-${Math.random()}`;
    const jwt = makeJwt(7 * 24 * 60 * 60);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(jwt), { status: 200 })));

    const makeRequest = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const res = await withAuthRetry(rawToken, env, makeRequest);

    expect(res.status).toBe(200);
    expect(makeRequest).toHaveBeenCalledTimes(1);
  });
});
