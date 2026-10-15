import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createPool } from './db/client.js';
import { createPostgrestClient } from './postgrest/client.js';
import { Bus } from './events.js';
import { McpTokenRegistry } from './mcp/tokens.js';
import { ConversationLocks, SessionPool } from './claude/pool.js';
import { SessionManager } from './claude/session.js';
import { Notifier } from './notify.js';
import type { AppContext } from './context.js';
import { startMcpServer } from './mcp/server.js';
import { startHttpServer } from './http/server.js';
import { Scheduler } from './jobs/scheduler.js';
import { pendingPlansJob, staleAccountsJob } from './jobs/nudges.js';
import { claudeHealthJob } from './jobs/claude-health.js';
import { backgroundTurnsJob } from './jobs/background-turns.js';
import { rootLogger } from './log.js';

const log = rootLogger.child({ scope: 'main' });

// src/ and dist/ sit at the same depth, so this resolves to advisor/prompts in both.
export const promptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prompts');

async function main(): Promise<void> {
  const config = loadConfig();
  process.env.TZ = config.TZ;
  const db = createPool(config.DATABASE_URL);
  const pg = createPostgrestClient(config.POSTGREST_URL, config.FINANCES_TOKEN);
  const bus = new Bus();
  const mcpTokens = new McpTokenRegistry();
  const pool = new SessionPool(config.MAX_CONCURRENT_SESSIONS);
  const locks = new ConversationLocks();
  const notifier = new Notifier();
  const sessions = new SessionManager({ config, db, bus, mcpTokens, pool, locks, promptsDir });
  const ctx: AppContext = { config, db, pg, bus, mcpTokens, pool, locks, sessions, notifier, promptsDir };

  await fs.mkdir(path.join(config.DATA_DIR, 'workspaces'), { recursive: true });
  await fs.mkdir(path.join(config.DATA_DIR, 'statements'), { recursive: true });

  // Fail fast on a broken database or token.
  const mig = await db.query('SELECT max(version) AS v FROM schema_migrations');
  log.info({ env: config.ADVISOR_ENV, migrations: mig.rows[0]?.v, channels: [...config.channels] }, 'database reachable');
  await pg.login();
  log.info('PostgREST login ok');

  const mcp = startMcpServer(ctx);
  const http = startHttpServer(ctx);

  let discord: import('./discord/bot.js').DiscordBot | null = null;
  if (config.channels.has('discord')) {
    const { DiscordBot } = await import('./discord/bot.js');
    discord = new DiscordBot(ctx);
    notifier.register(discord);
    discord.start().catch((err) => log.error({ err }, 'discord failed to start'));
  }

  const scheduler = new Scheduler(ctx);
  if (config.channels.has('gmail')) {
    const { GmailSync } = await import('./gmail/sync.js');
    const gmail = new GmailSync(ctx);
    ctx.gmail = gmail;
    scheduler.every(config.GMAIL_TICK_MS, { name: 'gmail-sync', run: () => gmail.tick().then(() => undefined) }, true);
  }
  scheduler.every(config.CHEAP_TICK_MS, { name: 'stale-accounts', run: staleAccountsJob }, true);
  scheduler.every(config.CHEAP_TICK_MS, { name: 'pending-plans', run: pendingPlansJob }, false);
  scheduler.every(config.CLAUDE_TICK_MS, { name: 'background-turns', run: backgroundTurnsJob }, true);
  scheduler.every(6 * 3_600_000, { name: 'claude-health', run: (c) => claudeHealthJob(c).then(() => undefined) }, true);
  setInterval(() => mcpTokens.sweep(), 10 * 60_000).unref();

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    scheduler.stop();
    http.close();
    mcp.close();
    await discord?.stop().catch(() => undefined);
    await db.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled rejection'));
}

main().catch((err) => {
  log.fatal({ err }, 'advisor failed to start');
  process.exit(1);
});
