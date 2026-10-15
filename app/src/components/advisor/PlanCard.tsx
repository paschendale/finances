import { useMemo } from 'react';
import { ClipboardCheck, Check, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { autoCheckedCount, canApproveFromCard, formatBRL, type Plan } from '@/lib/advisor-api';

const fmtDay = (d: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d); return m ? `${m[3]}/${m[2]}` : d; };

export function PlanCard({
  plan,
  onReview,
  onApprove,
  onReject,
  busy,
}: {
  plan: Plan;
  onReview: () => void;
  onApprove: () => void;
  onReject: () => void;
  busy?: boolean;
}) {
  const balance = plan.result?.balance ?? null;
  const balances = plan.result?.balances ?? [];
  const apply = plan.result?.apply ?? null;
  const autoChecked = autoCheckedCount(plan);
  const periods = balances.length > 1 ? `${balances.length} períodos · ${balances.filter((b) => b.ok).length} batem` : null;
  const approvable = canApproveFromCard(plan);
  const statusLabel = useMemo(() => {
    switch (plan.status) {
      case 'pending_approval': return plan.version > 1 ? 'revisado · esperando sua aprovação' : 'esperando sua aprovação';
      case 'applying': return 'gravando…';
      case 'applied': return 'gravado';
      case 'rejected': return 'descartado';
      case 'failed': return 'deu erro';
      default: return plan.status;
    }
  }, [plan.status, plan.version]);
  const pending = plan.status === 'pending_approval';

  return (
    <div className="rounded-2xl border border-white/[0.1] bg-white/[0.025] overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-white/[0.06]">
        <ClipboardCheck className={cn('w-3.5 h-3.5', pending ? 'text-amber-400' : plan.status === 'applied' ? 'text-emerald-400' : 'text-muted-foreground')} />
        <span className="text-[13px] font-semibold truncate">{plan.title}</span>
        <span className="text-[11px] text-muted-foreground/60 ml-1 shrink-0">{statusLabel}</span>
        <span className="flex-1" />
        <span className="text-[11px] text-muted-foreground/50 shrink-0">{periods ?? `${plan.item_count} ${plan.item_count === 1 ? 'item' : 'itens'}`}</span>
      </div>
      <div className="grid grid-cols-4 gap-px bg-white/[0.06]">
        {[['Novos', plan.create_count], ['Correções', plan.update_count], ['Excluir', plan.delete_count ?? 0], ['Conferidos', plan.skip_count + autoChecked]].map(([label, n]) => (
          <div key={label as string} className="px-3 py-2 bg-[#0d0d0e]">
            <div className="text-[9px] uppercase tracking-widest text-muted-foreground/50 font-bold">{label}</div>
            <div className={cn('font-mono text-[16px]', (n as number) === 0 && 'text-muted-foreground/40')}>{n as number}</div>
          </div>
        ))}
      </div>
      {balance && (
        <div className={cn('flex items-center gap-2 px-3.5 py-2 text-[12px] border-t border-white/[0.06]', balance.ok ? 'bg-emerald-500/[0.06]' : 'bg-rose-500/[0.06]')}>
          {balance.ok ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
          <span>
            {balance.ok
              ? <>O saldo bate com o extrato{balance.account_name ? ` · ${balance.account_name}` : ''} · <span className="font-mono">{formatBRL(balance.statement_closing ?? 0)}</span></>
              : <>Falta explicar <span className="font-mono text-rose-300">{formatBRL(balance.difference)}</span> em relação ao extrato{balance.outstanding_count ? ` · ${balance.outstanding_count} lançamento${balance.outstanding_count === 1 ? '' : 's'} sem linha no extrato` : ''}</>}
          </span>
        </div>
      )}
      {apply && (
        <div className="px-3.5 py-2 text-[12px] border-t border-white/[0.06] text-muted-foreground/80">
          {apply.applied} gravado{apply.applied === 1 ? '' : 's'} · {apply.skipped} já estava{apply.skipped === 1 ? '' : 'm'}{apply.failed ? ` · ${apply.failed} com erro` : ''}
          {apply.reconciliation && (
            <> · extrato até {fmtDay(apply.reconciliation.period_end)} <span className={cn('font-semibold', apply.reconciliation.status === 'open' ? 'text-amber-300' : 'text-emerald-300')}>{apply.reconciliation.status === 'open' ? 'ainda não bate' : apply.reconciliation.status === 'adjusted' ? 'conferido com ajuste' : 'conferido'}</span>
              {apply.reconciliation.status === 'open' && apply.reconciliation.difference != null && <> · diferença <span className="font-mono">{formatBRL(apply.reconciliation.difference)}</span></>}
            </>
          )}
        </div>
      )}
      {pending && !approvable && (
        <div className="px-3.5 py-1.5 text-[11px] text-amber-300/80 border-t border-white/[0.06]">
          {balance && !balance.ok ? 'O saldo não bate · revise antes de aprovar' : 'Alguns itens estão em dúvida · confirme na revisão'}
        </div>
      )}
      <div className="flex gap-2 p-3 border-t border-white/[0.06]">
        <button onClick={onReview} className={cn('flex-1 h-9 rounded-xl text-[13px] font-semibold transition-all active:scale-[0.99] border', pending && !approvable ? 'bg-white text-black border-transparent hover:bg-white/90' : 'border-white/[0.12] bg-white/[0.04] hover:bg-white/[0.08]')}>
          {pending ? `Revisar ${plan.item_count - plan.skip_count} ${plan.item_count - plan.skip_count === 1 ? 'item' : 'itens'}` : 'Ver detalhes'}
        </button>
        {pending && (
          <>
            <button onClick={onReject} disabled={busy} className="h-9 px-3 rounded-xl text-[13px] font-semibold border border-white/[0.12] text-muted-foreground hover:text-rose-300 hover:border-rose-500/30 transition-all disabled:opacity-50">Descartar</button>
            <button onClick={onApprove} disabled={!approvable || busy} className="h-9 px-4 rounded-xl text-[13px] font-semibold bg-emerald-400 text-[#04130c] hover:bg-emerald-300 transition-all active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Aprovar
            </button>
          </>
        )}
      </div>
    </div>
  );
}
