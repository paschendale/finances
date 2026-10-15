import { randomBytes } from 'node:crypto';

export interface McpSession {
  token: string;
  conversationId: string;
  actor: string | null;
  createdAt: number;
  expiresAt: number;
}

/** Per-run bearer tokens for the local MCP server; each maps to one conversation. */
export class McpTokenRegistry {
  private byToken = new Map<string, McpSession>();

  mint(conversationId: string, actor: string | null, ttlMs = 2 * 3_600_000): McpSession {
    const token = randomBytes(24).toString('base64url');
    const s: McpSession = { token, conversationId, actor, createdAt: Date.now(), expiresAt: Date.now() + ttlMs };
    this.byToken.set(token, s);
    return s;
  }

  resolve(token: string): McpSession | null {
    const s = this.byToken.get(token);
    if (!s) return null;
    if (s.expiresAt < Date.now()) {
      this.byToken.delete(token);
      return null;
    }
    return s;
  }

  revoke(token: string): void {
    this.byToken.delete(token);
  }

  sweep(): void {
    const now = Date.now();
    for (const [t, s] of this.byToken) if (s.expiresAt < now) this.byToken.delete(t);
  }
}
