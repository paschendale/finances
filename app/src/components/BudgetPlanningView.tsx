import { useState, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { differenceInCalendarMonths, parseISO, format } from 'date-fns';
import { X, Plus, Loader2, PiggyBank } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  fetchBudgetItems,
  fetchAccounts,
  upsertBudgetItem,
  deleteBudgetItem,
  type BudgetPlan,
  type BudgetItemWithAccount,
} from '@/lib/api';
import { AccountIcon } from './AccountIcon';
import { BudgetBar } from './BudgetBar';
import { SearchableSelect } from './SearchableSelect';

interface BudgetPlanningViewProps {
  plan: BudgetPlan | null;
  onOpenWizard: () => void;
  setDirty: (dirty: boolean) => void;
  onSaved: () => void;
}

type AmountMode = 'monthly' | 'yearly';

interface DraftItem {
  id?: string;
  account_id: string;
  account_full_name: string;
  account_name: string;
  icon: string | null;
  color: string | null;
  period_amount: number;
  min_pct: number;
  max_pct: number;
  amountMode: AmountMode;
  deleted?: boolean;
}

function toDraft(item: BudgetItemWithAccount): DraftItem {
  return {
    id: item.id,
    account_id: item.account_id,
    account_full_name: item.account_full_name,
    account_name: item.account_name,
    icon: item.icon,
    color: item.color,
    period_amount: Number(item.period_amount),
    min_pct: Number(item.min_pct),
    max_pct: Number(item.max_pct),
    amountMode: 'monthly',
  };
}

export function BudgetPlanningView({ plan, onOpenWizard, setDirty, onSaved }: BudgetPlanningViewProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DraftItem[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { data: serverItems = [], isLoading: itemsLoading } = useQuery({
    queryKey: ['budgetItems', plan?.id],
    queryFn: () => fetchBudgetItems(plan!.id),
    enabled: !!plan?.id,
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  });

  // Reset draft when server items change (e.g. after plan switch)
  useEffect(() => {
    setDraft(serverItems.map(toDraft));
    setDirty(false);
  }, [serverItems, setDirty]);

  const numMonths = useMemo(() => {
    if (!plan) return 12;
    return differenceInCalendarMonths(parseISO(plan.period_end), parseISO(plan.period_start)) + 1;
  }, [plan]);

  const activeDraftAccountIds = useMemo(
    () => new Set(draft.filter((d) => !d.deleted).map((d) => d.account_id)),
    [draft],
  );

  const expenseAccountOptions = useMemo(
    () =>
      accounts
        .filter((a) => a.account_type === 'expense' && !a.hidden && !activeDraftAccountIds.has(a.account_id))
        .map((a) => ({ label: a.account_name, value: a.account_id, icon: a.icon, color: a.color })),
    [accounts, activeDraftAccountIds],
  );

  function updateItem(accountId: string, changes: Partial<DraftItem>) {
    setDraft((prev) => prev.map((d) => (d.account_id === accountId ? { ...d, ...changes } : d)));
    setDirty(true);
    setSaveError(null);
  }

  function addItem(accountId: string) {
    const account = accounts.find((a) => a.account_id === accountId);
    if (!account) return;
    setDraft((prev) => [
      ...prev,
      {
        account_id: account.account_id,
        account_full_name: account.account_name,
        account_name: account.account_name.split(':').pop() ?? account.account_name,
        icon: account.icon ?? null,
        color: account.color ?? null,
        period_amount: 0,
        min_pct: 60,
        max_pct: 140,
        amountMode: 'monthly',
        deleted: false,
      },
    ]);
    setDirty(true);
    setSaveError(null);
  }

  function removeItem(accountId: string) {
    setDraft((prev) =>
      prev.map((d) => (d.account_id === accountId ? { ...d, deleted: true } : d)),
    );
    setDirty(true);
    setSaveError(null);
  }

  async function handleSave() {
    if (!plan) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const toUpsert = draft.filter((d) => !d.deleted);
      const toDelete = draft.filter((d) => d.deleted && d.id);

      await Promise.all([
        ...toUpsert.map((d) =>
          upsertBudgetItem(plan.id, d.account_id, d.period_amount, d.min_pct, d.max_pct),
        ),
        ...toDelete.map((d) => deleteBudgetItem(d.id!)),
      ]);

      await queryClient.invalidateQueries({ queryKey: ['budgetItems', plan.id] });
      await queryClient.invalidateQueries({ queryKey: ['budgetMonthlySpending', plan.id] });
      await queryClient.invalidateQueries({ queryKey: ['budgetCurrentPlan'] });

      setDirty(false);
      onSaved();
    } catch {
      setSaveError('Save failed. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }

  if (!plan) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <PiggyBank className="w-10 h-10 text-white/20" />
        <div className="text-center space-y-1">
          <p className="text-[15px] font-medium text-foreground/60">No budget plan</p>
          <p className="text-[13px] text-muted-foreground">Create a plan to start budgeting.</p>
        </div>
        <button
          onClick={onOpenWizard}
          className="mt-2 px-5 py-2.5 rounded-xl bg-white text-black text-[13px] font-semibold hover:bg-white/90 active:scale-[0.98] transition-all"
        >
          Create Budget Plan
        </button>
      </div>
    );
  }

  if (itemsLoading) {
    return (
      <div className="w-full space-y-3 animate-pulse">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-20 bg-white/[0.03] rounded-xl" />
        ))}
      </div>
    );
  }

  const visibleItems = draft.filter((d) => !d.deleted);

  return (
    <div className="w-full space-y-4">
      {/* Plan header */}
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-foreground/90 truncate">{plan.name}</p>
          <p className="text-[11px] font-mono text-white/35 mt-0.5">
            {format(parseISO(plan.period_start), 'MMM d, yyyy')} – {format(parseISO(plan.period_end), 'MMM d, yyyy')}
            <span className="ml-2 text-white/25">({numMonths}mo)</span>
          </p>
        </div>
        <button
          onClick={onOpenWizard}
          className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.08] text-[12px] font-medium text-white/50 hover:text-white/80 hover:bg-white/[0.04] transition-all"
        >
          <Plus className="w-3 h-3" />
          New Plan
        </button>
      </div>

      {/* Category list */}
      <div className="rounded-xl border border-white/[0.08] bg-white/[0.01] overflow-hidden">
        {/* Table header */}
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-2 border-b border-white/[0.06] items-center">
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/25">Category</span>
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/25 w-32 text-right">Amount</span>
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/25 w-16 text-center">Min %</span>
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/25 w-16 text-center">Max %</span>
          <span className="w-6" />
        </div>

        {visibleItems.length === 0 && (
          <div className="py-10 text-center text-[13px] text-white/25">
            No categories yet. Add one below.
          </div>
        )}

        {visibleItems.map((item) => (
          <PlanningRow
            key={item.account_id}
            item={item}
            numMonths={numMonths}
            onUpdate={(changes) => updateItem(item.account_id, changes)}
            onRemove={() => removeItem(item.account_id)}
          />
        ))}

        {/* Add category row */}
        <div className="px-4 py-3 border-t border-white/[0.04]">
          <SearchableSelect
            options={expenseAccountOptions}
            value=""
            onChange={addItem}
            placeholder="Add category…"
            icon={Plus}
          />
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-3">
        {saveError ? (
          <p className="text-[12px] text-red-400/80">{saveError}</p>
        ) : (
          <span />
        )}
        <button
          onClick={handleSave}
          disabled={isSaving}
          className={cn(
            'flex items-center gap-2 px-6 py-2.5 rounded-xl text-[13px] font-semibold transition-all',
            isSaving
              ? 'bg-white/10 text-white/30 cursor-not-allowed'
              : 'bg-white text-black hover:bg-white/90 active:scale-[0.98]',
          )}
        >
          {isSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Save
        </button>
      </div>
    </div>
  );
}

interface PlanningRowProps {
  item: DraftItem;
  numMonths: number;
  onUpdate: (changes: Partial<DraftItem>) => void;
  onRemove: () => void;
}

function PlanningRow({ item, numMonths, onUpdate, onRemove }: PlanningRowProps) {
  const monthlyAmount = numMonths > 0 ? item.period_amount / numMonths : 0;
  const displayAmount = item.amountMode === 'monthly' ? monthlyAmount : item.period_amount;

  function handleAmountChange(raw: string) {
    const val = parseFloat(raw.replace(',', '.')) || 0;
    const periodAmount = item.amountMode === 'monthly' ? val * numMonths : val;
    onUpdate({ period_amount: periodAmount });
  }

  function toggleAmountMode() {
    onUpdate({ amountMode: item.amountMode === 'monthly' ? 'yearly' : 'monthly' });
  }

  const previewTarget = numMonths > 0 ? item.period_amount / numMonths : 0;

  return (
    <div className="border-b border-white/[0.04] last:border-0 px-4 py-3 space-y-2.5">
      {/* Top row: icon + name + inputs + remove */}
      <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 items-center">
        {/* Name */}
        <div className="flex items-center gap-2 min-w-0">
          <AccountIcon
            accountName={item.account_full_name}
            icon={item.icon}
            color={item.color}
            size="sm"
          />
          <span className="text-[13px] font-medium text-foreground/80 truncate">
            {item.account_name.split(':').pop() ?? item.account_name}
          </span>
        </div>

        {/* Amount + toggle */}
        <div className="flex items-center gap-1 w-32">
          <input
            type="number"
            min="0"
            step="any"
            value={displayAmount === 0 ? '' : Number(displayAmount.toFixed(2))}
            onChange={(e) => handleAmountChange(e.target.value)}
            placeholder="0"
            className="w-16 bg-white/[0.04] border border-white/[0.08] rounded-md px-2 py-1 text-[12px] font-mono text-right focus:outline-none focus:border-white/20 focus:bg-white/[0.06] transition-all tabular-nums"
          />
          <button
            onClick={toggleAmountMode}
            className="px-1.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide border border-white/[0.08] text-white/40 hover:text-white/70 hover:bg-white/[0.05] transition-all tabular-nums w-[3.5rem] text-center"
          >
            {item.amountMode === 'monthly' ? '/mo' : '/yr'}
          </button>
        </div>

        {/* Min % */}
        <div className="w-16 flex items-center justify-center">
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            value={item.min_pct}
            onChange={(e) => {
              const v = Math.max(0, parseFloat(e.target.value) || 0);
              onUpdate({ min_pct: v, max_pct: Math.max(item.max_pct, v) });
            }}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-md px-2 py-1 text-[12px] font-mono text-center focus:outline-none focus:border-white/20 focus:bg-white/[0.06] transition-all tabular-nums"
          />
        </div>

        {/* Max % */}
        <div className="w-16 flex items-center justify-center">
          <input
            type="number"
            min="0"
            step="1"
            value={item.max_pct}
            onChange={(e) => {
              const v = Math.max(item.min_pct, parseFloat(e.target.value) || 0);
              onUpdate({ max_pct: v });
            }}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-md px-2 py-1 text-[12px] font-mono text-center focus:outline-none focus:border-white/20 focus:bg-white/[0.06] transition-all tabular-nums"
          />
        </div>

        {/* Remove */}
        <button
          onClick={onRemove}
          className="w-6 h-6 flex items-center justify-center rounded-md text-white/25 hover:text-red-400/80 hover:bg-white/[0.04] transition-all"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Live BudgetBar preview */}
      <div className="pl-8">
        <BudgetBar
          spent={0}
          target={previewTarget}
          minPct={item.min_pct}
          maxPct={item.max_pct}
          remaining={item.period_amount}
        />
      </div>
    </div>
  );
}
