import { AuthError } from './errors';
import type { Env } from './types';

interface CachedJwt {
  jwt: string;
  exp: number;
}

// Isolate-lifetime only: createMcpHandler builds a fresh McpServer per request, so
// there is no durable session to attach a cache to. This Map survives only as long as
// the same warm V8 isolate is reused by the Workers runtime. Worst case on a cache miss
// is one extra login_with_token round-trip per tool call — acceptable at 2-user volume.
const jwtCache = new Map<string, CachedJwt>();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function decodeJwtExp(jwt: string): number {
  const payloadSegment = jwt.split('.')[1];
  if (!payloadSegment) throw new AuthError('Malformed JWT returned by login_with_token');
  const normalized = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
  const payload = JSON.parse(atob(normalized)) as { exp?: number };
  if (typeof payload.exp !== 'number') throw new AuthError('JWT returned by login_with_token has no exp claim');
  return payload.exp;
}

export async function getJwt(rawToken: string, env: Env, force = false): Promise<string> {
  const key = await sha256Hex(rawToken);
  const nowSec = Date.now() / 1000;

  if (!force) {
    const cached = jwtCache.get(key);
    if (cached && cached.exp > nowSec + 60) return cached.jwt;
  }

  const res = await fetch(`${env.POSTGREST_URL}/rpc/login_with_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: rawToken }),
  });

  if (!res.ok) {
    throw new AuthError('Invalid or revoked access token');
  }

  const jwt = (await res.json()) as string;
  jwtCache.set(key, { jwt, exp: decodeJwtExp(jwt) });
  return jwt;
}

export async function withAuthRetry(
  rawToken: string,
  env: Env,
  makeRequest: (jwt: string) => Promise<Response>
): Promise<Response> {
  const jwt = await getJwt(rawToken, env);
  const first = await makeRequest(jwt);
  if (first.status !== 401) return first;

  // Mirror the frontend's reactive-only re-login pattern (app/src/lib/api.ts): on a 401,
  // discard the cached JWT and force one re-exchange, then retry exactly once.
  const freshJwt = await getJwt(rawToken, env, true);
  return makeRequest(freshJwt);
}
