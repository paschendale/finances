/**
 * PostgREST client: raw finances token → JWT (login_with_token) with a process-lifetime cache,
 * one forced re-login on 401. Port of mcp-server/src/{auth,postgrest-client}.ts to Node.
 */
export class PostgrestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    message: string,
    public readonly details: string | null = null,
    public readonly hint: string | null = null,
  ) {
    super(message);
    this.name = 'PostgrestError';
  }
}

interface ErrorBody {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

function decodeJwtExp(jwt: string): number {
  const seg = jwt.split('.')[1];
  if (!seg) throw new PostgrestError(401, null, 'Malformed JWT from login_with_token');
  const payload = JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as {
    exp?: number;
  };
  if (typeof payload.exp !== 'number') throw new PostgrestError(401, null, 'JWT without exp');
  return payload.exp;
}

export interface PostgrestClient {
  rpc<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
  get<T = unknown>(view: string, params?: URLSearchParams, headers?: Record<string, string>): Promise<T>;
  patch<T = unknown>(table: string, params: URLSearchParams, body: Record<string, unknown>): Promise<T>;
  login(): Promise<string>;
}

export function createPostgrestClient(baseUrl: string, rawToken: string, fetchImpl: typeof fetch = fetch): PostgrestClient {
  const base = baseUrl.replace(/\/+$/, '');
  let cached: { jwt: string; exp: number } | null = null;

  async function login(force = false): Promise<string> {
    const now = Date.now() / 1000;
    if (!force && cached && cached.exp > now + 60) return cached.jwt;
    const res = await fetchImpl(`${base}/rpc/login_with_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rawToken }),
    });
    if (!res.ok) throw new PostgrestError(res.status, null, 'login_with_token failed: invalid or revoked FINANCES_TOKEN');
    const jwt = (await res.json()) as string;
    cached = { jwt, exp: decodeJwtExp(jwt) };
    return jwt;
  }

  async function withRetry(make: (jwt: string) => Promise<Response>): Promise<Response> {
    const first = await make(await login());
    if (first.status !== 401) return first;
    return make(await login(true));
  }

  async function parse<T>(res: Response): Promise<T> {
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    }
    let body: ErrorBody | null = null;
    try {
      body = (await res.json()) as ErrorBody;
    } catch {
      /* non-JSON */
    }
    throw new PostgrestError(res.status, body?.code ?? null, body?.message ?? res.statusText, body?.details ?? null, body?.hint ?? null);
  }

  return {
    login: () => login(),
    async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const res = await withRetry((jwt) =>
        fetchImpl(`${base}/rpc/${name}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
          body: JSON.stringify(args),
        }),
      );
      return parse<T>(res);
    },
    async get<T>(view: string, params = new URLSearchParams(), headers = {}): Promise<T> {
      const qs = params.toString();
      const res = await withRetry((jwt) =>
        fetchImpl(`${base}/${view}${qs ? `?${qs}` : ''}`, { headers: { Authorization: `Bearer ${jwt}`, ...headers } }),
      );
      return parse<T>(res);
    },
    async patch<T>(table: string, params: URLSearchParams, body: Record<string, unknown>): Promise<T> {
      const res = await withRetry((jwt) =>
        fetchImpl(`${base}/${table}?${params.toString()}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, Prefer: 'return=representation' },
          body: JSON.stringify(body),
        }),
      );
      return parse<T>(res);
    },
  };
}

export const op = {
  eq: (v: string) => `eq.${v}`,
  gte: (v: string) => `gte.${v}`,
  lte: (v: string) => `lte.${v}`,
  ilike: (v: string) => `ilike.*${v.replace(/[*,()]/g, ' ')}*`,
  inList: (values: string[]) => `in.(${values.join(',')})`,
  overlaps: (values: string[]) => `ov.{${values.join(',')}}`,
};
