import { useMemo } from 'react';
import { differenceInCalendarMonths, format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BudgetItemWithAccount, BudgetPlan } from '@/lib/api';

export type BudgetItemSummary = BudgetItemWithAccount & { target: number; spent: number; pct: number };

export interface BudgetHealthInput {
  plan: BudgetPlan;
  items: BudgetItemSummary[];
  totalTarget: number;
  totalSpent: number;
  periodTarget: number;
  periodSpent: number;
}

const fmt = (n: number) => `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

/** Budget health: period remaining, months left, biggest deviations and the advisor entry point. */
export function BudgetHealthCard({ data, onReviewWithAdvisor }: { data: BudgetHealthInput; onReviewWithAdvisor: (context: string) => void }) {
  const d = useMemo(() => {
    const today = new Date();
    const end = parseISO(data.plan.period_end);
    const monthsLeft = Math.max(0, differenceInCalendarMonths(end, today) + 1);
    const remaining = data.periodTarget - data.periodSpent;
    const perMonth = monthsLeft > 0 ? remaining / monthsLeft : remaining;
    const pace = data.totalTarget > 0 ? (data.totalSpent / data.totalTarget - 1) * 100 : 0;
    const withDev = data.items.filter((i) => i.target > 0).map((i) => ({ ...i, dev: (i.spent / i.target - 1) * 100 }));
    const over = [...withDev].filter((i) => i.dev > 0).sort((a, b) => b.dev - a.dev).slice(0, 2);
    const under = [...withDev].filter((i) => i.dev < 0).sort((a, b) => a.dev - b.dev).slice(0, 2);
    return { monthsLeft, remaining, perMonth, pace, over, under };
  }, [data]);

  const context = `Budget plan "${data.plan.name}" (${data.plan.period_start} to ${data.plan.period_end}). Spent ${fmt(data.periodSpent)} of ${fmt(data.periodTarget)} so far; ${d.monthsLeft} months left. Most over target: ${d.over.map((i) => `${i.account_full_name} ${i.dev > 0 ? '+' : ''}${Math.round(i.dev)}%`).join(', ') || 'none'}. Most under: ${d.under.map((i) => `${i.account_full_name} ${Math.round(i.dev)}%`).join(', ') || 'none'}.`;

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">Como vai o orçamento</p>
          <p className="text-[12px] text-white/50 mt-0.5">{data.plan.name} · {format(new Date(), 'MMMM', { locale: ptBR })} · {d.monthsLeft === 1 ? 'falta 1 mês' : `faltam ${d.monthsLeft} meses`}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3">
          <p className="text-[9px] uppercase tracking-widest text-white/35 font-bold">Ainda dá para gastar</p>
          <p className={cn('text-[16px] font-bold tracking-tight mt-1', d.remaining < 0 ? 'text-red-400' : 'text-white')}>{fmt(d.remaining)}</p>
          <p className="text-[10px] text-white/40 mt-0.5">{d.monthsLeft > 0 ? `${fmt(d.perMonth)} por mês` : 'período encerrado'}</p>
        </div>
        <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3">
          <p className="text-[9px] uppercase tracking-widest text-white/35 font-bold">Ritmo</p>
          <p className={cn('text-[16px] font-bold tracking-tight mt-1', d.pace > 0 ? 'text-red-400' : 'text-emerald-400')}>{d.pace > 0 ? '+' : ''}{Math.round(d.pace)}%</p>
          <p className="text-[10px] text-white/40 mt-0.5">{d.pace > 0 ? 'acima' : 'abaixo'} da meta neste período</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 text-[11px]">
        <div>
          <p className="text-[9px] uppercase tracking-widest text-red-400/60 font-bold mb-1">Mais acima da meta</p>
          {d.over.length === 0 && <p className="text-white/30">—</p>}
          {d.over.map((i) => <div key={i.id} className="flex justify-between gap-2"><span className="truncate text-white/70">{i.account_full_name.split(':').pop()}</span><span className="font-mono text-red-400">+{Math.round(i.dev)}%</span></div>)}
        </div>
        <div>
          <p className="text-[9px] uppercase tracking-widest text-emerald-400/60 font-bold mb-1">Mais abaixo da meta</p>
          {d.under.length === 0 && <p className="text-white/30">—</p>}
          {d.under.map((i) => <div key={i.id} className="flex justify-between gap-2"><span className="truncate text-white/70">{i.account_full_name.split(':').pop()}</span><span className="font-mono text-emerald-400">{Math.round(i.dev)}%</span></div>)}
        </div>
      </div>
      <button onClick={() => onReviewWithAdvisor(context)} className="mt-auto flex items-center justify-center gap-2 h-9 rounded-xl border border-white/[0.1] bg-white/[0.04] hover:bg-white/[0.08] text-[12px] font-semibold transition-all active:scale-[0.99]">
        <Sparkles className="w-3.5 h-3.5" /> Revisar com o assistente
      </button>
    </div>
  );
}
