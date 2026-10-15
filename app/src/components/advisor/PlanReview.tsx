import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, X, Loader2, Sparkles, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchAccounts } from '@/lib/api';
import { approvePlan, autoCheckedCount, fetchPlan, formatBRL, isAutoItem, monthLabel, patchPlanItem, rejectPlan, replan, AdvisorApiError, APPROVE_MIN_CONFIDENCE, type PlanItem } from '@/lib/advisor-api';
import { PlanItemRow, type AccountOption } from './PlanItemRow';

type Filter = 'all' | 'changes' | 'low';

const STATUS_LABEL: Record<string, string> = { draft: 'rascunho', pending_approval: 'esperando sua aprovação', approved: 'aprovado', applying: 'gravando…', applied: 'gravado', rejected: 'descartado', failed: 'deu erro' };
const fmtDay = (d: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d); return m ? `${m[3]}/${m[2]}` : d; };

export function PlanReview({ planId, onBack, mobile }: { planId: string; onBack: () => void; mobile: boolean }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [showSkipped, setShowSkipped] = useState(false);
  const [showAuto, setShowAuto] = useState(false);
  const [ask, setAsk] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({ queryKey: ['advisorPlan', planId], queryFn: () => fetchPlan(planId), refetchInterval: (q) => (q.state.data?.plan.status === 'applying' ? 2000 : false) });
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });

  const accountOptions = useMemo<AccountOption[]>(() => accounts.filter((a) => !a.hidden && (a.account_type === 'asset' || a.account_type === 'liability' || a.account_type === 'equity')).map((a) => ({ label: a.account_name, value: a.account_id, icon: a.icon, color: a.color, type: a.account_type })), [accounts]);
  const categoryOptions = useMemo<AccountOption[]>(() => accounts.filter((a) => !a.hidden && (a.account_type === 'expense' || a.account_type === 'income')).map((a) => ({ label: a.account_name, value: a.account_id, icon: a.icon, color: a.color, type: a.account_type })), [accounts]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['advisorPlan', planId] });
    void qc.invalidateQueries({ queryKey: ['advisorPendingPlans'] });
    void qc.invalidateQueries({ queryKey: ['advisorConversations'] });
    if (data) void qc.invalidateQueries({ queryKey: ['advisorConversation', data.plan.conversation_id] });
  };

  const patch = useMutation({
    mutationFn: ({ item, body }: { item: PlanItem; body: Parameters<typeof patchPlanItem>[2] }) => patchPlanItem(planId, item.id, body),
    onSuccess: invalidate,
    onError: (e: Error) => setNotice((e as AdvisorApiError).body ? `Essa alteração não é válida: ${JSON.stringify(((e as AdvisorApiError).body as { issues?: unknown }).issues ?? e.message)}` : e.message),
  });
  const approve = useMutation({
    mutationFn: () => approvePlan(planId, data!.plan.version, data!.items.some((i) => Boolean(i.payload?.reopens_reconciliation))),
    onSuccess: (r) => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      const recLabel = (st: string) => (st === 'balanced' ? 'o saldo bate' : st === 'adjusted' ? 'conferido com ajuste' : 'ficou em aberto');
      const reopened = (r.reopened ?? []).map((x) => (x.status === 'open' ? `a conferência até ${fmtDay(x.period_end)} ficou em aberto (diferença de ${formatBRL(Number(x.difference ?? 0))})` : `a conferência até ${fmtDay(x.period_end)} foi refeita`)).join('; ');
      setNotice(r.status === 'applied' ? `Gravado${r.applied === 1 ? '' : 's'} ${r.applied} ${r.applied === 1 ? 'item' : 'itens'}${r.reconciliation ? ` · extrato até ${fmtDay(r.reconciliation.reconciliation.period_end)}: ${recLabel(r.reconciliation.reconciliation.status)}` : ''}${reopened ? ` · ${reopened}` : ''}.` : `${r.applied} gravado${r.applied === 1 ? '' : 's'}, ${r.failed} com erro: ${r.items.filter((i) => i.status === 'failed').map((i) => `item ${i.seq}: ${i.error}`).join('; ')}`);
    },
    onError: (e: Error) => { setNotice(e instanceof AdvisorApiError && e.status === 409 ? 'O plano mudou depois que você o abriu. Revise de novo.' : e.message); invalidate(); },
  });
  const reject = useMutation({ mutationFn: () => rejectPlan(planId), onSuccess: () => { invalidate(); onBack(); } });
  const askMut = useMutation({ mutationFn: (m: string) => replan(planId, m), onSuccess: () => { setAsk(''); setNotice('Pedido enviado. A tabela atualiza quando o assistente revisar o plano.'); } });

  if (isLoading || !data) return <div className="flex items-center justify-center h-full text-muted-foreground/50 text-[13px]"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Carregando o plano…</div>;
  if (error) return <div className="p-6 text-[13px] text-rose-300">{(error as Error).message}</div>;

  const { plan, items, balance } = data;
  const balances = data.balances ?? (balance ? [balance] : []);
  const autoChecked = autoCheckedCount(plan);
  const active = items.filter((i) => i.status !== 'removed');
  const autoItems = items.filter((i) => isAutoItem(i));
  const changes = items.filter((i) => i.kind !== 'skip' && !isAutoItem(i));
  const low = items.filter((i) => i.kind !== 'skip' && i.status !== 'removed' && i.confidence != null && i.confidence < APPROVE_MIN_CONFIDENCE);
  const skipped = items.filter((i) => i.kind === 'skip');
  const visible = (filter === 'changes' ? changes : filter === 'low' ? low : items).filter((i) => (i.kind !== 'skip' || showSkipped || filter !== 'all') && (!isAutoItem(i) || showAuto || filter !== 'all'));
  // Several periods in one plan: a heading per month keeps the list readable.
  const multiPeriod = balances.length > 1 || new Set(visible.map((i) => (i.date ?? '').slice(0, 7))).size > 1;
  const autoTotal = autoItems.reduce((s, i) => s + Math.abs(Number(i.payload?.statement_amount ?? 0) - Number(i.payload?.ledger_amount ?? 0)), 0);
  const editable = plan.status === 'pending_approval' || plan.status === 'draft';
  const approvableCount = active.filter((i) => i.kind !== 'skip').length;
  const canApprove = editable && (!balance || balance.ok || true) && !approve.isPending; // review page may approve with a difference; the card cannot
  const skippedTotal = skipped.reduce((s, i) => s + (i.entries.find((e) => e.amount_base < 0)?.amount_base ?? 0), 0);
  const editedCount = items.filter((i) => i.status === 'edited' || i.status === 'removed').length;

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06] bg-[#050505]/85 backdrop-blur-md shrink-0">
        <button onClick={onBack} className="w-8 h-8 rounded-lg border border-white/[0.1] bg-white/[0.03] flex items-center justify-center hover:bg-white/[0.08]" aria-label="Voltar para a conversa"><ArrowLeft className="w-4 h-4" /></button>
        <div className="min-w-0 flex-1">
          <h1 className="text-[14px] font-semibold truncate">{plan.title}</h1>
          <div className="text-[11px] text-muted-foreground/60 truncate">{STATUS_LABEL[plan.status] ?? plan.status}{plan.version > 1 ? ' · revisado' : ''}{editedCount ? ` · ${editedCount} linha${editedCount > 1 ? 's' : ''} editada${editedCount > 1 ? 's' : ''} por você` : ''}</div>
        </div>
        {!mobile && (
          <div className="flex rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
            {([['all', `Tudo ${items.length}`], ['changes', `Mudanças ${changes.length}`], ['low', `Em dúvida ${low.length}`]] as [Filter, string][]).map(([f, label]) => (
              <button key={f} onClick={() => setFilter(f)} className={cn('px-3 py-1 rounded-md text-[12px] font-medium transition-colors', filter === f ? 'bg-white/10' : 'text-muted-foreground hover:text-foreground')}>{label}</button>
            ))}
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto scroll-smooth">
        {plan.summary && <div className="px-4 py-3 text-[13px] text-muted-foreground/80 border-b border-white/[0.05] whitespace-pre-wrap">{plan.summary}</div>}
        {!mobile && (
          <div className="grid grid-cols-[52px_1.3fr_1.6fr_96px_84px_72px_28px] gap-3 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 border-b border-white/[0.06] sticky top-0 bg-[#050505]/90 backdrop-blur-md z-10">
            <div>Data</div><div>Descrição</div><div>Conta → categoria</div><div className="text-right">Valor</div><div>Certeza</div><div>Ação</div><div />
          </div>
        )}
        {(autoChecked > 0 || autoItems.length > 0) && (
          <div className="px-4 py-2 text-[12px] text-muted-foreground/80 border-b border-white/[0.05] flex flex-wrap gap-x-4 gap-y-1">
            {autoChecked > 0 && <span><Check className="inline w-3 h-3 text-emerald-400 mr-1" />{autoChecked} linha{autoChecked > 1 ? 's' : ''} já estava{autoChecked > 1 ? 'm' : ''} registrada{autoChecked > 1 ? 's' : ''} igual e {autoChecked > 1 ? 'foram conferidas' : 'foi conferida'} sem você precisar olhar</span>}
            {autoItems.length > 0 && (
              <button onClick={() => setShowAuto((v) => !v)} className="flex items-center gap-1 hover:text-foreground transition-colors">
                <ChevronRight className={cn('w-3 h-3 transition-transform', showAuto && 'rotate-90')} />
                {autoItems.length} valor{autoItems.length > 1 ? 'es' : ''} corrigido{autoItems.length > 1 ? 's' : ''} pelo extrato (centavos, <span className="font-mono">{formatBRL(autoTotal)}</span> no total)
              </button>
            )}
          </div>
        )}
        {visible.map((item, idx) => (
          /* the open row sits above its neighbours so its dropdowns are not drawn under the next row */
          <div key={item.id} className={cn('relative', expanded === item.id && 'z-30')}>
          {multiPeriod && (idx === 0 || (visible[idx - 1]!.date ?? '').slice(0, 7) !== (item.date ?? '').slice(0, 7)) && (
            <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 bg-white/[0.02] border-b border-white/[0.05]">{monthLabel(item.date)}</div>
          )}
          <PlanItemRow
            item={item}
            accountOptions={accountOptions}
            categoryOptions={categoryOptions}
            expanded={expanded === item.id}
            onToggle={() => setExpanded(expanded === item.id ? null : item.id)}
            onPatch={(body) => patch.mutate({ item, body })}
            disabled={!editable || patch.isPending}
            mobile={mobile}
          />
          </div>
        ))}
        {filter === 'all' && skipped.length > 0 && (
          <button onClick={() => setShowSkipped((v) => !v)} className="w-full flex items-center gap-2 px-3 py-2.5 text-[12px] text-muted-foreground/70 hover:text-foreground transition-colors border-b border-white/[0.05]">
            <ChevronRight className={cn('w-3 h-3 transition-transform', showSkipped && 'rotate-90')} />
            {skipped.length} linha{skipped.length > 1 ? 's' : ''} já registrada{skipped.length > 1 ? 's' : ''} · <span className="font-mono">{formatBRL(skippedTotal)}</span> · não entram de novo
          </button>
        )}
        {visible.length === 0 && <p className="p-6 text-[13px] text-muted-foreground/50 text-center">Nada para mostrar com este filtro.</p>}
      </div>

      {/* Sticky footer */}
      <div className="shrink-0 border-t border-white/[0.08] bg-[#050505]/95 backdrop-blur-md px-3 sm:px-4 py-3 space-y-2">
        <div className="flex items-center gap-3 text-[12px] flex-wrap">
          {balances.length > 1 ? (
            <span className="flex items-center gap-2 flex-wrap">
              {balances.map((b) => (
                <span key={b.period_end ?? ''} className="flex items-center gap-1" title={`${fmtDay(b.period_start ?? '')} a ${fmtDay(b.period_end ?? '')}: saldo depois do plano ${formatBRL(b.projected ?? 0)}, extrato ${formatBRL(b.statement_closing ?? 0)}`}>
                  {b.ok ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
                  <span className="capitalize">{monthLabel(b.period_start).split(' ')[0]}</span>
                  {!b.ok && <span className="text-rose-300 font-mono">{formatBRL(b.difference)}</span>}
                </span>
              ))}
              <span className="text-muted-foreground/60">· no fim, <span className="font-mono text-foreground/80">{formatBRL(balance?.projected ?? 0)}</span></span>
            </span>
          ) : balance ? (
            <span className="flex items-center gap-1.5">
              {balance.ok ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
              Saldo depois do plano <span className="font-mono">{formatBRL(balance.projected ?? 0)}</span> {balance.ok ? '=' : '≠'} extrato <span className="font-mono">{formatBRL(balance.statement_closing ?? 0)}</span>
              {!balance.ok && <span className="text-rose-300">(falta explicar {formatBRL(balance.difference)})</span>}
            </span>
          ) : <span className="text-muted-foreground/60">Este arquivo não traz saldo para conferir.</span>}
          {low.length > 0 && <span className="text-amber-300/80">· {low.length} {low.length > 1 ? 'itens em dúvida' : 'item em dúvida'}</span>}
        </div>
        {notice && <div className="text-[12px] text-foreground/80 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 flex justify-between gap-3"><span className="truncate">{notice}</span><button onClick={() => setNotice(null)} className="text-muted-foreground">✕</button></div>}
        <div className={cn('flex gap-2', mobile ? 'flex-col' : 'items-center')}>
          <form onSubmit={(e) => { e.preventDefault(); if (ask.trim()) askMut.mutate(ask.trim()); }} className="flex items-center gap-2 flex-1 px-3 h-10 rounded-xl border border-white/[0.1] bg-white/[0.03] focus-within:border-white/[0.25]">
            <Sparkles className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
            <input value={ask} onChange={(e) => setAsk(e.target.value)} disabled={!editable || askMut.isPending} placeholder="Peça uma mudança ao assistente… ex.: “divide o Liv Up em 300 básica e 102,80 suplementação”" className="flex-1 bg-transparent outline-none text-[13px] placeholder:text-muted-foreground/40 min-w-0" />
            <button type="submit" disabled={!ask.trim() || askMut.isPending} className="text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label="Enviar">{askMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '↵'}</button>
          </form>
          <div className="flex gap-2">
            <button onClick={() => { if (window.confirm('Descartar este plano?')) reject.mutate(); }} disabled={!editable || reject.isPending} className="h-10 px-3.5 rounded-xl border border-white/[0.12] text-[13px] font-semibold text-muted-foreground hover:text-rose-300 hover:border-rose-500/30 disabled:opacity-40 transition-all">Descartar plano</button>
            <button onClick={() => { const bad = balances.filter((b) => !b.ok); if (bad.length > 0 && !window.confirm(`O saldo não bate em ${bad.length > 1 ? `${bad.length} períodos` : 'um período'}: falta explicar ${bad.map((b) => formatBRL(b.difference)).join(', ')}. Gravar mesmo assim? A conferência fica em aberto com essa diferença.`)) return; approve.mutate(); }} disabled={!canApprove || approvableCount === 0} className="h-10 px-4 rounded-xl bg-emerald-400 text-[#04130c] text-[13px] font-semibold hover:bg-emerald-300 disabled:opacity-40 flex items-center gap-1.5 transition-all active:scale-[0.99] flex-1 sm:flex-none justify-center">
              {approve.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Aprovar {approvableCount} {approvableCount === 1 ? 'item' : 'itens'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
