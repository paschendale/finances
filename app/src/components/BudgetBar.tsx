import { cn } from '@/lib/utils';

interface BudgetBarProps {
  spent: number;
  target: number;
  minPct: number;
  maxPct: number;
  remaining: number;
  currency?: string;
}

function fmt(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function BudgetBar({ spent, target, minPct, maxPct, remaining, currency = 'R$' }: BudgetBarProps) {
  const minMonthly = target * (minPct / 100);
  const maxMonthly = target * (maxPct / 100);

  // Determine bar state and scale
  let scale: number;
  let showTarget = false;
  let showMax = false;
  let overMax = false;

  if (target === 0) {
    scale = spent > 0 ? spent : 1;
    overMax = spent > 0;
  } else if (spent < target) {
    scale = target;
  } else if (spent <= maxMonthly) {
    scale = maxMonthly > 0 ? maxMonthly : spent;
    showTarget = true;
    showMax = true;
  } else {
    scale = spent;
    showTarget = true;
    showMax = true;
    overMax = true;
  }

  const fillPct = scale > 0 ? Math.min((spent / scale) * 100, 100) : 0;
  const minPos = scale > 0 ? (minMonthly / scale) * 100 : 0;
  const targetPos = scale > 0 ? (target / scale) * 100 : 0;
  const maxPos = scale > 0 && maxMonthly > 0 ? (maxMonthly / scale) * 100 : 0;

  return (
    <div className="w-full space-y-1.5">
      {/* Bar */}
      <div className="relative h-2 w-full rounded-full bg-white/[0.06] overflow-visible">
        {/* Fill */}
        <div
          className={cn(
            'absolute left-0 top-0 h-full rounded-full transition-all duration-300',
            overMax ? 'bg-red-500/70' : 'bg-white/40',
          )}
          style={{ width: `${fillPct}%` }}
        />

        {/* Min marker */}
        {minPos > 0 && minPos < 100 && (
          <div
            className="absolute top-[-3px] h-[14px] w-px bg-white/25"
            style={{ left: `${minPos}%` }}
          />
        )}

        {/* Target marker */}
        {showTarget && targetPos > 0 && targetPos < 100 && (
          <div
            className="absolute top-[-3px] h-[14px] w-px bg-blue-400/60"
            style={{ left: `${targetPos}%` }}
          />
        )}

        {/* Max marker */}
        {showMax && maxPos > 0 && maxPos <= 100 && (
          <div
            className="absolute top-[-3px] h-[14px] w-px bg-red-400/60"
            style={{ left: `${maxPos}%` }}
          />
        )}
      </div>

      {/* Helper values */}
      <div className="flex gap-3 text-[10px] font-mono text-white/30 tabular-nums">
        <span>Min <span className="text-white/50">{fmt(minMonthly, currency)}</span></span>
        <span>Target <span className="text-white/50">{fmt(target, currency)}</span></span>
        <span>Max <span className={cn(overMax ? 'text-red-400/70' : 'text-white/50')}>{fmt(maxMonthly, currency)}</span></span>
        <span className="ml-auto">Rem <span className="text-white/50">{fmt(remaining, currency)}</span></span>
      </div>
    </div>
  );
}
