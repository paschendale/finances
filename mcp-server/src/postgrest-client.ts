import { withAuthRetry } from './auth';
import { PostgrestApiError } from './errors';
import type { ToolCtx } from './types';

interface PostgrestErrorBody {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

async function parseOrThrow<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;

  let body: PostgrestErrorBody | null = null;
  try {
    body = (await res.json()) as PostgrestErrorBody;
  } catch {
    // non-JSON error body — fall through with nulls
  }

  throw new PostgrestApiError(
    body?.code ?? null,
    body?.message ?? res.statusText ?? 'PostgREST request failed',
    body?.details ?? null,
    body?.hint ?? null,
    res.status
  );
}

export async function callRpc<T>(ctx: ToolCtx, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await withAuthRetry(ctx.rawToken, ctx.env, (jwt) =>
    fetch(`${ctx.env.POSTGREST_URL}/rpc/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(args),
    })
  );
  return parseOrThrow<T>(res);
}

export async function getView<T>(ctx: ToolCtx, view: string, params: URLSearchParams = new URLSearchParams()): Promise<T> {
  const qs = params.toString();
  const res = await withAuthRetry(ctx.rawToken, ctx.env, (jwt) =>
    fetch(`${ctx.env.POSTGREST_URL}/${view}${qs ? `?${qs}` : ''}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
  );
  return parseOrThrow<T>(res);
}

// Mirrors the ad-hoc PostgREST operator strings app/src/lib/api.ts already builds per-endpoint.
export const op = {
  eq: (v: string) => `eq.${v}`,
  gte: (v: string) => `gte.${v}`,
  lte: (v: string) => `lte.${v}`,
  ilike: (v: string) => `ilike.*${v}*`,
  inList: (values: string[]) => `in.(${values.join(',')})`,
  overlaps: (values: string[]) => `ov.{${values.join(',')}}`,
};
