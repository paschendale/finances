import { createMcpHandler } from 'agents/mcp/server';
import { createServer } from './server';
import type { Env } from './types';

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404 });
    }

    const rawToken = extractBearerToken(request);
    if (!rawToken) {
      return new Response('Unauthorized: missing bearer token', { status: 401 });
    }

    // Built fresh per request: env is only available inside this fetch handler, and
    // McpRequestContext (what createMcpHandler's factory receives) carries neither env
    // nor a guaranteed request reference, so both env and the raw token are threaded in
    // via this closure rather than read back out of the factory's context argument.
    const handler = createMcpHandler(() => createServer({ rawToken, env }), { route: '/mcp' });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
