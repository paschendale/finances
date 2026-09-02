import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerAllTools, EXPECTED_TOOL_NAMES } from './register';
import type { ToolCtx } from '../types';

function registeredToolNames(server: McpServer): string[] {
  // _registeredTools is private in the SDK's types but not actually hidden at runtime;
  // this is the cheapest way to assert the full registered set without standing up a
  // real JSON-RPC transport just to call tools/list.
  const internals = server as unknown as { _registeredTools: Record<string, unknown> };
  return Object.keys(internals._registeredTools);
}

describe('registerAllTools', () => {
  it('registers exactly the expected 21 tools', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const ctx: ToolCtx = { rawToken: 'test-token', env: { POSTGREST_URL: 'http://localhost:3000' } };

    registerAllTools(server, ctx);

    const names = registeredToolNames(server).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });
});
