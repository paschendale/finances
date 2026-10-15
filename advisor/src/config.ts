import { z } from 'zod';

const csv = (s: string | undefined) =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const intEnv = (def: number) => z.coerce.number().int().default(def);
const numEnv = (def: number) => z.coerce.number().default(def);

const schema = z.object({
  ADVISOR_ENV: z.enum(['dev', 'prod', 'test']).default('dev'),
  PROD_DATABASE_NAME: z.string().default('finances'),
  DATABASE_URL: z.string().min(1),
  POSTGREST_URL: z.string().url(),
  FINANCES_TOKEN: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  PUBLIC_WEB_ORIGINS: z.string().default('http://localhost:5173,http://localhost:8080'),
  /** Public URL of the web app, used for deep links in notifications (optional). */
  WEB_APP_URL: z.string().url().optional(),
  ADVISOR_CHANNELS: z.string().default('web'),
  PORT: intEnv(3100),
  MCP_PORT: intEnv(3101),
  DATA_DIR: z.string().default('/data'),
  CLAUDE_BIN: z.string().default('claude'),
  CLAUDE_CONFIG_DIR: z.string().optional(),
  SESSION_MODEL: z.string().default('opus'),
  ROUTINE_MODEL: z.string().default('sonnet'),
  HEALTH_MODEL: z.string().default('haiku'),
  SESSION_EFFORT: z.string().default('high'),
  SESSION_TIMEOUT_MS: intEnv(900_000),
  SINGLE_SHOT_TIMEOUT_MS: intEnv(180_000),
  MAX_CONCURRENT_SESSIONS: intEnv(2),
  GATE_MAX_7D_PCT: numEnv(85),
  GATE_MAX_5H_PCT: numEnv(70),
  GATE_MAX_CALLS_PER_WINDOW: intEnv(40),
  GATE_TAIL_MINUTES: intEnv(60),
  GATE_IDLE_MINUTES: intEnv(15),
  STALE_DAYS: intEnv(30),
  UPLOAD_MAX_MB: intEnv(15),
  CHEAP_TICK_MS: intEnv(15 * 60_000),
  CLAUDE_TICK_MS: intEnv(5 * 60_000),
  TZ: z.string().default('UTC'),
  ADVISOR_BUDGET_REVIEW: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_CHANNEL_ID: z.string().optional(),
  DISCORD_OBEYED_USER_IDS: z.string().optional(),
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REFRESH_TOKEN: z.string().optional(),
  GMAIL_LOOKBACK_DAYS: intEnv(14),
  LOG_LEVEL: z.string().default('info'),
});

export type Channel = 'web' | 'discord' | 'gmail';

export interface Config extends z.infer<typeof schema> {
  channels: Set<Channel>;
  webOrigins: string[];
  discordObeyedUserIds: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const base = parsed.data;
  const channels = new Set(csv(base.ADVISOR_CHANNELS) as Channel[]);
  for (const c of channels) {
    if (!['web', 'discord', 'gmail'].includes(c)) throw new Error(`Unknown channel in ADVISOR_CHANNELS: ${c}`);
  }
  if (channels.has('discord')) {
    for (const k of ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_CHANNEL_ID', 'DISCORD_OBEYED_USER_IDS'] as const) {
      if (!base[k]) throw new Error(`${k} is required when "discord" is in ADVISOR_CHANNELS`);
    }
  }
  if (channels.has('gmail')) {
    for (const k of ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'] as const) {
      if (!base[k]) throw new Error(`${k} is required when "gmail" is in ADVISOR_CHANNELS`);
    }
  }
  assertDatabaseMatchesEnv(base.ADVISOR_ENV, base.DATABASE_URL, base.PROD_DATABASE_NAME);
  return {
    ...base,
    channels,
    webOrigins: csv(base.PUBLIC_WEB_ORIGINS),
    discordObeyedUserIds: csv(base.DISCORD_OBEYED_USER_IDS),
  };
}

/**
 * Safety rail (docs/ADVISOR.md §0): a prod daemon must point at the prod database name and a
 * non-prod daemon must not, so a mis-pointed environment fails loudly at boot.
 */
export function assertDatabaseMatchesEnv(advisorEnv: string, databaseUrl: string, prodDbName: string): void {
  const dbName = databaseNameOf(databaseUrl);
  const isProdDb = dbName === prodDbName;
  if (advisorEnv === 'prod' && !isProdDb) {
    throw new Error(`ADVISOR_ENV=prod but DATABASE_URL points at "${dbName}", expected "${prodDbName}"`);
  }
  if (advisorEnv !== 'prod' && isProdDb) {
    throw new Error(`ADVISOR_ENV=${advisorEnv} but DATABASE_URL points at the production database "${dbName}"`);
  }
}

export function databaseNameOf(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    return decodeURIComponent(u.pathname.replace(/^\//, '').split('?')[0] ?? '');
  } catch {
    return '';
  }
}
