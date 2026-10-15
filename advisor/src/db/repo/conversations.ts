import type { Queryable } from '../client.js';
import { many, maybeOne, one } from '../client.js';
import type { Conversation, ConversationChannel, Message, MessageRole, MessageStatus, Attachment } from '../types.js';

export async function createConversation(
  q: Queryable,
  input: { channel: ConversationChannel; title?: string; external_ref?: string | null; created_by?: string | null; model?: string | null },
): Promise<Conversation> {
  return one<Conversation>(
    q,
    `INSERT INTO advisor_conversations (channel, title, external_ref, created_by, model)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.channel, input.title ?? 'Conversation', input.external_ref ?? null, input.created_by ?? null, input.model ?? null],
  );
}

export async function getConversation(q: Queryable, id: string): Promise<Conversation | null> {
  return maybeOne<Conversation>(q, 'SELECT * FROM advisor_conversations WHERE id = $1', [id]);
}

export async function findConversationByExternalRef(q: Queryable, channel: ConversationChannel, ref: string): Promise<Conversation | null> {
  return maybeOne<Conversation>(q, 'SELECT * FROM advisor_conversations WHERE channel = $1 AND external_ref = $2 ORDER BY created_at DESC LIMIT 1', [
    channel,
    ref,
  ]);
}

export interface ConversationListRow extends Conversation {
  pending_plans: number;
  last_message: string | null;
  last_message_role: MessageRole | null;
  statement_count: number;
  /** A Gmail statement is parsed here and its planning turn has not run yet */
  waiting_turn: boolean;
}

export async function listConversations(q: Queryable, opts: { includeArchived?: boolean; limit?: number } = {}): Promise<ConversationListRow[]> {
  return many<ConversationListRow>(
    q,
    `SELECT c.*,
            (SELECT count(*) FROM advisor_plans p WHERE p.conversation_id = c.id AND p.status = 'pending_approval')::int AS pending_plans,
            (SELECT m.content FROM advisor_messages m WHERE m.conversation_id = c.id AND m.role IN ('user','assistant') ORDER BY m.created_at DESC LIMIT 1) AS last_message,
            (SELECT m.role FROM advisor_messages m WHERE m.conversation_id = c.id AND m.role IN ('user','assistant') ORDER BY m.created_at DESC LIMIT 1) AS last_message_role,
            (SELECT count(*) FROM advisor_statements s WHERE s.conversation_id = c.id)::int AS statement_count,
            EXISTS (
              SELECT 1 FROM advisor_statements s WHERE s.conversation_id = c.id AND s.source = 'gmail' AND s.status IN ('parsed','failed')
                AND NOT EXISTS (SELECT 1 FROM advisor_plans p WHERE p.statement_id = s.id)
                AND (c.channel = 'system' OR NOT EXISTS (SELECT 1 FROM advisor_messages m WHERE m.conversation_id = c.id AND m.role = 'user' AND m.created_at > s.created_at))
            ) AS waiting_turn
     FROM advisor_conversations c
     WHERE ($1::bool OR c.status = 'active')
     ORDER BY c.last_activity_at DESC
     LIMIT $2`,
    [opts.includeArchived ?? true, opts.limit ?? 200],
  );
}

export async function updateConversation(
  q: Queryable,
  id: string,
  patch: Partial<Pick<Conversation, 'title' | 'claude_session_id' | 'model' | 'summary' | 'status' | 'external_ref' | 'prompt_hash'>>,
): Promise<Conversation> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (sets.length === 0) return one<Conversation>(q, 'SELECT * FROM advisor_conversations WHERE id = $1', [id]);
  vals.push(id);
  return one<Conversation>(q, `UPDATE advisor_conversations SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
}

export async function touchConversation(q: Queryable, id: string): Promise<void> {
  await q.query('UPDATE advisor_conversations SET last_activity_at = now() WHERE id = $1', [id]);
}

export async function addMessage(
  q: Queryable,
  input: { conversation_id: string; role: MessageRole; content: string; attachments?: Attachment[]; status?: MessageStatus },
): Promise<Message> {
  const m = await one<Message>(
    q,
    `INSERT INTO advisor_messages (conversation_id, role, content, attachments, status)
     VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING *`,
    [input.conversation_id, input.role, input.content, JSON.stringify(input.attachments ?? []), input.status ?? 'done'],
  );
  await touchConversation(q, input.conversation_id);
  return m;
}

export async function updateMessage(q: Queryable, id: string, patch: { content?: string; status?: MessageStatus }): Promise<Message> {
  return one<Message>(
    q,
    `UPDATE advisor_messages SET content = COALESCE($2, content), status = COALESCE($3, status) WHERE id = $1 RETURNING *`,
    [id, patch.content ?? null, patch.status ?? null],
  );
}

export async function listMessages(q: Queryable, conversationId: string, limit = 500): Promise<Message[]> {
  return many<Message>(q, 'SELECT * FROM advisor_messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT $2', [conversationId, limit]);
}
