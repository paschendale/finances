import { EventEmitter } from 'node:events';

/** Events a conversation's web clients (SSE) and Discord thread consume. */
export type ConversationEvent =
  | { type: 'message'; messageId: string; role: 'user' | 'assistant' | 'system'; content: string; status: string }
  | { type: 'text'; messageId: string; delta: string }
  | { type: 'tool'; messageId: string; phase: 'start' | 'end'; id: string; name?: string; summary?: string; isError?: boolean }
  | { type: 'status'; messageId: string; status: 'thinking' | 'streaming' | 'done' | 'failed'; error?: string }
  | { type: 'plan'; planId: string; status: string; version: number }
  | { type: 'conversation'; field: 'title' | 'summary' | 'status'; value: string };

export type GlobalEvent =
  | { type: 'plan'; planId: string; conversationId: string; status: string }
  | { type: 'statement'; statementId: string; conversationId: string | null; status: string }
  | { type: 'health'; claude: boolean }
  | { type: 'accounts'; planId: string };

export class Bus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(500);
  }

  emitConversation(conversationId: string, ev: ConversationEvent): void {
    this.emitter.emit(`conv:${conversationId}`, ev);
    this.emitter.emit('conv:*', conversationId, ev);
  }

  onConversation(conversationId: string, fn: (ev: ConversationEvent) => void): () => void {
    const key = `conv:${conversationId}`;
    this.emitter.on(key, fn);
    return () => this.emitter.off(key, fn);
  }

  onAnyConversation(fn: (conversationId: string, ev: ConversationEvent) => void): () => void {
    this.emitter.on('conv:*', fn);
    return () => this.emitter.off('conv:*', fn);
  }

  emitGlobal(ev: GlobalEvent): void {
    this.emitter.emit('global', ev);
  }

  onGlobal(fn: (ev: GlobalEvent) => void): () => void {
    this.emitter.on('global', fn);
    return () => this.emitter.off('global', fn);
  }
}
