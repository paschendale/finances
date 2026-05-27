import { Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type BudgetItemWithAccount } from '@/lib/api';
import { AccountIcon } from './AccountIcon';
import { BudgetBar } from './BudgetBar';

interface BudgetCategoryRowProps {
  item: BudgetItemWithAccount;
  spent: number;
  target: number;
  remaining: number;
  onClick: () => void;
  /** Hides max marker and Max label (use for period views) */
  hideMax?: boolean;
  /** Optional adjustment notice shown below the bar (monthly view only) */
  helperText?: string;
  /** Opens the insights modal for this category */
  onInsights?: () => void;
}

export function BudgetCategoryRow({ item, spent, target, remaining, onClick, hideMax, helperText, onInsights }: BudgetCategoryRowProps) {
  const parts = item.account_full_name.split(':');
  const leafName = parts[parts.length - 1];

  return (
    <div
      onClick={onClick}
      className="w-full text-left px-4 py-3 hover:bg-white/[0.03] transition-colors border-b border-white/[0.04] last:border-0 group cursor-pointer"
    >
      <div className="flex items-center gap-3">
        {/* Icon + name */}
        <div className="flex items-center gap-2 min-w-0 w-36 shrink-0">
          <AccountIcon
            accountName={item.account_full_name}
            icon={item.icon}
            color={item.color}
            size="sm"
          />
          <span className="text-[13px] font-medium text-foreground/80 truncate tracking-[-0.01em]">
            {leafName}
          </span>
        </div>

        {/* Bar */}
        <div className="flex-1 min-w-0">
          <BudgetBar
            spent={spent}
            target={target}
            minPct={item.min_pct}
            maxPct={item.max_pct}
            remaining={remaining}
            hideMax={hideMax}
          />
          {helperText && (
            <p className="text-[10px] font-mono text-amber-400/50 mt-1 opacity-60 group-hover:opacity-100 transition-opacity duration-150">
              {helperText}
            </p>
          )}
        </div>

        {/* Target (top) / Spent (bottom) */}
        <div className="shrink-0 w-28 text-right space-y-0.5">
          <div className="flex items-baseline justify-end gap-1.5">
            <span className="text-[9px] font-medium uppercase tracking-wide text-white/20 shrink-0">Target</span>
            <span className={cn(
              'text-[11px] font-mono tabular-nums transition-colors',
              helperText
                ? 'text-amber-400/80 bg-amber-500/10 rounded px-1'
                : 'text-white/30',
            )}>
              R$&nbsp;{target.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </span>
          </div>
          <div className="flex items-baseline justify-end gap-1.5">
            <span className="text-[9px] font-medium uppercase tracking-wide text-white/20 shrink-0">Spent</span>
            <span className="text-[12px] font-mono text-white/50 tabular-nums">
              R$&nbsp;{spent.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </span>
          </div>
        </div>

        {/* Insights button / chevron-alignment spacer */}
        <div className="w-8 shrink-0 flex items-center justify-center">
          {onInsights && (
            <button
              onClick={(e) => { e.stopPropagation(); onInsights(); }}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-amber-400/50 hover:text-amber-400 hover:bg-amber-400/10"
              aria-label="Category insights"
            >
              <Zap className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
