import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Paperclip, ArrowUp, Square, ChevronRight, Loader2, FileText, MoreHorizontal, Archive, Pencil, Zap, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type Conversation, type Plan, type StatementSummary } from '@/lib/advisor-api';
import { Markdown } from './Markdown';
import { AttachmentChips } from './AdvisorStates';
import { PlanCard } from './PlanCard';
import { ChannelBadge } from './ConversationList';
import type { LiveMessage } from './useConversation';

function ToolActivity({ message }: { message: LiveMessage }) {
  const [open, setOpen] = useState(false);
  if (message.tools.length === 0 && !message.live) return null;
  const running = message.tools.filter((t) => !t.done);
  const label = message.live
    ? running.length ? running[running.length - 1].summary : message.live === 'thinking' ? 'pensando…' : 'escrevendo…'
    : `${message.tools.length} passo${message.tools.length === 1 ? '' : 's'} · ${message.tools.slice(-3).map((t) => t.summary).join(' · ')}`;
  return (
    <div className="mt-1">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors">
        {message.live ? <Loader2 className="w-3 h-3 animate-spin" /> : <ChevronRight className={cn('w-3 h-3 transition-transform', open && 'rotate-90')} />}
        <span className="truncate max-w-[520px]">{label}</span>
      </button>
      {open && message.tools.length > 0 && (
        <ul className="mt-1.5 pl-4 space-y-0.5 text-[11px] font-mono text-muted-foreground/70">
          {message.tools.map((t) => <li key={t.id} className={cn(t.isError && 'text-rose-300')}>{t.done ? '✓' : '…'} {t.summary}</li>)}
        </ul>
      )}
    </div>
  );
}

export function ChatPanel({
  conversation,
  messages,
  plans,
  statements,
  busy,
  onSend,
  onStop,
  files,
  onAttach,
  onRemoveAttachment,
  onReviewPlan,
  onApprovePlan,
  onRejectPlan,
  onRename,
  onArchive,
  planBusy,
  onOpenList,
  onPlanNow,
  planningNow,
}: {
  conversation: Conversation;
  messages: LiveMessage[];
  plans: Plan[];
  statements: StatementSummary[];
  busy: boolean;
  /** Sends the text with the staged files (either may be empty, not both) */
  onSend: (text: string, files: File[]) => void;
  onStop: () => void;
  /** Files staged for the next message: dropped on the pane or picked with the clip */
  files: File[];
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (index: number) => void;
  onReviewPlan: (id: string) => void;
  onApprovePlan: (plan: Plan) => void;
  onRejectPlan: (plan: Plan) => void;
  onRename: () => void;
  onArchive: () => void;
  planBusy: boolean;
  onOpenList?: () => void;
  /** Present when a Gmail statement is waiting for the usage gate: runs its planning turn now */
  onPlanNow?: () => void;
  planningNow?: boolean;
}) {
  const [text, setText] = useState('');
  const [menu, setMenu] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const lastContent = messages[messages.length - 1]?.content ?? '';
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastContent, plans.length]);

  const plansByAnchor = useMemo(() => {
    // Show each plan card after the assistant message that was last before the plan's last update.
    const out = new Map<string, Plan[]>();
    const tail: Plan[] = [];
    for (const p of plans) {
      const anchor = [...messages].reverse().find((m) => m.role === 'assistant' && m.created_at <= p.updated_at);
      if (anchor) out.set(anchor.id, [...(out.get(anchor.id) ?? []), p]);
      else tail.push(p);
    }
    return { out, tail };
  }, [plans, messages]);

  const canSend = text.trim().length > 0 || files.length > 0;
  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), files);
    setText('');
    textRef.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  const dayLabels = useMemo(() => {
    const out = new Map<string, string>();
    let last = '';
    for (const m of messages) {
      const day = m.created_at.slice(0, 10);
      if (day !== last) {
        last = day;
        let label = day;
        try { label = format(new Date(m.created_at), "EEEE, d 'de' MMMM 'de' yyyy", { locale: ptBR }); } catch { /* keep iso */ }
        out.set(m.id, label);
      }
    }
    return out;
  }, [messages]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <header className="flex items-center gap-2.5 px-4 py-3 border-b border-white/[0.06] bg-[#050505]/85 backdrop-blur-md shrink-0">
        {onOpenList && (
          <button onClick={onOpenList} className="lg:hidden w-8 h-8 rounded-lg border border-white/[0.1] bg-white/[0.03] flex items-center justify-center" aria-label="Abrir conversas">☰</button>
        )}
        <h1 className="text-[14px] font-semibold truncate">{conversation.title}</h1>
        <ChannelBadge row={conversation} />
        {statements.slice(0, 2).map((s) => (
          <span key={s.id} className="hidden sm:flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-white/[0.08] bg-white/[0.03] text-[10px] font-mono text-muted-foreground/70 truncate max-w-[180px]" title={`${s.institution ?? ''} ${s.kind} · ${s.period_start ?? '?'}..${s.period_end ?? '?'} · ${s.status}`}>
            <FileText className="w-3 h-3" /> {s.filename}
          </span>
        ))}
        <span className="flex-1" />
        <div className="relative">
          <button onClick={() => setMenu((v) => !v)} className="w-8 h-8 rounded-lg border border-white/[0.08] text-muted-foreground hover:text-foreground flex items-center justify-center" aria-label="Mais ações"><MoreHorizontal className="w-4 h-4" /></button>
          {menu && (
            <div className="absolute right-0 mt-1 w-40 rounded-xl border border-white/[0.1] bg-[#111] shadow-2xl z-30 p-1 text-[12px]" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => { setMenu(false); onRename(); }} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-white/[0.06]"><Pencil className="w-3 h-3" /> Renomear</button>
              <button onClick={() => { setMenu(false); onArchive(); }} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-white/[0.06]"><Archive className="w-3 h-3" /> {conversation.status === 'archived' ? 'Desarquivar' : 'Arquivar'}</button>
            </div>
          )}
        </div>
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 scroll-smooth">
       <div className="max-w-[920px] mx-auto space-y-5">
        {messages.map((m) => {
          const dayLabel = dayLabels.get(m.id);
          const time = (() => { try { return format(new Date(m.created_at), 'HH:mm'); } catch { return ''; } })();
          const cards = plansByAnchor.out.get(m.id) ?? [];
          return (
            <div key={m.id} className="space-y-2">
              {dayLabel && <div className="text-center text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/35">{dayLabel}</div>}
              {m.role === 'user' ? (
                <div className="flex flex-col items-end gap-1">
                  <div className="text-[11px] text-muted-foreground/50">Você · {time}</div>
                  <div className="max-w-[85%] sm:max-w-[70%] px-3.5 py-2.5 rounded-2xl rounded-br-md bg-white/[0.06] text-[14px] leading-relaxed whitespace-pre-wrap">{m.content}</div>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <div className="text-[11px] text-muted-foreground/50">Assistente · {time}</div>
                  {m.content ? <Markdown text={m.content} className={cn(m.status === 'failed' && 'text-rose-200/90')} /> : m.live ? null : <p className="text-[13px] text-muted-foreground/50 italic">(sem resposta)</p>}
                  {m.error && m.status === 'failed' && !m.content && <p className="text-[13px] text-rose-300">{m.error}</p>}
                  <ToolActivity message={m} />
                  {cards.map((p) => (
                    <div key={p.id} className="max-w-[640px]">
                      <PlanCard plan={p} busy={planBusy} onReview={() => onReviewPlan(p.id)} onApprove={() => onApprovePlan(p)} onReject={() => onRejectPlan(p)} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {plansByAnchor.tail.map((p) => (
          <div key={p.id} className="max-w-[640px]"><PlanCard plan={p} busy={planBusy} onReview={() => onReviewPlan(p.id)} onApprove={() => onApprovePlan(p)} onReject={() => onRejectPlan(p)} /></div>
        ))}
        {messages.length === 0 && onPlanNow && statements.length > 0 && !busy && (
          <div className="max-w-[560px] mx-auto mt-6 rounded-2xl border border-amber-400/20 bg-amber-500/[0.06] p-4 space-y-3">
            <div className="flex items-start gap-2 text-[13px]">
              <Clock className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold text-amber-100">{statements.length > 1 ? 'Estes extratos estão esperando uma folga do Claude' : 'Este extrato está esperando uma folga do Claude'}</div>
                <div className="text-[12px] text-amber-200/70 mt-0.5">{statements.map((s) => s.filename).join(', ')}. {statements.length > 1 ? 'Os planos são montados juntos, um período de cada vez,' : 'O plano é montado sozinho'} quando o uso do Claude baixar, ou agora se você pedir.</div>
              </div>
            </div>
            <button onClick={onPlanNow} disabled={planningNow} className="w-full h-9 rounded-xl bg-amber-400 text-[#1a1200] text-[13px] font-semibold hover:bg-amber-300 disabled:opacity-60 flex items-center justify-center gap-1.5 transition-all active:scale-[0.99]">
              {planningNow ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />} Planejar agora
            </button>
          </div>
        )}
        {messages.length === 0 && !(onPlanNow && statements.length > 0) && <p className="text-[13px] text-muted-foreground/50 text-center py-10">Diga oi, ou solte um arquivo aqui.</p>}
       </div>
      </div>

      {/* Composer */}
      <div className="shrink-0 px-3 sm:px-5 pb-4 pt-2 border-t border-white/[0.06] bg-[#050505]/95 backdrop-blur-md">
       <div className="max-w-[920px] mx-auto">
        <AttachmentChips files={files} onRemove={onRemoveAttachment} />
        <div className="flex items-end gap-1.5 px-1.5 py-1.5 rounded-2xl border border-white/[0.12] bg-white/[0.03] focus-within:border-white/[0.25] transition-colors">
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) onAttach(fs); e.target.value = ''; }} />
          <button onClick={() => fileRef.current?.click()} className="w-10 h-10 rounded-xl text-muted-foreground/70 hover:text-foreground hover:bg-white/[0.06] flex items-center justify-center shrink-0 transition-colors" aria-label="Anexar arquivo"><Paperclip className="w-4 h-4" /></button>
          <textarea
            ref={textRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            placeholder={files.length > 0 ? 'Diga o que fazer com o arquivo… (Enter envia)' : 'Escreva para o assistente… (Enter envia, Shift+Enter pula linha)'}
            className="flex-1 min-h-[40px] max-h-40 resize-none bg-transparent outline-none text-[14px] leading-[22px] py-2 placeholder:text-muted-foreground/40"
            style={{ height: Math.min(160, 24 + 22 * Math.max(1, text.split('\n').length)) }}
          />
          {busy ? (
            <button onClick={onStop} className="w-10 h-10 rounded-xl bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 flex items-center justify-center shrink-0 transition-colors" aria-label="Parar"><Square className="w-3.5 h-3.5" /></button>
          ) : (
            <button onClick={submit} disabled={!canSend} className="w-10 h-10 rounded-xl bg-white/[0.1] hover:bg-white/[0.18] disabled:opacity-30 flex items-center justify-center shrink-0 transition-colors" aria-label="Enviar"><ArrowUp className="w-4 h-4" /></button>
          )}
        </div>
       </div>
      </div>
    </div>
  );
}
