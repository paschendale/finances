import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { PostgrestClient } from './postgrest/client.js';
import type { Bus } from './events.js';
import type { McpTokenRegistry } from './mcp/tokens.js';
import type { SessionPool, ConversationLocks } from './claude/pool.js';
import type { SessionManager } from './claude/session.js';
import type { Notifier } from './notify.js';
import type { GmailSync } from './gmail/sync.js';

export interface AppContext {
  config: Config;
  db: Db;
  pg: PostgrestClient;
  bus: Bus;
  mcpTokens: McpTokenRegistry;
  pool: SessionPool;
  locks: ConversationLocks;
  sessions: SessionManager;
  notifier: Notifier;
  promptsDir: string;
  /** Set when the gmail channel is enabled (manual pick-up endpoints) */
  gmail?: GmailSync;
}
