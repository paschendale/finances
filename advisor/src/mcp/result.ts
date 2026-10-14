import type { CallToolResult } from '@modelcontextprotocol/server';
import { PostgrestError } from '../postgrest/client.js';

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

export function formatToolError(err: unknown): string {
  if (err instanceof PostgrestError) {
    const parts = [`PostgREST ${err.status}${err.code ? ` (${err.code})` : ''}: ${err.message}`];
    if (err.details) parts.push(`details: ${err.details}`);
    if (err.hint) parts.push(`hint: ${err.hint}`);
    return parts.join('\n');
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function fail(err: unknown): CallToolResult {
  return { content: [{ type: 'text', text: formatToolError(err) }], isError: true };
}

export async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}
