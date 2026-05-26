import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { differenceInCalendarMonths, format, parseISO, startOfMonth, endOfMonth } from 'date-fns';
import { ChevronDown, ChevronRight, PiggyBank } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  fetchCurrentBudgetPlan,
  fetchBudgetItems,
  fetchBudgetMonthlySpending,
  fetchBudgetPeriodTotals,
  type BudgetItemWithAccount,
  type BudgetMonthlySpending,

} from '@/lib/api';
import { BudgetCategoryRow } from './BudgetCategoryRow';
import { BudgetBar } from './BudgetBar';

interface BudgetExecutionViewProps {
  currentMonth: Date;
  periodView: 'monthly' | 'period';
  onNavigateToLedger: (accountId: string, startDate: string, endDate: string) => void;
  onCreatePlan?: () => void;
}

// ─── helpers ────────────────────────────────────────────────────────────────

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

interface SpentData {
  spentThisMonth: number;
  spentTotal: number;
  spentBeforeCurrent: number;
}

function getSpentForAccount(
  accountId: string,
  spending: BudgetMonthlySpending[],
  currentMonthKey: string,
): SpentData {
  const rows = spending.filter((s) => s.account_id === accountId);
  const spentThisMonth = Number(rows.find((s) => s.month === currentMonthKey)?.spent ?? 0);
  const spentTotal = rows.reduce((sum, s) => sum + Number(s.spent), 0);
  const spentBeforeCurrent = rows
    .filter((s) => s.month < currentMonthKey)
    .reduce((sum, s) => sum + Number(s.spent), 0);
  return { spentThisMonth, spentTotal, spentBeforeCurrent };
}

// ─── grouping model ──────────────────────────────────────────────────────────

interface Group {
  key: string;
  label: string;
  ownerItem: BudgetItemWithAccount | null; // parent item in budget, or null
  childItems: BudgetItemWithAccount[];     // non-owner items shown under this header
  minSortOrder: number;
}

function buildGroups(items: BudgetItemWithAccount[]): Group[] {
  const accountIdSet = new Set(items.map((i) => i.account_id));
  const groups = new Map<string, Group>();

  // First pass: register owner groups (parent items in budget that have children in budget)
  for (const item of items) {
    const hasChildren = items.some((other) => other.parent_id === item.account_id);
    if (hasChildren) {
      groups.set(item.account_id, {
        key: item.account_id,
        label: item.account_name,
        ownerItem: item,
        childItems: [],
        minSortOrder: item.sort_order,
      });
    }
  }

  // Second pass: assign each item to a group
  for (const item of items) {
    const hasChildren = items.some((other) => other.parent_id === item.account_id);
    if (hasChildren) continue; // already registered as group owner above

    if (item.parent_id !== null && accountIdSet.has(item.parent_id)) {
      // Child of an owner item → append to that owner's group
      const g = groups.get(item.parent_id)!;
      g.childItems.push(item);
      g.minSortOrder = Math.min(g.minSortOrder, item.sort_order);
    } else if (item.parent_id !== null && !accountIdSet.has(item.parent_id)) {
      // Has a parent in the hierarchy but that parent is NOT in budget → label-only group keyed by parent_id
      const gKey = item.parent_id;
      if (!groups.has(gKey)) {
        const parts = item.account_full_name.split(':');
        const label = parts.length >= 2 ? parts[parts.length - 2] : item.account_name;
        groups.set(gKey, { key: gKey, label, ownerItem: null, childItems: [], minSortOrder: item.sort_order });
      }
      const g = groups.get(gKey)!;
      g.childItems.push(item);
      g.minSortOrder = Math.min(g.minSortOrder, item.sort_order);
    } else {
      // Orphan item (no parent at all) — its own label-only group
      const gKey = `orphan-${item.account_id}`;
      groups.set(gKey, {
        key: gKey,
        label: item.account_name,
        ownerItem: null,
        childItems: [item],
        minSortOrder: item.sort_order,
      });
    }
  }

  return [...groups.values()].sort((a, b) => a.minSortOrder - b.minSortOrder);
}

// ─── component ───────────────────────────────────────────────────────────────

export function BudgetExecutionView({
  currentMonth,
  periodView,
  onNavigateToLedger,
  onCreatePlan,
}: BudgetExecutionViewProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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

  const { data: periodTotals = [], isLoading: totalsLoading } = useQuery({
    queryKey: ['budgetPeriodTotals', plan?.id],
    queryFn: () => fetchBudgetPeriodTotals(plan!.id),
    enabled: !!plan?.id,
  });

  const isLoading = planLoading || itemsLoading || spendingLoading || totalsLoading;

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

  function resolveItemValues(item: BudgetItemWithAccount): { spent: number; target: number; remaining: number } {
    const { spentThisMonth, spentTotal, spentBeforeCurrent } = getSpentForAccount(
      item.account_id,
      spending,
      currentMonthKey,
    );
    if (periodView === 'period') {
      const target = Number(item.period_amount);
      return { spent: spentTotal, target, remaining: target - spentTotal };
    }
    const target = computeAdjustedMonthly(Number(item.period_amount), numMonths, monthIndex, spentBeforeCurrent);
    return { spent: spentThisMonth, target, remaining: target - spentThisMonth };
  }

  function aggregateGroup(group: Group): { spent: number; target: number; remaining: number } {
    const allItems = group.ownerItem ? [group.ownerItem, ...group.childItems] : group.childItems;
    return allItems.reduce(
      (acc, item) => {
        const v = resolveItemValues(item);
        return { spent: acc.spent + v.spent, target: acc.target + v.target, remaining: acc.remaining + v.remaining };
      },
      { spent: 0, target: 0, remaining: 0 },
    );
  }

  function handleRowClick(item: BudgetItemWithAccount) {
    const startDate = format(startOfMonth(currentMonth), 'yyyy-MM-dd');
    const endDate = format(endOfMonth(currentMonth), 'yyyy-MM-dd');
    onNavigateToLedger(item.account_id, startDate, endDate);
  }

  function toggleCollapse(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // ── "Outros" computation ──────────────────────────────────────────────────
  const totalBudgetedSpent = periodView === 'period'
    ? spending.reduce((sum, s) => sum + Number(s.spent), 0)
    : spending
        .filter((s) => s.month === currentMonthKey)
        .reduce((sum, s) => sum + Number(s.spent), 0);

  const totalAllSpent = periodView === 'period'
    ? periodTotals.reduce((sum, t) => sum + Number(t.total_spent), 0)
    : Number(periodTotals.find((t) => t.month === currentMonthKey)?.total_spent ?? 0);

  const othersSpent = Math.max(0, totalAllSpent - totalBudgetedSpent);

  // ── render ────────────────────────────────────────────────────────────────
  const groups = buildGroups(items);

  return (
    <div className="w-full space-y-1">
      {/* Plan title */}
      <div className="px-1 pb-2 flex items-baseline gap-3">
        <span className="text-[15px] font-semibold text-foreground/80">{plan.name}</span>
        <span className="text-[11px] font-mono text-white/30">
          {format(parseISO(plan.period_start), 'MMM yyyy')} – {format(parseISO(plan.period_end), 'MMM yyyy')}
        </span>
      </div>

      <div className="w-full rounded-xl border border-white/[0.08] bg-white/[0.01] overflow-hidden">
        {/* Column header */}
        <div className="flex items-center px-4 py-2 border-b border-white/[0.06]">
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/30 w-36 shrink-0">Category</span>
          <span className="flex-1 text-[11px] font-bold uppercase tracking-[0.12em] text-white/30">Progress</span>
          <span className="w-20 text-right text-[11px] font-bold uppercase tracking-[0.12em] text-white/30">Spent</span>
          <span className="w-8 shrink-0" />
        </div>

        {groups.length === 0 ? (
          <div className="py-12 text-center text-[13px] text-muted-foreground">
            No budget categories defined. Switch to Planning mode to add categories.
          </div>
        ) : (
          groups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            const agg = aggregateGroup(group);

            return (
              <div key={group.key}>
                {/* ── Group header ─────────────────────────────────────── */}
                {group.ownerItem ? (
                  // Owner header: shows the parent item's own data (or aggregate when collapsed)
                  <GroupOwnerHeader
                    group={group}
                    isCollapsed={isCollapsed}
                    onToggle={() => toggleCollapse(group.key)}
                    onClick={() => handleRowClick(group.ownerItem!)}
                    values={isCollapsed ? agg : resolveItemValues(group.ownerItem)}
                  />
                ) : (
                  // Label-only header (parent not in budget, or orphan)
                  <GroupLabelHeader
                    label={group.label}
                    isCollapsed={isCollapsed}
                    onToggle={() => toggleCollapse(group.key)}
                    values={isCollapsed ? agg : null}
                    minPct={isCollapsed && group.childItems[0] ? group.childItems[0].min_pct : 0}
                    maxPct={isCollapsed && group.childItems[0] ? group.childItems[0].max_pct : 100}
                  />
                )}

                {/* ── Child items (hidden when collapsed) ─────────────── */}
                {!isCollapsed &&
                  group.childItems.map((item) => {
                    const v = resolveItemValues(item);
                    return (
                      <BudgetCategoryRow
                        key={item.id}
                        item={item}
                        spent={v.spent}
                        target={v.target}
                        remaining={v.remaining}
                        showParentPrefix={group.ownerItem === null}
                        onClick={() => handleRowClick(item)}
                      />
                    );
                  })}
              </div>
            );
          })
        )}

        {/* ── Outros row ──────────────────────────────────────────────── */}
        {othersSpent > 0 && (
          <div className="flex items-center gap-3 px-4 py-3 border-t border-white/[0.04] bg-white/[0.01]">
            <div className="w-36 shrink-0">
              <span className="text-[13px] font-medium text-white/40 tracking-[-0.01em]">Outros</span>
            </div>
            <div className="flex-1 min-w-0 flex items-center">
              <span className="text-[11px] text-white/20 italic">unbudgeted</span>
            </div>
            <div className="w-6 shrink-0" />
            <div className="text-[12px] font-mono text-white/40 tabular-nums shrink-0 w-20 text-right">
              R$ {othersSpent.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── sub-components ──────────────────────────────────────────────────────────

interface GroupOwnerHeaderProps {
  group: Group;
  isCollapsed: boolean;
  onToggle: () => void;
  onClick: () => void;
  values: { spent: number; target: number; remaining: number };
}

function GroupOwnerHeader({ group, isCollapsed, onToggle, onClick, values }: GroupOwnerHeaderProps) {
  const item = group.ownerItem!;
  return (
    <div className="flex items-center border-b border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.05] transition-colors">
      <button
        onClick={onClick}
        className="flex items-center gap-3 flex-1 min-w-0 px-4 py-3 text-left"
      >
        <div className="w-36 shrink-0">
          <span className="text-[13px] font-semibold text-foreground/90 tracking-[-0.01em]">
            {item.account_name}
          </span>
          {isCollapsed && (
            <span className="ml-2 text-[10px] text-white/25 font-normal">
              {group.childItems.length} {group.childItems.length === 1 ? 'item' : 'items'}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <BudgetBar
            spent={values.spent}
            target={values.target}
            minPct={item.min_pct}
            maxPct={item.max_pct}
            remaining={values.remaining}
          />
        </div>
      </button>
      <div className="text-[12px] font-mono text-white/50 tabular-nums w-20 text-right shrink-0">
        R$ {values.spent.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
      </div>
      <button
        onClick={onToggle}
        className="shrink-0 w-8 flex items-center justify-center text-white/25 hover:text-white/60 transition-colors self-stretch"
        aria-label={isCollapsed ? 'Expand' : 'Collapse'}
      >
        {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

interface GroupLabelHeaderProps {
  label: string;
  isCollapsed: boolean;
  onToggle: () => void;
  values: { spent: number; target: number; remaining: number } | null;
  minPct: number;
  maxPct: number;
}

function GroupLabelHeader({ label, isCollapsed, onToggle, values, minPct, maxPct }: GroupLabelHeaderProps) {
  return (
    <div className={cn(
      'flex items-center border-b border-white/[0.06] transition-colors',
      isCollapsed ? 'bg-white/[0.02] hover:bg-white/[0.04]' : 'bg-white/[0.015]',
    )}>
      <div className="flex items-center gap-3 flex-1 min-w-0 px-4 py-2">
        <div className="w-36 shrink-0">
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/30">{label}</span>
        </div>
        {isCollapsed && values ? (
          <div className="flex-1 min-w-0">
            <BudgetBar
              spent={values.spent}
              target={values.target}
              minPct={minPct}
              maxPct={maxPct}
              remaining={values.remaining}
            />
          </div>
        ) : (
          <div className="flex-1" />
        )}
      </div>
      {isCollapsed && values ? (
        <div className="text-[12px] font-mono text-white/40 tabular-nums w-20 text-right shrink-0">
          R$ {values.spent.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
        </div>
      ) : (
        <div className="w-20 shrink-0" />
      )}
      <button
        onClick={onToggle}
        className="shrink-0 w-8 flex items-center justify-center text-white/20 hover:text-white/50 transition-colors self-stretch"
        aria-label={isCollapsed ? 'Expand' : 'Collapse'}
      >
        {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}
