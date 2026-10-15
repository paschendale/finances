import { useEffect, useMemo, useReducer, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchConversation, subscribe, type ConversationEvent, type Message, type Conversation } from '@/lib/advisor-api';

export interface ToolActivity {
  id: string;
  summary: string;
  done: boolean;
  isError?: boolean;
}

export interface LiveMessage extends Message {
  tools: ToolActivity[];
  live?: 'thinking' | 'streaming';
  error?: string;
}

interface Patch {
  content?: string;
  status?: Message['status'];
  tools: ToolActivity[];
  live?: 'thinking' | 'streaming';
  error?: string;
  /** message seen on the stream before the server list had it */
  stub?: LiveMessage;
}

interface LiveState {
  forConversation: string | null;
  patches: Record<string, Patch>;
  order: string[];
  overrides: Partial<Pick<Conversation, 'title' | 'summary' | 'status'>>;
}

type Action = { type: 'event'; conversationId: string; ev: ConversationEvent } | { type: 'reset'; conversationId: string | null };

const empty = (id: string | null): LiveState => ({ forConversation: id, patches: {}, order: [], overrides: {} });

function reducer(state: LiveState, action: Action): LiveState {
  if (action.type === 'reset') return empty(action.conversationId);
  const base = state.forConversation === action.conversationId ? state : empty(action.conversationId);
  const ev = action.ev;
  if (ev.type === 'conversation') return { ...base, overrides: { ...base.overrides, [ev.field]: ev.value } };
  if (ev.type === 'plan') return base;
  const id = ev.messageId;
  const prev: Patch = base.patches[id] ?? { tools: [] };
  const order = base.order.includes(id) ? base.order : [...base.order, id];
  let next: Patch = prev;
  switch (ev.type) {
    case 'message':
      next = {
        ...prev,
        status: ev.status,
        content: ev.status === 'done' || ev.status === 'failed' ? ev.content : (prev.content ?? ev.content),
        live: ev.status === 'done' || ev.status === 'failed' ? undefined : prev.live,
        stub: prev.stub ?? { id, role: ev.role, content: ev.content, status: ev.status, attachments: [], created_at: new Date().toISOString(), tools: [] },
      };
      break;
    case 'text':
      next = { ...prev, content: (prev.content ?? '') + ev.delta, status: 'streaming', live: 'streaming' };
      break;
    case 'tool':
      next = ev.phase === 'start'
        ? { ...prev, tools: [...prev.tools, { id: ev.id, summary: ev.summary ?? ev.name ?? 'working', done: false }] }
        : { ...prev, tools: prev.tools.map((t) => (t.id === ev.id ? { ...t, done: true, isError: ev.isError } : t)) };
      break;
    case 'status':
      next = {
        ...prev,
        live: ev.status === 'thinking' || ev.status === 'streaming' ? ev.status : undefined,
        status: ev.status === 'done' ? 'done' : ev.status === 'failed' ? 'failed' : prev.status,
        error: ev.error,
      };
      break;
    default:
      return base;
  }
  return { ...base, order, patches: { ...base.patches, [id]: next } };
}

function merge(server: Message[], state: LiveState, conversationId: string | null): LiveMessage[] {
  const applies = state.forConversation === conversationId;
  const seen = new Set<string>();
  const out: LiveMessage[] = server.map((m) => {
    seen.add(m.id);
    const p = applies ? state.patches[m.id] : undefined;
    if (!p) return { ...m, tools: [] };
    // While a turn runs the server copy is empty; prefer the streamed text. Once done, the server copy wins.
    const serverFinal = m.status === 'done' || m.status === 'failed';
    return {
      ...m,
      content: serverFinal && m.content ? m.content : (p.content ?? m.content),
      status: serverFinal ? m.status : (p.status ?? m.status),
      tools: p.tools,
      live: serverFinal ? undefined : p.live,
      error: p.error,
    };
  });
  if (applies) {
    for (const id of state.order) {
      if (seen.has(id)) continue;
      const p = state.patches[id];
      if (!p?.stub) continue;
      out.push({ ...p.stub, content: p.content ?? p.stub.content, status: p.status ?? p.stub.status, tools: p.tools, live: p.live, error: p.error });
    }
  }
  return out;
}

export function useConversation(conversationId: string | null) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(reducer, conversationId, empty);
  const [connected, setConnected] = useState(false);
  const [busyLive, setBusyLive] = useState<{ id: string | null; busy: boolean }>({ id: null, busy: false });

  const query = useQuery({
    queryKey: ['advisorConversation', conversationId],
    queryFn: () => fetchConversation(conversationId!),
    enabled: !!conversationId,
    staleTime: 5_000,
  });

  useEffect(() => {
    if (!conversationId) return;
    const off = subscribe(
      `/conversations/${conversationId}/events`,
      (sse) => {
        if (sse.event === 'ready') {
          try { setBusyLive({ id: conversationId, busy: Boolean(JSON.parse(sse.data).busy) }); } catch { /* ignore */ }
          return;
        }
        if (sse.event !== 'conversation') return;
        let ev: ConversationEvent;
        try { ev = JSON.parse(sse.data) as ConversationEvent; } catch { return; }
        dispatch({ type: 'event', conversationId, ev });
        if (ev.type === 'status') setBusyLive({ id: conversationId, busy: ev.status === 'thinking' || ev.status === 'streaming' });
        if (ev.type === 'message' && ev.role === 'assistant' && (ev.status === 'done' || ev.status === 'failed')) {
          setBusyLive({ id: conversationId, busy: false });
          void queryClient.invalidateQueries({ queryKey: ['advisorConversation', conversationId] });
          void queryClient.invalidateQueries({ queryKey: ['advisorConversations'] });
        }
        if (ev.type === 'plan') {
          void queryClient.invalidateQueries({ queryKey: ['advisorConversation', conversationId] });
          void queryClient.invalidateQueries({ queryKey: ['advisorPlan', ev.planId] });
          void queryClient.invalidateQueries({ queryKey: ['advisorPendingPlans'] });
          void queryClient.invalidateQueries({ queryKey: ['advisorConversations'] });
        }
        if (ev.type === 'conversation') void queryClient.invalidateQueries({ queryKey: ['advisorConversations'] });
      },
      setConnected,
    );
    return off;
  }, [conversationId, queryClient]);

  const data = query.data;
  const messages = useMemo(() => merge(data?.messages ?? [], state, conversationId), [data, state, conversationId]);
  const conversation = useMemo<Conversation | null>(() => {
    if (!data) return null;
    return state.forConversation === conversationId ? { ...data.conversation, ...state.overrides } : data.conversation;
  }, [data, state, conversationId]);
  const busy = busyLive.id === conversationId ? busyLive.busy : (data?.busy ?? false);

  return {
    conversation,
    messages,
    plans: data?.plans ?? [],
    statements: data?.statements ?? [],
    busy,
    connected,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
