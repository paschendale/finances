import { useMemo } from 'react';
import { ClipboardCheck, Check, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { canApproveFromCard, formatBRL, type Plan } from '@/lib/advisor-api';

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
  const apply = plan.result?.apply ?? null;
  const approvable = canApproveFromCard(plan);
  const statusLabel = useMemo(() => {
    switch (plan.status) {
      case 'pending_approval': return `v${plan.version} · pending approval`;
      case 'applying': return 'applying…';
      case 'applied': return 'applied';
      case 'rejected': return 'rejected';
      case 'failed': return 'failed';
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
        <span className="text-[11px] text-muted-foreground/50 shrink-0">{plan.item_count} items</span>
      </div>
      <div className="grid grid-cols-4 gap-px bg-white/[0.06]">
        {[['Create', plan.create_count], ['Update', plan.update_count], ['Skip', plan.skip_count], ['Adjust', plan.adjust_count]].map(([label, n]) => (
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
              ? <>Balance check passed{balance.account_name ? ` · ${balance.account_name}` : ''} · <span className="font-mono">{formatBRL(balance.statement_closing ?? 0)}</span></>
              : <>Difference of <span className="font-mono text-rose-300">{formatBRL(balance.difference)}</span> against the statement{balance.outstanding_count ? ` · ${balance.outstanding_count} outstanding` : ''}</>}
          </span>
        </div>
      )}
      {apply && (
        <div className="px-3.5 py-2 text-[12px] border-t border-white/[0.06] text-muted-foreground/80">
          {apply.applied} applied · {apply.skipped} skipped{apply.failed ? ` · ${apply.failed} failed` : ''}
          {apply.reconciliation && (
            <> · reconciliation <span className={cn('font-semibold', apply.reconciliation.status === 'open' ? 'text-amber-300' : 'text-emerald-300')}>{apply.reconciliation.status}</span> through {apply.reconciliation.period_end}
              {apply.reconciliation.status === 'open' && apply.reconciliation.difference != null && <> · gap <span className="font-mono">{formatBRL(apply.reconciliation.difference)}</span></>}
            </>
          )}
        </div>
      )}
      {pending && !approvable && (
        <div className="px-3.5 py-1.5 text-[11px] text-amber-300/80 border-t border-white/[0.06]">
          {balance && !balance.ok ? 'Balance check failed · review before approving' : `${plan.min_confidence.toFixed(2)} min confidence · confirm doubtful items in Review`}
        </div>
      )}
      <div className="flex gap-2 p-3 border-t border-white/[0.06]">
        <button onClick={onReview} className={cn('flex-1 h-9 rounded-xl text-[13px] font-semibold transition-all active:scale-[0.99] border', pending && !approvable ? 'bg-white text-black border-transparent hover:bg-white/90' : 'border-white/[0.12] bg-white/[0.04] hover:bg-white/[0.08]')}>
          Review {pending ? `${plan.item_count - plan.skip_count} items` : ''}
        </button>
        {pending && (
          <>
            <button onClick={onReject} disabled={busy} className="h-9 px-3 rounded-xl text-[13px] font-semibold border border-white/[0.12] text-muted-foreground hover:text-rose-300 hover:border-rose-500/30 transition-all disabled:opacity-50">Reject</button>
            <button onClick={onApprove} disabled={!approvable || busy} className="h-9 px-4 rounded-xl text-[13px] font-semibold bg-emerald-400 text-[#04130c] hover:bg-emerald-300 transition-all active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Approve
            </button>
          </>
        )}
      </div>
    </div>
  );
}
