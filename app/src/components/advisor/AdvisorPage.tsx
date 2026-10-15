import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  approvePlan,
  createConversation,
  fetchConversations,
  patchConversation,
  planAllNow,
  planNow,
  rejectPlan,
  sendMessage,
  stopConversation,
  subscribe,
  uploadFiles,
  type Plan,
} from '@/lib/advisor-api';
import { ConversationList } from './ConversationList';
import { ChatPanel } from './ChatPanel';
import { PlanReview } from './PlanReview';
import { UploadDrop } from './UploadDrop';
import { EmptyState, OfflineBanner } from './AdvisorStates';
import { useConversation } from './useConversation';
import { useAdvisorHealth } from './useAdvisorHealth';

export interface AdvisorTarget {
  conversationId?: string | null;
  planId?: string | null;
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 1024 : false));
  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return mobile;
}

export function AdvisorPage({ conversationId, planId, onNavigate }: { conversationId: string | null; planId: string | null; onNavigate: (t: AdvisorTarget) => void }) {
  const qc = useQueryClient();
  const mobile = useIsMobile();
  const [listOpen, setListOpen] = useState(false);
  // Files dropped on the pane or picked with the clip wait here and go out with the next message.
  // They belong to the conversation they were dropped in: switching conversations shows an empty tray.
  const [staged, setStaged] = useState<{ conversationId: string | null; files: File[] }>({ conversationId: null, files: [] });
  const attachments = staged.conversationId === conversationId ? staged.files : [];
  const setAttachments = useCallback((files: File[]) => setStaged({ conversationId, files }), [conversationId]);
  const attach = useCallback((files: File[]) => setStaged((prev) => ({ conversationId, files: [...(prev.conversationId === conversationId ? prev.files : []), ...files] })), [conversationId]);
  const removeAttachment = useCallback((i: number) => setStaged((prev) => ({ conversationId, files: (prev.conversationId === conversationId ? prev.files : []).filter((_, j) => j !== i) })), [conversationId]);
  const { data: rows = [], isLoading: listLoading } = useQuery({ queryKey: ['advisorConversations'], queryFn: fetchConversations, refetchInterval: 30_000 });
  const { data: health } = useAdvisorHealth();
  const conv = useConversation(conversationId);

  // Global stream keeps the list and plan badges fresh.
  useEffect(() => {
    return subscribe('/events', (sse) => {
      if (sse.event !== 'global') return;
      void qc.invalidateQueries({ queryKey: ['advisorConversations'] });
      void qc.invalidateQueries({ queryKey: ['advisorPendingPlans'] });
    });
  }, [qc]);

  const select = useCallback((id: string | null) => { onNavigate({ conversationId: id, planId: null }); setListOpen(false); }, [onNavigate]);

  const newConversation = useMutation({
    mutationFn: (input: { message?: string; title?: string }) => createConversation(input),
    onSuccess: (c) => { void qc.invalidateQueries({ queryKey: ['advisorConversations'] }); select(c.id); },
  });
  const send = useMutation({
    mutationFn: async (input: { text: string; files: File[] }): Promise<void> => {
      if (input.files.length > 0) await uploadFiles(input.files, { conversationId: conversationId!, message: input.text || undefined });
      else await sendMessage(conversationId!, input.text);
    },
    onSuccess: () => { setAttachments([]); void conv.refetch(); },
    onError: (e: Error) => window.alert(e.message),
  });
  const stop = useMutation({ mutationFn: () => stopConversation(conversationId!) });
  // First message of a new conversation with files attached.
  const upload = useMutation({
    mutationFn: (input: { files: File[]; message?: string }) => uploadFiles(input.files, { message: input.message }),
    onSuccess: (r) => { setAttachments([]); void qc.invalidateQueries({ queryKey: ['advisorConversations'] }); select(r.conversation_id); },
    onError: (e: Error) => window.alert(e.message),
  });
  const approve = useMutation({
    mutationFn: (p: Plan) => approvePlan(p.id, p.version),
    onSuccess: () => { void conv.refetch(); void qc.invalidateQueries({ queryKey: ['transactions'] }); void qc.invalidateQueries({ queryKey: ['accounts'] }); void qc.invalidateQueries({ queryKey: ['advisorPendingPlans'] }); },
    onError: (e: Error) => { window.alert(e.message); void conv.refetch(); },
  });
  const reject = useMutation({ mutationFn: (p: Plan) => rejectPlan(p.id), onSuccess: () => { void conv.refetch(); void qc.invalidateQueries({ queryKey: ['advisorPendingPlans'] }); } });
  const rename = useMutation({ mutationFn: (title: string) => patchConversation(conversationId!, { title }), onSuccess: () => { void conv.refetch(); void qc.invalidateQueries({ queryKey: ['advisorConversations'] }); } });
  const planOne = useMutation({
    mutationFn: (id: string) => planNow(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['advisorConversations'] }); void conv.refetch(); },
    onError: (e: Error) => window.alert(e.message),
  });
  const planAll = useMutation({
    mutationFn: () => planAllNow(),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['advisorConversations'] }); if (r.started === 0) window.alert('Nenhum extrato está esperando.'); },
    onError: (e: Error) => window.alert(e.message),
  });
  const archive = useMutation({ mutationFn: (status: 'active' | 'archived') => patchConversation(conversationId!, { status }), onSuccess: () => { void conv.refetch(); void qc.invalidateQueries({ queryKey: ['advisorConversations'] }); } });

  const gateClosed = health?.gate ? !health.gate.open : false;

  const list = (
    <ConversationList
      rows={rows}
      activeId={conversationId}
      gateClosed={gateClosed}
      onSelect={select}
      onNew={() => { select(null); }}
      onPlanNow={(id) => planOne.mutate(id)}
      onPlanAllNow={() => planAll.mutate()}
      planningAll={planAll.isPending}
    />
  );

  const right = planId ? (
    <PlanReview planId={planId} onBack={() => onNavigate({ conversationId: conversationId ?? conv.conversation?.id ?? null, planId: null })} mobile={mobile} />
  ) : conversationId && conv.conversation ? (
    <ChatPanel
      conversation={conv.conversation}
      messages={conv.messages}
      plans={conv.plans}
      statements={conv.statements}
      busy={conv.busy}
      onSend={(text, files) => send.mutate({ text, files })}
      onStop={() => stop.mutate()}
      files={attachments}
      onAttach={attach}
      onRemoveAttachment={removeAttachment}
      onReviewPlan={(id) => onNavigate({ conversationId, planId: id })}
      onApprovePlan={(p) => approve.mutate(p)}
      onRejectPlan={(p) => { if (window.confirm('Descartar este plano?')) reject.mutate(p); }}
      onRename={() => { const t = window.prompt('Nome da conversa', conv.conversation?.title ?? ''); if (t && t.trim()) rename.mutate(t.trim()); }}
      onArchive={() => archive.mutate(conv.conversation?.status === 'archived' ? 'active' : 'archived')}
      planBusy={approve.isPending || reject.isPending}
      onOpenList={mobile ? () => setListOpen(true) : undefined}
      onPlanNow={rows.find((r) => r.id === conversationId)?.waiting_turn ? () => planOne.mutate(conversationId) : undefined}
      planningNow={planOne.isPending}
    />
  ) : conversationId && conv.isLoading ? (
    <div className="flex items-center justify-center h-full text-muted-foreground/50 text-[13px]"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Carregando…</div>
  ) : conversationId && conv.error ? (
    <div className="p-6 text-[13px] text-rose-300">{conv.error.message}</div>
  ) : (
    <div className="h-full flex flex-col">
      {mobile && <div className="p-2"><button onClick={() => setListOpen(true)} className="text-[12px] text-muted-foreground px-2 py-1 rounded-lg border border-white/[0.1]">☰ Conversas</button></div>}
      {newConversation.isPending ? (
        <div className="flex items-center justify-center h-full text-muted-foreground/50 text-[13px]"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Começando…</div>
      ) : (
        <EmptyState
          onStart={(message) => newConversation.mutate({ message })}
          onUpload={(files, message) => upload.mutate({ files, message })}
          busy={upload.isPending}
          files={attachments}
          onAttach={attach}
          onRemoveAttachment={removeAttachment}
        />
      )}
    </div>
  );

  return (
    <div className="w-full space-y-3 pb-6">
      <OfflineBanner health={health} />
      <UploadDrop onFiles={attach} disabled={upload.isPending || send.isPending} className="rounded-2xl border border-white/[0.06] bg-white/[0.015] overflow-hidden" >
        <div className="flex h-[calc(100dvh-150px)] sm:h-[calc(100vh-170px)] min-h-[420px] sm:min-h-[520px]">
          {!mobile && (
            <aside className="w-[280px] shrink-0 border-r border-white/[0.06] flex flex-col">
              {listLoading && rows.length === 0 ? <div className="p-4 text-[12px] text-muted-foreground/50">Carregando…</div> : list}
            </aside>
          )}
          <section className="flex-1 min-w-0 flex flex-col relative">
            {(upload.isPending || (send.isPending && attachments.length > 0)) && <div className="absolute top-2 right-3 z-20 text-[11px] text-muted-foreground flex items-center gap-1.5 bg-black/60 px-2 py-1 rounded-lg"><Loader2 className="w-3 h-3 animate-spin" /> Enviando…</div>}
            {right}
          </section>
        </div>
      </UploadDrop>
      {mobile && listOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setListOpen(false)} />
          <aside className={cn('relative w-[300px] max-w-[85vw] h-full bg-[#0a0a0b] border-r border-white/[0.1] shadow-2xl animate-in slide-in-from-left duration-300')}>{list}</aside>
        </div>
      )}
    </div>
  );
}
