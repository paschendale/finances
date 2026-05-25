import { useQuery } from '@tanstack/react-query';
import { differenceInCalendarMonths, format, startOfMonth, endOfMonth } from 'date-fns';
import {
  fetchCurrentBudgetPlan,
  fetchBudgetItems,
  fetchBudgetMonthlySpending,
  type BudgetItemWithAccount,
  type BudgetMonthlySpending,
} from '@/lib/api';
import { BudgetCategoryRow } from './BudgetCategoryRow';
import { PiggyBank } from 'lucide-react';

interface BudgetExecutionViewProps {
  currentMonth: Date;
  periodView: 'monthly' | 'period';
  onNavigateToLedger: (accountId: string, startDate: string, endDate: string) => void;
}

function computeAdjustedMonthly(
  periodAmount: number,
  numMonths: number,
  monthIndex: number,
  spentBeforeCurrentMonth: number,
): number {
  if (monthIndex <= 0) return periodAmount / numMonths;
  const remaining = periodAmount - spentBeforeCurrentMonth;
  const remainingMonths = numMonths - monthIndex;
  if (remainingMonths <= 0) return remaining;
  return remaining / remainingMonths;
}

function buildHierarchy(
  items: BudgetItemWithAccount[],
  parentAccountId: string | null,
  accountIdSet: Set<string>,
): BudgetItemWithAccount[] {
  return items
    .filter((item) => {
      if (parentAccountId === null) {
        return item.parent_id === null || !accountIdSet.has(item.parent_id);
      }
      return item.parent_id === parentAccountId;
    })
    .flatMap((item) => [item, ...buildHierarchy(items, item.account_id, accountIdSet)]);
}

export function BudgetExecutionView({ currentMonth, periodView, onNavigateToLedger }: BudgetExecutionViewProps) {
  const { data: plan, isLoading: planLoading } = useQuery({
    queryKey: ['budgetCurrentPlan'],
    queryFn: fetchCurrentBudgetPlan,
  });

  const { data: items = [], isLoading: itemsLoading } = useQuery({
    queryKey: ['budgetItems', plan?.id],
    queryFn: () => fetchBudgetItems(plan!.id),
    enabled: !!plan?.id,
  });

  const { data: spending = [], isLoading: spendingLoading } = useQuery({
    queryKey: ['budgetMonthlySpending', plan?.id],
    queryFn: () => fetchBudgetMonthlySpending(plan!.id),
    enabled: !!plan?.id,
  });

  const isLoading = planLoading || itemsLoading || spendingLoading;

  if (isLoading) {
    return (
      <div className="w-full space-y-3 animate-pulse">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-14 bg-white/[0.03] rounded-xl" />
        ))}
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <PiggyBank className="w-10 h-10 text-white/20" />
        <div className="text-center space-y-1">
          <p className="text-[15px] font-medium text-foreground/60">No budget plan active</p>
          <p className="text-[13px] text-muted-foreground">Switch to Planning mode to create your first plan.</p>
        </div>
      </div>
    );
  }

  const planStart = new Date(plan.period_start + 'T00:00:00');
  const planEnd = new Date(plan.period_end + 'T00:00:00');
  const numMonths = differenceInCalendarMonths(planEnd, planStart) + 1;
  const monthIndex = differenceInCalendarMonths(startOfMonth(currentMonth), planStart);
  const currentMonthKey = format(startOfMonth(currentMonth), 'yyyy-MM-dd');

  function getSpentForAccount(accountId: string, monthlySpending: BudgetMonthlySpending[]): {
    spentThisMonth: number;
    spentTotal: number;
    spentBeforeCurrent: number;
  } {
    const rows = monthlySpending.filter((s) => s.account_id === accountId);
    const spentThisMonth = rows.find((s) => s.month === currentMonthKey)?.spent ?? 0;
    const spentTotal = rows.reduce((sum, s) => sum + Number(s.spent), 0);
    const spentBeforeCurrent = rows
      .filter((s) => s.month < currentMonthKey)
      .reduce((sum, s) => sum + Number(s.spent), 0);
    return { spentThisMonth: Number(spentThisMonth), spentTotal, spentBeforeCurrent };
  }

  function getPeriodRemaining(item: BudgetItemWithAccount): number {
    const rows = spending.filter((s) => s.account_id === item.account_id);
    const spentAll = rows.reduce((sum, s) => sum + Number(s.spent), 0);
    return item.period_amount - spentAll;
  }

  const accountIdSet = new Set(items.map((i) => i.account_id));
  const orderedItems = buildHierarchy(items, null, accountIdSet);

  function getDepth(item: BudgetItemWithAccount): number {
    let depth = 0;
    let parentId = item.parent_id;
    while (parentId !== null && accountIdSet.has(parentId)) {
      depth++;
      const parent = items.find((i) => i.account_id === parentId);
      parentId = parent?.parent_id ?? null;
    }
    return depth;
  }

  function handleRowClick(item: BudgetItemWithAccount) {
    const startDate = format(startOfMonth(currentMonth), 'yyyy-MM-dd');
    const endDate = format(endOfMonth(currentMonth), 'yyyy-MM-dd');
    onNavigateToLedger(item.account_id, startDate, endDate);
  }

  return (
    <div className="w-full rounded-xl border border-white/[0.08] bg-white/[0.01] overflow-hidden">
      {/* Header row */}
      <div className="flex items-center px-4 py-2 border-b border-white/[0.06]">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/30 w-36 shrink-0">Category</span>
        <span className="flex-1 text-[11px] font-bold uppercase tracking-[0.12em] text-white/30">Progress</span>
        <span className="w-20 text-right text-[11px] font-bold uppercase tracking-[0.12em] text-white/30">Spent</span>
      </div>

      {orderedItems.length === 0 ? (
        <div className="py-12 text-center text-[13px] text-muted-foreground">
          No budget categories defined. Switch to Planning mode to add categories.
        </div>
      ) : (
        orderedItems.map((item) => {
          const depth = getDepth(item);
          const { spentThisMonth, spentTotal, spentBeforeCurrent } = getSpentForAccount(item.account_id, spending);

          let spent: number;
          let target: number;

          if (periodView === 'period') {
            spent = spentTotal;
            target = Number(item.period_amount);
          } else {
            spent = spentThisMonth;
            target = computeAdjustedMonthly(
              Number(item.period_amount),
              numMonths,
              monthIndex,
              spentBeforeCurrent,
            );
          }

          const periodRemaining = getPeriodRemaining(item);

          return (
            <BudgetCategoryRow
              key={item.id}
              item={item}
              spent={spent}
              target={target}
              periodRemaining={periodRemaining}
              depth={depth}
              onClick={() => handleRowClick(item)}
            />
          );
        })
      )}
    </div>
  );
}
