import { cn } from '@/lib/utils';

interface BudgetBarProps {
  spent: number;
  target: number;
  minPct: number;
  maxPct: number;
  remaining: number;
  currency?: string;
  /** When true, max marker and Max label are hidden (period views). Bar turns red if spent > target. */
  hideMax?: boolean;
}

function fmt(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function BudgetBar({ spent, target, minPct, maxPct, remaining, currency = 'R$', hideMax = false }: BudgetBarProps) {
  const minMonthly = target * (minPct / 100);
  const maxMonthly = hideMax ? 0 : target * (maxPct / 100);
  const isOver = spent > target;
  const overSpend = isOver ? spent - target : 0;

  // Scale: expand to show overspend; otherwise pin to target so fill is proportional
  let scale: number;
  if (isOver) {
    scale = !hideMax && maxMonthly > 0 ? Math.max(maxMonthly, spent) : spent;
  } else {
    scale = target > 0 ? target : 1;
  }

  const normalFillPct = scale > 0 ? (Math.min(spent, target) / scale) * 100 : 0;
  const overFillLeft  = scale > 0 ? (target / scale) * 100 : 0;
  const overFillWidth = scale > 0 && overSpend > 0 ? (overSpend / scale) * 100 : 0;

  const minPos    = scale > 0 && minMonthly > 0 ? (minMonthly / scale) * 100 : 0;
  const targetPos = scale > 0 && isOver ? (target / scale) * 100 : 0;
  const maxPos    = !hideMax && scale > 0 && maxMonthly > 0 ? (maxMonthly / scale) * 100 : 0;

  return (
    <div className="w-full space-y-1.5">
      {/* Bar */}
      <div className="relative h-2 w-full rounded-full bg-white/[0.06] overflow-visible">
        {/* Normal fill: 0 → min(spent, target) */}
        <div
          className={cn(
            'absolute left-0 top-0 h-full transition-all duration-300 bg-white/40',
            isOver ? 'rounded-l-full' : 'rounded-full',
          )}
          style={{ width: `${normalFillPct}%` }}
        />

        {/* Over-budget fill: target → spent */}
        {overFillWidth > 0 && (
          <div
            className="absolute top-0 h-full bg-red-500/70 rounded-r-full"
            style={{ left: `${overFillLeft}%`, width: `${overFillWidth}%` }}
          />
        )}

        {/* Min marker */}
        {minPos > 0 && minPos < 100 && (
          <div
            className="absolute top-[-3px] h-[14px] w-px bg-white/25"
            style={{ left: `${minPos}%` }}
          />
        )}

        {/* Target marker — only when over, marks the white→red transition */}
        {isOver && targetPos > 0 && targetPos < 100 && (
          <div
            className="absolute top-[-3px] h-[14px] w-px bg-white/50"
            style={{ left: `${targetPos}%` }}
          />
        )}

        {/* Max marker */}
        {!hideMax && maxPos > 0 && maxPos <= 100 && (
          <div
            className="absolute top-[-3px] h-[14px] w-px bg-red-400/60"
            style={{ left: `${maxPos}%` }}
          />
        )}
      </div>

      {/* Helper values */}
      <div className="flex items-center gap-3 text-[10px] font-mono text-white/30 tabular-nums">
        {minMonthly > 0 && (
          <span>Min <span className="text-white/50">{fmt(minMonthly, currency)}</span></span>
        )}
        {!hideMax && (
          <span>Max <span className="text-white/50">{fmt(maxMonthly, currency)}</span></span>
        )}
        <span className="ml-auto">
          {remaining >= 0 ? (
            <>Rem <span className="text-white/50">{fmt(remaining, currency)}</span></>
          ) : (
            <>Over <span className="text-red-400/70">{fmt(-remaining, currency)}</span></>
          )}
        </span>
      </div>
    </div>
  );
}
