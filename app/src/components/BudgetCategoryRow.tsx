import { type BudgetItemWithAccount } from '@/lib/api';
import { AccountIcon } from './AccountIcon';
import { BudgetBar } from './BudgetBar';

interface BudgetCategoryRowProps {
  item: BudgetItemWithAccount;
  spent: number;
  target: number;
  remaining: number;
  /** True for items whose parent is NOT in budget — show `parent › leaf` label */
  showParentPrefix?: boolean;
  onClick: () => void;
}

export function BudgetCategoryRow({ item, spent, target, remaining, showParentPrefix, onClick }: BudgetCategoryRowProps) {
  const parts = item.account_full_name.split(':');
  const leafName = parts[parts.length - 1];
  const parentName = showParentPrefix && parts.length >= 2 ? parts[parts.length - 2] : null;

  return (
    <button
      onClick={onClick}
      className="w-full text-left px-4 py-3 hover:bg-white/[0.03] transition-colors border-b border-white/[0.04] last:border-0 group"
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
            {parentName && (
              <span className="text-white/30 font-normal">{parentName} <span className="text-white/20">›</span>{' '}</span>
            )}
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
          />
        </div>

        {/* Spent amount */}
        <div className="text-[12px] font-mono text-white/50 tabular-nums shrink-0 w-20 text-right">
          R$ {spent.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
        </div>
        {/* Spacer matching header chevron column */}
        <div className="w-8 shrink-0" />
      </div>
    </button>
  );
}
