/** Minimal Gmail REST client: refresh-token flow, history walker, message + attachment fetch. */
export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  historyId?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: { headers?: GmailHeader[]; parts?: GmailPart[]; mimeType?: string; filename?: string; body?: GmailPart['body'] };
}

export interface GmailAttachmentRef {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

export class GmailClient {
  private token: { value: string; exp: number } | null = null;

  constructor(
    private readonly cfg: GmailConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: this.cfg.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`gmail token refresh failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      const err = new Error(`gmail ${path.split('?')[0]} → ${res.status}: ${(await res.text()).slice(0, 300)}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as T;
  }

  async profile(): Promise<{ emailAddress: string; historyId: string }> {
    return this.api('profile');
  }

  async listMessageIds(q: string, max = 50): Promise<string[]> {
    const j = await this.api<{ messages?: Array<{ id: string }> }>(`messages?q=${encodeURIComponent(q)}&maxResults=${max}`);
    return (j.messages ?? []).map((m) => m.id);
  }

  /** Message ids added since historyId. Returns null when the history id is too old (404) → caller resyncs. */
  async messagesSince(startHistoryId: string): Promise<{ ids: string[]; historyId: string } | null> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let latest = startHistoryId;
    try {
      do {
        const qs = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', maxResults: '500' });
        if (pageToken) qs.set('pageToken', pageToken);
        const j = await this.api<{ history?: Array<{ id: string; messagesAdded?: Array<{ message: { id: string } }> }>; nextPageToken?: string; historyId?: string }>(
          `history?${qs.toString()}`,
        );
        for (const h of j.history ?? []) for (const a of h.messagesAdded ?? []) ids.add(a.message.id);
        if (j.historyId) latest = j.historyId;
        pageToken = j.nextPageToken;
      } while (pageToken);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
    return { ids: [...ids], historyId: latest };
  }

  async getMessage(id: string): Promise<GmailMessage> {
    return this.api(`messages/${id}?format=full`);
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const j = await this.api<{ data: string }>(`messages/${messageId}/attachments/${attachmentId}`);
    return Buffer.from(j.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }

  async ensureLabel(name: string): Promise<string | null> {
    try {
      const j = await this.api<{ labels: Array<{ id: string; name: string }> }>('labels');
      const found = j.labels.find((l) => l.name === name);
      if (found) return found.id;
      const created = await this.api<{ id: string }>('labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
      });
      return created.id;
    } catch {
      return null; // readonly scope: labels are optional
    }
  }

  async addLabel(messageId: string, labelId: string): Promise<void> {
    try {
      await this.api(`messages/${messageId}/modify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addLabelIds: [labelId] }) });
    } catch {
      /* optional */
    }
  }
}

export function header(m: GmailMessage, name: string): string | null {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

export function attachments(m: GmailMessage): GmailAttachmentRef[] {
  const out: GmailAttachmentRef[] = [];
  const walk = (p?: GmailPart) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) out.push({ filename: p.filename, mimeType: p.mimeType ?? 'application/octet-stream', attachmentId: p.body.attachmentId, size: p.body.size ?? 0 });
    for (const c of p.parts ?? []) walk(c);
  };
  walk(m.payload as GmailPart | undefined);
  return out;
}

export function senderAddress(from: string | null): string | null {
  if (!from) return null;
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1]! : from).trim().toLowerCase();
}
