import { type BudgetItemWithAccount } from '@/lib/api';
import { AccountIcon } from './AccountIcon';
import { BudgetBar } from './BudgetBar';
import { cn } from '@/lib/utils';

interface BudgetCategoryRowProps {
  item: BudgetItemWithAccount;
  spent: number;
  target: number;
  remaining: number;
  depth: number;
  isParent?: boolean;
  onClick: () => void;
}

export function BudgetCategoryRow({ item, spent, target, remaining, depth, isParent, onClick }: BudgetCategoryRowProps) {
  const indentPx = depth * 20;

  const parts = item.account_full_name.split(':');
  const leafName = parts[parts.length - 1];
  // Only show parent prefix at root level (depth 0); if depth > 0, the parent row is already visible above
  const parentName = depth === 0 && parts.length >= 2 ? parts[parts.length - 2] : null;

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-4 py-3 transition-colors border-b border-white/[0.04] group',
        isParent
          ? 'bg-white/[0.03] hover:bg-white/[0.05]'
          : 'hover:bg-white/[0.03]',
      )}
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
          <span className={cn(
            'text-[13px] truncate tracking-[-0.01em]',
            isParent ? 'font-semibold text-foreground/90' : 'font-medium text-foreground/80',
          )}>
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
      </div>
    </button>
  );
}
