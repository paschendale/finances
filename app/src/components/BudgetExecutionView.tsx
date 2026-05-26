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

type RenderNode =
  | { type: 'item'; item: BudgetItemWithAccount; depth: number; isParent: boolean }
  | { type: 'group-header'; label: string };

interface BudgetExecutionViewProps {
  currentMonth: Date;
  periodView: 'monthly' | 'period';
  onNavigateToLedger: (accountId: string, startDate: string, endDate: string) => void;
  onCreatePlan?: () => void;
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

function buildRenderNodes(
  items: BudgetItemWithAccount[],
  accountIdSet: Set<string>,
): RenderNode[] {
  // Sort root-level items by parent_id so siblings with the same parent are adjacent
  const sortedItems = [...items].sort((a, b) => {
    const aIsRoot = !a.parent_id || !accountIdSet.has(a.parent_id);
    const bIsRoot = !b.parent_id || !accountIdSet.has(b.parent_id);
    if (aIsRoot && bIsRoot) {
      return (a.parent_id ?? '').localeCompare(b.parent_id ?? '');
    }
    return 0;
  });

  const ordered = buildHierarchy(sortedItems, null, accountIdSet);

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

  const nodes: RenderNode[] = [];
  const seenGroups = new Set<string>();

  for (const item of ordered) {
    const depth = getDepth(item);
    const isParent = items.some((other) => other.parent_id === item.account_id);

    // Emit a group-header when root-level items share a parent not in the budget
    if (depth === 0 && item.parent_id !== null && !accountIdSet.has(item.parent_id)) {
      const groupKey = item.parent_id;
      if (!seenGroups.has(groupKey)) {
        seenGroups.add(groupKey);
        const parts = item.account_full_name.split(':');
        const label = parts.length >= 2 ? parts[parts.length - 2] : null;
        if (label) nodes.push({ type: 'group-header', label });
      }
    }

    nodes.push({ type: 'item', item, depth, isParent });
  }

  return nodes;
}

export function BudgetExecutionView({ currentMonth, periodView, onNavigateToLedger, onCreatePlan }: BudgetExecutionViewProps) {
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
          <p className="text-[13px] text-muted-foreground">Create a plan to start tracking your budget.</p>
        </div>
        {onCreatePlan && (
          <button
            onClick={onCreatePlan}
            className="mt-2 px-5 py-2.5 rounded-xl bg-white text-black text-[13px] font-semibold hover:bg-white/90 active:scale-[0.98] transition-all"
          >
            Create Budget Plan
          </button>
        )}
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

  function handleRowClick(item: BudgetItemWithAccount) {
    const startDate = format(startOfMonth(currentMonth), 'yyyy-MM-dd');
    const endDate = format(endOfMonth(currentMonth), 'yyyy-MM-dd');
    onNavigateToLedger(item.account_id, startDate, endDate);
  }

  const accountIdSet = new Set(items.map((i) => i.account_id));
  const renderNodes = buildRenderNodes(items, accountIdSet);

  return (
    <div className="w-full rounded-xl border border-white/[0.08] bg-white/[0.01] overflow-hidden">
      {/* Header row */}
      <div className="flex items-center px-4 py-2 border-b border-white/[0.06]">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/30 w-36 shrink-0">Category</span>
        <span className="flex-1 text-[11px] font-bold uppercase tracking-[0.12em] text-white/30">Progress</span>
        <span className="w-20 text-right text-[11px] font-bold uppercase tracking-[0.12em] text-white/30">Spent</span>
      </div>

      {renderNodes.length === 0 ? (
        <div className="py-12 text-center text-[13px] text-muted-foreground">
          No budget categories defined. Switch to Planning mode to add categories.
        </div>
      ) : (
        renderNodes.map((node, idx) => {
          if (node.type === 'group-header') {
            return (
              <div
                key={`group-${node.label}-${idx}`}
                className="px-4 py-1.5 border-b border-white/[0.04] bg-white/[0.02]"
              >
                <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/25">
                  {node.label}
                </span>
              </div>
            );
          }

          const { item, depth, isParent } = node;
          const { spentThisMonth, spentTotal, spentBeforeCurrent } = getSpentForAccount(item.account_id, spending);

          let spent: number;
          let target: number;
          let remaining: number;

          if (periodView === 'period') {
            spent = spentTotal;
            target = Number(item.period_amount);
            remaining = target - spentTotal;
          } else {
            spent = spentThisMonth;
            target = computeAdjustedMonthly(
              Number(item.period_amount),
              numMonths,
              monthIndex,
              spentBeforeCurrent,
            );
            remaining = target - spentThisMonth;
          }

          return (
            <BudgetCategoryRow
              key={item.id}
              item={item}
              spent={spent}
              target={target}
              remaining={remaining}
              depth={depth}
              isParent={isParent}
              onClick={() => handleRowClick(item)}
            />
          );
        })
      )}
    </div>
  );
}
