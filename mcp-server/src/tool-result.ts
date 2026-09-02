import type { CallToolResult } from '@modelcontextprotocol/server';
import { formatToolError } from './errors';

export function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

export function fail(err: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: formatToolError(err) }],
    isError: true,
  };
}

export async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}
