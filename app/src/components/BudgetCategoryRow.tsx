import { type BudgetItemWithAccount } from '@/lib/api';
import { AccountIcon } from './AccountIcon';
import { BudgetBar } from './BudgetBar';
import { formatHierarchicalName } from '@/lib/utils';

interface BudgetCategoryRowProps {
  item: BudgetItemWithAccount;
  spent: number;
  target: number;
  periodRemaining: number;
  depth: number;
  onClick: () => void;
}

export function BudgetCategoryRow({ item, spent, target, periodRemaining, depth, onClick }: BudgetCategoryRowProps) {
  const indentPx = depth * 20;

  return (
    <button
      onClick={onClick}
      className="w-full text-left px-4 py-3 hover:bg-white/[0.03] transition-colors border-b border-white/[0.04] group"
      style={{ paddingLeft: `${16 + indentPx}px` }}
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
            {formatHierarchicalName(item.account_name)}
          </span>
        </div>

        {/* Bar */}
        <div className="flex-1 min-w-0">
          <BudgetBar
            spent={spent}
            target={target}
            minPct={item.min_pct}
            maxPct={item.max_pct}
            remaining={periodRemaining}
          />
        </div>

        {/* Spent amount */}
        <div className="text-[12px] font-mono text-white/50 tabular-nums shrink-0 w-20 text-right">
          R$ {spent.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
        </div>
      </div>
    </button>
  );
}
