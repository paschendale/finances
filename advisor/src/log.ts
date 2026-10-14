import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.LOG_PRETTY === '1' || (process.stdout.isTTY && process.env.NODE_ENV !== 'production');

export const rootLogger = pino(
  pretty
    ? { level, transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
    : { level },
);

export type Logger = pino.Logger;

export function scoped(scope: string, bindings: Record<string, unknown> = {}): Logger {
  return rootLogger.child({ scope, ...bindings });
}
