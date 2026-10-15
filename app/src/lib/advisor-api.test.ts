import { describe, expect, it } from 'vitest';
import { SseParser, canApproveFromCard, channelLabel, parseSseBlock } from './advisor-api';
import { parseMarkdown } from './markdown';

describe('SseParser', () => {
  it('parses complete events and keeps the tail', () => {
    const p = new SseParser();
    const first = p.push('event: ready\ndata: {"a":1}\n\nevent: conversation\ndata: {"type":"text","delta":"ol');
    expect(first).toEqual([{ event: 'ready', data: '{"a":1}', id: undefined }]);
    const second = p.push('á"}\nid: 7\n\n');
    expect(second).toEqual([{ event: 'conversation', data: '{"type":"text","delta":"olá"}', id: '7' }]);
  });
  it('joins multi-line data and ignores comments', () => {
    const ev = parseSseBlock(': keep-alive\ndata: a\ndata: b');
    expect(ev).toEqual({ event: 'message', data: 'a\nb', id: undefined });
    expect(parseSseBlock(': only a comment')).toBeNull();
  });
  it('handles CRLF', () => {
    const p = new SseParser();
    expect(p.push('event: ping\r\ndata: 1\r\n\r\n')).toEqual([{ event: 'ping', data: '1', id: undefined }]);
  });
});

describe('canApproveFromCard', () => {
  const base = { status: 'pending_approval' as const, min_confidence: 0.9, result: { balance: { ok: true, difference: 0 } } };
  it('allows when balanced and confident', () => expect(canApproveFromCard(base)).toBe(true));
  it('blocks a failed balance check', () => expect(canApproveFromCard({ ...base, result: { balance: { ok: false, difference: 11 } } })).toBe(false));
  it('blocks low confidence', () => expect(canApproveFromCard({ ...base, min_confidence: 0.55 })).toBe(false));
  it('blocks non-pending plans', () => expect(canApproveFromCard({ ...base, status: 'applied' })).toBe(false));
  it('allows plans without a statement balance', () => expect(canApproveFromCard({ ...base, result: null })).toBe(true));
});

describe('channelLabel', () => {
  it('maps system+gmail to Gmail', () => {
    expect(channelLabel({ channel: 'system', created_by: 'gmail' })).toBe('Gmail');
    expect(channelLabel({ channel: 'discord', created_by: null })).toBe('Discord');
    expect(channelLabel({ channel: 'web', created_by: 'web' })).toBe('Web');
  });
});

describe('parseMarkdown', () => {
  it('splits paragraphs, bold, code, lists and tables', () => {
    const blocks = parseMarkdown('Olá **mundo** e `x`\n\n- a\n- b\n\n| h1 | h2 |\n|---|---|\n| 1 | 2 |\n');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list', 'table']);
    const para = blocks[0];
    if (para.type !== 'paragraph') throw new Error('expected paragraph');
    expect(para.spans).toEqual([
      { kind: 'text', text: 'Olá ' },
      { kind: 'bold', text: 'mundo' },
      { kind: 'text', text: ' e ' },
      { kind: 'code', text: 'x' },
    ]);
    const table = blocks[2];
    if (table.type !== 'table') throw new Error('expected table');
    expect(table.header).toEqual(['h1', 'h2']);
    expect(table.rows).toEqual([['1', '2']]);
  });
  it('keeps unterminated bold as text and renders headings', () => {
    const blocks = parseMarkdown('## Resumo\n**ab');
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 2 });
    const p = blocks[1];
    if (p.type !== 'paragraph') throw new Error('expected paragraph');
    expect(p.spans).toEqual([{ kind: 'text', text: '**ab' }]);
  });
});
