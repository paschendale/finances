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

// ─── monthly vertical adjustment algorithm ───────────────────────────────────

function computeMonthlyVerticalAdjustments(
  monthlyItems: BudgetItemWithAccount[],
  spending: BudgetMonthlySpending[],
  currentMonthKey: string,
  numMonths: number,
): Map<string, { target: number; remaining: number }> {
  const itemData = monthlyItems.map((item) => ({
    account_id: item.account_id,
    base: numMonths > 0 ? Number(item.period_amount) / numMonths : 0,
    spent: Number(spending.find((s) => s.account_id === item.account_id && s.month === currentMonthKey)?.spent ?? 0),
  }));

  const overspenders = itemData.filter((i) => i.spent > i.base);
  const underspenders = itemData.filter((i) => i.spent <= i.base);

  const totalOverspend = overspenders.reduce((sum, i) => sum + (i.spent - i.base), 0);
  const totalUnderspendSurplus = underspenders.reduce((sum, i) => sum + (i.base - i.spent), 0);
  const totalUnderspendBudget = underspenders.reduce((sum, i) => sum + i.base, 0);
  const coverable = Math.min(totalOverspend, totalUnderspendSurplus);

  const result = new Map<string, { target: number; remaining: number }>();

  for (const item of overspenders) {
    result.set(item.account_id, { target: item.spent, remaining: 0 });
  }

  for (const item of underspenders) {
    const deduction =
      totalUnderspendBudget > 0 ? coverable * (item.base / totalUnderspendBudget) : 0;
    const adjustedTarget = Math.max(item.spent, item.base - deduction);
    result.set(item.account_id, { target: adjustedTarget, remaining: adjustedTarget - item.spent });
  }

  return result;
}

// ─── grouping model ──────────────────────────────────────────────────────────

interface Group {
  key: string;
  label: string;
  ownerItem: BudgetItemWithAccount | null;
  childItems: BudgetItemWithAccount[];
  minSortOrder: number;
}

function buildGroups(items: BudgetItemWithAccount[]): Group[] {
  const accountIdSet = new Set(items.map((i) => i.account_id));
  const groups = new Map<string, Group>();

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

  for (const item of items) {
    const hasChildren = items.some((other) => other.parent_id === item.account_id);
    if (hasChildren) continue;

    if (item.parent_id !== null && accountIdSet.has(item.parent_id)) {
      const g = groups.get(item.parent_id)!;
      g.childItems.push(item);
      g.minSortOrder = Math.min(g.minSortOrder, item.sort_order);
    } else if (item.parent_id !== null && !accountIdSet.has(item.parent_id)) {
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

  const monthlyItems = items.filter((i) => i.category_type === 'monthly');
  const yearlyItems = items.filter((i) => (i.category_type ?? 'yearly') === 'yearly');

  // Pre-compute vertical adjustments for all monthly items in monthly view
  const monthlyAdjustments =
    periodView === 'monthly'
      ? computeMonthlyVerticalAdjustments(monthlyItems, spending, currentMonthKey, numMonths)
      : null;

  function resolveItemValues(item: BudgetItemWithAccount): { spent: number; target: number; remaining: number } {
    const { spentThisMonth, spentTotal, spentBeforeCurrent } = getSpentForAccount(
      item.account_id,
      spending,
      currentMonthKey,
    );

    if (item.category_type === 'monthly') {
      if (periodView === 'period') {
        const target = Number(item.period_amount);
        return { spent: spentTotal, target, remaining: target - spentTotal };
      }
      // Monthly view: use vertical adjustment
      const base = numMonths > 0 ? Number(item.period_amount) / numMonths : 0;
      const adj = monthlyAdjustments?.get(item.account_id);
      if (adj) {
        if (spentThisMonth > base) {
          // Overspender: show original base so the bar renders the red overspend portion
          return { spent: spentThisMonth, target: base, remaining: base - spentThisMonth };
        }
        // Underspender (possibly reduced): show the adjusted (effective) target
        return { spent: spentThisMonth, target: adj.target, remaining: adj.remaining };
      }
      return { spent: spentThisMonth, target: base, remaining: base - spentThisMonth };
    }

    // Yearly: existing rolling adjustment
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

  // ── Monthly adjustment helper text ───────────────────────────────────────
  function getHelperText(item: BudgetItemWithAccount): string | undefined {
    if (item.category_type !== 'monthly' || periodView !== 'monthly' || !monthlyAdjustments) return undefined;
    const base = numMonths > 0 ? Number(item.period_amount) / numMonths : 0;
    const adj = monthlyAdjustments.get(item.account_id);
    if (!adj) return undefined;
    const fmtR = (v: number) =>
      `R$ ${Math.round(v).toLocaleString('pt-BR')}`;
    if (adj.target > base + 0.01) {
      return `Over monthly budget by ${fmtR(adj.target - base)}`;
    }
    if (adj.target < base - 0.01) {
      return `Budget reduced ${fmtR(base - adj.target)} to cover other categories`;
    }
    return undefined;
  }

  // ── Monthly section aggregate ─────────────────────────────────────────────
  const monthlyTotalBase = monthlyItems.reduce(
    (sum, item) => sum + (numMonths > 0 ? Number(item.period_amount) / numMonths : 0),
    0,
  );
  const monthlyTotalPeriod = monthlyItems.reduce((sum, item) => sum + Number(item.period_amount), 0);
  const monthlySpentThisMonth = monthlyItems.reduce((sum, item) => {
    const rows = spending.filter((s) => s.account_id === item.account_id && s.month === currentMonthKey);
    return sum + rows.reduce((s2, r) => s2 + Number(r.spent), 0);
  }, 0);
  const monthlySpentTotal = monthlyItems.reduce((sum, item) => {
    return sum + spending.filter((s) => s.account_id === item.account_id).reduce((s2, r) => s2 + Number(r.spent), 0);
  }, 0);

  const monthlyGroupSpent = periodView === 'period' ? monthlySpentTotal : monthlySpentThisMonth;
  const monthlyGroupTarget = periodView === 'period' ? monthlyTotalPeriod : monthlyTotalBase;

  // ── render ────────────────────────────────────────────────────────────────
  const monthlyGroups = buildGroups(monthlyItems);
  const yearlyGroups = buildGroups(yearlyItems);

  const hideMax = periodView === 'period';

  function renderGroups(groups: Group[]) {
    return groups.map((group) => {
      const isCollapsed = collapsed.has(group.key);
      const agg = aggregateGroup(group);

      return (
        <div key={group.key}>
          {group.ownerItem ? (
            <GroupOwnerHeader
              group={group}
              isCollapsed={isCollapsed}
              onToggle={() => toggleCollapse(group.key)}
              onClick={() => handleRowClick(group.ownerItem!)}
              values={isCollapsed ? agg : resolveItemValues(group.ownerItem)}
              hideMax={hideMax}
            />
          ) : (
            <GroupLabelHeader
              label={group.label}
              isCollapsed={isCollapsed}
              onToggle={() => toggleCollapse(group.key)}
              values={isCollapsed ? agg : null}
              minPct={isCollapsed && group.childItems[0] ? group.childItems[0].min_pct : 0}
              maxPct={isCollapsed && group.childItems[0] ? group.childItems[0].max_pct : 100}
              hideMax={hideMax}
            />
          )}

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

                  onClick={() => handleRowClick(item)}
                  hideMax={hideMax}
                  helperText={getHelperText(item)}
                />
              );
            })}
        </div>
      );
    });
  }

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
          <div className="w-28 text-right shrink-0 space-y-0.5">
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/20">Target</div>
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/30">Spent</div>
          </div>
          <span className="w-8 shrink-0" />
        </div>

        {items.length === 0 ? (
          <div className="py-12 text-center text-[13px] text-muted-foreground">
            No budget categories defined. Switch to Planning mode to add categories.
          </div>
        ) : (
          <>
            {/* ── Monthly section ──────────────────────────────────────────── */}
            {monthlyItems.length > 0 && (
              <>
                {/* Monthly section header with aggregate bar */}
                <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.06] bg-blue-400/[0.04]">
                  <div className="w-36 shrink-0">
                    <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-blue-400/70">Monthly</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <BudgetBar
                      spent={monthlyGroupSpent}
                      target={monthlyGroupTarget}
                      minPct={0}
                      maxPct={100}
                      remaining={monthlyGroupTarget - monthlyGroupSpent}
                      hideMax={true}
                    />
                  </div>
                  <div className="shrink-0 w-28 text-right space-y-0.5">
                    <div className="flex items-baseline justify-end gap-1.5">
                      <span className="text-[9px] font-medium uppercase tracking-wide text-blue-400/40 shrink-0">Target</span>
                      <span className="text-[11px] font-mono tabular-nums text-blue-400/60">
                        R$&nbsp;{monthlyGroupTarget.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-end gap-1.5">
                      <span className="text-[9px] font-medium uppercase tracking-wide text-blue-400/40 shrink-0">Spent</span>
                      <span className="text-[12px] font-mono tabular-nums text-blue-400/70">
                        R$&nbsp;{monthlyGroupSpent.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                      </span>
                    </div>
                  </div>
                  <div className="w-8 shrink-0" />
                </div>

                {renderGroups(monthlyGroups)}
              </>
            )}

            {/* ── Yearly section ───────────────────────────────────────────── */}
            {yearlyItems.length > 0 && (
              <>
                {/* Section divider when both sections present */}
                {monthlyItems.length > 0 && (
                  <div className="flex items-center px-4 py-2 border-t border-white/[0.06] bg-amber-400/[0.03]">
                    <div className="w-36 shrink-0">
                      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-amber-400/60">Yearly</span>
                    </div>
                    <div className="flex-1" />
                    <div className="w-20 shrink-0" />
                    <div className="w-8 shrink-0" />
                  </div>
                )}
                {/* When only yearly items, no need for a divider */}
                {monthlyItems.length === 0 && null}

                {renderGroups(yearlyGroups)}
              </>
            )}
          </>
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
            <div className="text-[12px] font-mono text-white/40 tabular-nums shrink-0 w-28 text-right">
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
  hideMax?: boolean;
}

function GroupOwnerHeader({ group, isCollapsed, onToggle, onClick, values, hideMax }: GroupOwnerHeaderProps) {
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
            hideMax={hideMax}
          />
        </div>
      </button>
      <div className="text-[12px] font-mono text-white/50 tabular-nums w-28 text-right shrink-0">
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
  hideMax?: boolean;
}

function GroupLabelHeader({ label, isCollapsed, onToggle, values, minPct, maxPct, hideMax }: GroupLabelHeaderProps) {
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
              hideMax={hideMax}
            />
          </div>
        ) : (
          <div className="flex-1" />
        )}
      </div>
      {isCollapsed && values ? (
        <div className="text-[12px] font-mono text-white/40 tabular-nums w-28 text-right shrink-0">
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
