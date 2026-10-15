import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface ClaudeCredentials {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  subscriptionType: string | null;
}

export interface CredentialsHealth {
  loggedIn: boolean;
  path: string;
  expiresAt: string | null;
  expiresInHours: number | null;
  subscriptionType: string | null;
  error?: string;
}

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : path.join(env.HOME ?? os.homedir(), '.claude');
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(claudeConfigDir(env), '.credentials.json');
}

/** Linux/Docker: the Claude Code login lives in ~/.claude/.credentials.json (no keychain). */
export async function readCredentials(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeCredentials> {
  const p = credentialsPath(env);
  const raw = await fs.readFile(p, 'utf8');
  const j = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number; subscriptionType?: string } };
  const o = j.claudeAiOauth;
  if (!o?.accessToken) throw new Error(`no claudeAiOauth.accessToken in ${p}`);
  return {
    accessToken: o.accessToken,
    refreshToken: o.refreshToken ?? null,
    expiresAt: o.expiresAt ? new Date(o.expiresAt) : null,
    subscriptionType: o.subscriptionType ?? null,
  };
}

export async function credentialsHealth(env: NodeJS.ProcessEnv = process.env): Promise<CredentialsHealth> {
  const p = credentialsPath(env);
  try {
    const c = await readCredentials(env);
    const hours = c.expiresAt ? (c.expiresAt.getTime() - Date.now()) / 3_600_000 : null;
    return {
      loggedIn: true,
      path: p,
      expiresAt: c.expiresAt?.toISOString() ?? null,
      expiresInHours: hours === null ? null : Math.round(hours * 10) / 10,
      subscriptionType: c.subscriptionType,
    };
  } catch (err) {
    return { loggedIn: false, path: p, expiresAt: null, expiresInHours: null, subscriptionType: null, error: (err as Error).message };
  }
}
