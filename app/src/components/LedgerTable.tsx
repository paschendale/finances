import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchTransactions, updateTransaction, deleteTransaction, fetchAccounts, fetchCategoryUsage, fetchAccountUsage, fetchDailyAccountBalances, fetchDailyBalances, fetchGlobalSettings, fetchExchangeRate, type Transaction, type Entry } from '@/lib/api';
import { useMemo, useEffect, useRef, useState } from 'react';
import { cn, formatHierarchicalName } from '@/lib/utils';
import { SearchableSelect } from './SearchableSelect';
import { AccountIcon } from './AccountIcon';
import { Wallet, Tag, Trash2, Plus, Check, Loader2, X, Download } from 'lucide-react';
import { type LedgerFilters } from './LedgerFilterBar';
import { ExportWizard } from './ExportWizard';

interface TransactionItem {
  type: 'transaction';
  id: string;
  date: string;
  description: string;
  accounts: string[];
  categories: string[];
  amount: number;
  currency: string;
  entries: Entry[];
  primaryType: 'expense' | 'income' | 'transfer';
}

interface DateHeaderItem {
  type: 'date-header';
  id: string;
  date: string;
}

type LedgerItem = TransactionItem | DateHeaderItem;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getInstallmentNumber(desc: string): number {
  const m = desc.match(/\((\d+) de \d+\)$/);
  return m ? parseInt(m[1]) : 0;
}

function TransactionRow({
  item,
  isExpanded,
  onToggle,
  allTransactions,
  hasFilters,
}: {
  item: TransactionItem,
  isExpanded: boolean,
  onToggle: () => void,
  allTransactions?: TransactionItem[],
  hasFilters?: boolean,
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editState, setEditState] = useState<Transaction | null>(null);
  const queryClient = useQueryClient();

  const { data: accounts } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  });

  const { data: topCategories } = useQuery({
    queryKey: ['categoryUsage'],
    queryFn: fetchCategoryUsage,
  });

  const { data: accountUsage } = useQuery({
    queryKey: ['accountUsage'],
    queryFn: fetchAccountUsage,
  });

  const { data: globalSettings } = useQuery({
    queryKey: ['globalSettings'],
    queryFn: fetchGlobalSettings,
  });

  const baseCurrency = globalSettings?.find(s => s.key === 'base_currency')?.value || 'BRL';

  const [fetchingRateIdx, setFetchingRateIdx] = useState<number | null>(null);

  const updateEntryCurrency = async (index: number, rawValue: string) => {
    if (!editState) return;
    const normalized = rawValue.toUpperCase().trim();
    if (!/^[A-Z]{3}$/.test(normalized)) return;
    if (normalized === editState.entries[index].currency) return;

    let rate = 1.0;
    if (normalized !== baseCurrency) {
      setFetchingRateIdx(index);
      try {
        rate = await fetchExchangeRate(editState.date, normalized, baseCurrency);
      } catch {
        alert(`Could not fetch exchange rate for ${normalized}`);
        setFetchingRateIdx(null);
        return;
      }
      setFetchingRateIdx(null);
    }

    const newEntries = editState.entries.map(e => ({
      ...e,
      currency: normalized,
      exchange_rate: rate,
      amount_base: e.amount * rate,
    }));

    setEditState({ ...editState, entries: newEntries });
  };

  const mutation = useMutation({
    mutationFn: updateTransaction,
    onSuccess: () => {
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteTransaction,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  const anticipateMutation = useMutation({
    mutationFn: updateTransaction,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  const allAccountOptions = useMemo(() =>
    (accounts || []).filter(a => !a.hidden).map(a => ({ label: a.account_name, value: a.account_id, icon: a.icon, color: a.color })),
  [accounts]);

  const topCategoryOptions = useMemo(() =>
    (topCategories || []).map(c => {
      const acc = accounts?.find(a => a.account_name === c.category_name);
      return { label: c.category_name, value: acc?.account_id || '', icon: acc?.icon ?? null, color: acc?.color ?? null, hidden: acc?.hidden ?? false };
    }).filter(o => o.value !== '' && !o.hidden),
  [topCategories, accounts]);

  const topAccountOptions = useMemo(() =>
    (accountUsage || [])
      .filter(u => (u.account_type === 'asset' || u.account_type === 'liability') && !u.hidden)
      .slice(0, 10)
      .map(u => {
        const acc = accounts?.find(a => a.account_id === u.account_id);
        return { label: u.account_name, value: u.account_id, icon: acc?.icon ?? null, color: acc?.color ?? null };
      }),
  [accountUsage, accounts]);

  const totalDifference = useMemo(() => {
    if (!editState) return 0;
    return editState.entries.reduce((sum, e) => sum + (Number(e.amount_base) || 0), 0);
  }, [editState]);

  const isBalanced = Math.abs(totalDifference) < 0.01;

  // Detect current transaction type from edit state
  const editType = useMemo(() => {
    if (!editState) return 'transfer';
    const expenseEntry = editState.entries.find(e => e.account_type === 'expense');
    if (expenseEntry) {
      // Positive amount in expense account = you spent money (expense)
      // Negative amount in expense account = refund (income)
      return expenseEntry.amount > 0 ? 'expense' : 'income';
    }
    const incomeEntry = editState.entries.find(e => e.account_type === 'income');
    if (incomeEntry) {
      // Negative amount in income account = you earned money (income)
      // Positive amount in income account = reversal (expense)
      return incomeEntry.amount < 0 ? 'income' : 'expense';
    }
    return 'transfer';
  }, [editState]);

  const startEditing = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Sort entries so that positive (destination/category) comes first for better editing flow
    const sortedEntries = [...item.entries].sort((a, b) => b.amount_base - a.amount_base);
    setEditState({
      id: item.id,
      date: item.date,
      description: item.description,
      entries: sortedEntries.map(e => ({ ...e })),
      account_ids: item.entries.map(e => e.account_id)
    });
    setIsEditing(true);
    if (!isExpanded) onToggle();
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditState(null);
  };

  const saveChanges = () => {
    if (editState && isBalanced) {
      mutation.mutate(editState);
    }
  };

  const updateEntry = (index: number, field: keyof Entry, value: any) => {
    if (!editState) return;
    const newEntries = [...editState.entries];
    
    if (field === 'amount') {
        const numVal = parseFloat(value) || 0;
        const sign = newEntries[index].amount < 0 ? -1 : 1;
        newEntries[index].amount = sign * numVal;
        newEntries[index].amount_base = newEntries[index].amount * (newEntries[index].exchange_rate || 1.0);
        
        // Auto-balance logic (simple 2-entry case)
        if (newEntries.length === 2) {
          const otherIdx = index === 0 ? 1 : 0;
          newEntries[otherIdx].amount_base = -newEntries[index].amount_base;
          newEntries[otherIdx].amount = newEntries[otherIdx].amount_base / (newEntries[otherIdx].exchange_rate || 1.0);
        }
    } else {
        newEntries[index] = { ...newEntries[index], [field]: value };
    }

    if (field === 'account_id' && accounts) {
        const acc = accounts.find(a => a.account_id === value);
        if (acc) {
            newEntries[index].account_name = acc.account_name;
            newEntries[index].account_type = acc.account_type;
        }
    }

    setEditState({ ...editState, entries: newEntries });
  };

  const toggleAllSigns = () => {
    if (!editState) return;
    setEditState({
      ...editState,
      entries: editState.entries.map(e => ({
        ...e,
        amount: -e.amount,
        amount_base: -e.amount_base,
      })),
    });
  };

  const addEntry = () => {
    if (!editState) return;
    const firstCategory = topCategoryOptions[0]?.value || allAccountOptions.find(o => o.label.startsWith('expenses:'))?.value || '';
    const acc = accounts?.find(a => a.account_id === firstCategory);
    
    setEditState({
      ...editState,
      entries: [
        ...editState.entries,
        {
          id: '', 
          account_id: firstCategory,
          account_name: acc?.account_name || 'expenses:unknown',
          account_type: acc?.account_type || 'expense',
          amount: 0,
          currency: editState.entries[0].currency,
          exchange_rate: 1.0,
          amount_base: 0,
        }
      ]
    });
  };

  const removeEntry = (index: number) => {
    if (!editState || editState.entries.length <= 2) return;
    const newEntries = editState.entries.filter((_, i) => i !== index);
    setEditState({ ...editState, entries: newEntries });
  };

  const installmentPattern = item.description.match(/^(.+) \((\d+) de (\d+)\)$/);

  const allSeriesItems = useMemo(() => {
    if (!installmentPattern || !allTransactions) return [];
    const [, baseDesc, , totalStr] = installmentPattern;
    const total = parseInt(totalStr);
    const all = [item, ...allTransactions.filter(t => t.id !== item.id && new RegExp(`^${escapeRegex(baseDesc)} \\(\\d+ de ${total}\\)$`).test(t.description))];
    return all.sort((a, b) => getInstallmentNumber(a.description) - getInstallmentNumber(b.description));
  }, [installmentPattern, allTransactions, item]);

  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: item.currency || 'BRL',
  });

  const anticipateInstallment = (t: TransactionItem) => {
    const newDate = item.date.slice(0, 7) + '-01';
    anticipateMutation.mutate({
      id: t.id,
      date: newDate,
      description: t.description,
      entries: t.entries,
      account_ids: t.entries.map(e => e.account_id),
    });
  };

  return (
    <div className={cn(
      "group flex flex-col border-b border-border/30 transition-all duration-200",
      isExpanded ? "bg-muted/30" : "hover:bg-muted/15",
      isEditing ? "relative z-[60] bg-background shadow-2xl ring-1 ring-primary/20" : "z-auto"
    )}>
      <button
        onClick={onToggle}
        className="w-full flex items-center px-4 py-2 text-left focus:outline-none"
      >
        <div className="grid grid-cols-[1.5fr_1fr_1fr_120px] gap-4 w-full items-center">
          <span className="font-medium text-[14px] truncate text-foreground/90 flex items-center gap-2">
            {item.description}
            {installmentPattern && (
              <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 uppercase tracking-wider shrink-0">
                {installmentPattern[2]}/{installmentPattern[3]}
              </span>
            )}
            {!isEditing && (
              <button
                onClick={startEditing}
                className="opacity-0 group-hover:opacity-100 text-[10px] text-primary hover:underline font-bold uppercase tracking-tighter transition-opacity"
              >
                Edit
              </button>
            )}
          </span>
          
          {(() => {
            const catEntries = item.entries.filter(e => e.account_type === 'expense' || e.account_type === 'income');
            const accEntries = item.entries.filter(e => e.account_type === 'asset' || e.account_type === 'liability' || e.account_type === 'equity');
            const isTransfer = catEntries.length === 0 && accEntries.length >= 2;

            if (isTransfer) {
              // Source in first column (mimics category column)
              const src = accEntries.find(e => e.amount_base < 0) ?? accEntries[1];
              const srcAcc = accounts?.find(a => a.account_id === src.account_id);
              const iconName = srcAcc?.account_name || src.account_name;
              return (
                <span className="text-[12px] text-muted-foreground/80 truncate font-mono flex items-center gap-1">
                  <span className="flex items-center gap-1 truncate">
                    <AccountIcon accountName={iconName} icon={srcAcc?.icon} color={srcAcc?.color} size="xs" />
                    <span className="truncate">{formatHierarchicalName(src.account_name)}</span>
                  </span>
                </span>
              );
            }

            const first = catEntries[0];
            const firstAcc = first ? accounts?.find(a => a.account_id === first.account_id) : undefined;
            const iconName = firstAcc?.account_name || first?.account_name || '';
            return (
              <span className="text-[12px] text-muted-foreground/80 truncate font-mono flex items-center gap-1">
                {first && (
                  <span className="flex items-center gap-1 truncate">
                    <AccountIcon accountName={iconName} icon={firstAcc?.icon} color={firstAcc?.color} size="xs" />
                    <span className="truncate">{formatHierarchicalName(first.account_name)}</span>
                  </span>
                )}
                {catEntries.length > 1 && (
                  <span className="text-muted-foreground/40 shrink-0">+{catEntries.length - 1}</span>
                )}
              </span>
            );
          })()}

          {(() => {
            const catEntries = item.entries.filter(e => e.account_type === 'expense' || e.account_type === 'income');
            const accEntries = item.entries.filter(e => e.account_type === 'asset' || e.account_type === 'liability' || e.account_type === 'equity');
            const isTransfer = catEntries.length === 0 && accEntries.length >= 2;
            if (isTransfer) {
              // Destination in second column (mimics account column)
              const dst = accEntries.find(e => e.amount_base > 0) ?? accEntries[0];
              const dstAcc = accounts?.find(a => a.account_id === dst.account_id);
              const iconName = dstAcc?.account_name || dst.account_name;
              return (
                <span className="text-[12px] text-muted-foreground/60 truncate flex items-center gap-1">
                  <span className="flex items-center gap-1 truncate">
                    <AccountIcon accountName={iconName} icon={dstAcc?.icon} color={dstAcc?.color} size="xs" />
                    <span className="truncate">{formatHierarchicalName(dst.account_name)}</span>
                  </span>
                  {accEntries.length > 2 && (
                    <span className="text-muted-foreground/40 shrink-0">+{accEntries.length - 2}</span>
                  )}
                </span>
              );
            }

            const first = accEntries[0];
            const firstAcc = first ? accounts?.find(a => a.account_id === first.account_id) : undefined;
            const iconName = firstAcc?.account_name || first?.account_name || '';
            return (
              <span className="text-[12px] text-muted-foreground/60 truncate flex items-center gap-1">
                {first && (
                  <span className="flex items-center gap-1 truncate">
                    <AccountIcon accountName={iconName} icon={firstAcc?.icon} color={firstAcc?.color} size="xs" />
                    <span className="truncate">{formatHierarchicalName(first.account_name)}</span>
                  </span>
                )}
                {accEntries.length > 1 && (
                  <span className="text-muted-foreground/40 shrink-0">+{accEntries.length - 1}</span>
                )}
              </span>
            );
          })()}
          
          <div className="text-right font-mono font-bold text-[14px]">
            <span className={cn(
              item.primaryType === 'expense' ? "text-destructive/90" : 
              item.primaryType === 'income' ? "text-green-500/90" : 
              "text-foreground/70"
              )}>
              {item.primaryType === 'expense' ? '-' : ''}
              {formatter.format(Math.abs(item.amount))}
              </span>
              </div>

        </div>
      </button>

      {/* Expanded Details / Editor */}
      <div className={cn(
        "transition-all duration-300 ease-in-out px-4",
        isExpanded ? "max-h-[800px] pb-4 opacity-100" : "max-h-0 opacity-0 overflow-hidden"
      )}
      style={{ overflow: isExpanded ? 'visible' : 'hidden' }}
      >
        <div className="pt-2 space-y-3 bg-background/40 rounded-lg p-3 border border-border/30">
          {isEditing && editState ? (
            <div className="space-y-4">
              <div className="flex justify-between items-center gap-4">
                <input
                  value={editState.description}
                  onChange={(e) => setEditState({...editState, description: e.target.value})}
                  className="bg-background/50 border border-border/40 rounded px-2 py-1 text-[14px] font-bold w-full focus:ring-1 focus:ring-primary/30 outline-none"
                  placeholder="Description"
                />
                <input
                  type="date"
                  value={editState.date}
                  onChange={(e) => setEditState({...editState, date: e.target.value})}
                  className="bg-background/50 border border-border/40 rounded px-2 py-1 text-[12px] font-mono focus:ring-1 focus:ring-primary/30 outline-none"
                />
                {editType !== 'transfer' && (
                  <div className="flex items-center gap-0.5 bg-background/40 rounded-md p-0.5 border border-border/20 shrink-0">
                    <button
                      onClick={() => { if (editType !== 'expense') toggleAllSigns(); }}
                      className={cn(
                        "px-2 py-1 rounded text-[9px] font-bold uppercase tracking-wider transition-all",
                        editType === 'expense' ? "bg-destructive/20 text-destructive" : "text-muted-foreground/40 hover:text-muted-foreground"
                      )}
                    >Expense</button>
                    <button
                      onClick={() => { if (editType !== 'income') toggleAllSigns(); }}
                      className={cn(
                        "px-2 py-1 rounded text-[9px] font-bold uppercase tracking-wider transition-all",
                        editType === 'income' ? "bg-green-500/20 text-green-500" : "text-muted-foreground/40 hover:text-muted-foreground"
                      )}
                    >Income</button>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                {editState.entries.map((entry, idx) => {
                  const isSimple = editState.entries.length === 2;
                  const isFirst = idx === 0;
                  const isExpenseAcc = entry.account_type === 'expense';
                  const isIncomeAcc = entry.account_type === 'income';
                  
                  // Color Logic
                  let colorClass = "text-foreground/70"; // Default White for Transfers
                  if (editType === 'expense') colorClass = "text-destructive/70";
                  if (editType === 'income') colorClass = "text-green-500/70";

                  const Icon = (isExpenseAcc || isIncomeAcc) ? Tag : Wallet;
                  
                  return (
                    <div key={idx} className="flex gap-2 items-center bg-background/20 p-1 rounded-lg border border-border/10">
                      <div className="flex-1">
                         <SearchableSelect
                            options={allAccountOptions}
                            topOptions={isExpenseAcc || isIncomeAcc ? topCategoryOptions : topAccountOptions}
                            value={entry.account_id}
                            onChange={(val) => updateEntry(idx, 'account_id', val)}
                            placeholder="Select Account..."
                            icon={Icon}
                            className="bg-transparent border-none"
                         />
                      </div>
                      <div className="w-44 flex flex-col bg-background/40 rounded px-2 py-1 border border-border/20">
                        {isSimple && !isFirst ? (
                          <>
                            <div className="text-[9px] font-bold text-muted-foreground/30 uppercase tracking-widest text-right">{entry.currency}</div>
                            <div className={cn("w-full text-right font-mono text-[13px] font-bold opacity-40", colorClass)}>
                              {new Intl.NumberFormat('en-US', { signDisplay: 'always' }).format(entry.amount)}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="flex items-center justify-end gap-1">
                              <input
                                key={entry.currency}
                                type="text"
                                maxLength={3}
                                defaultValue={entry.currency}
                                onBlur={(e) => updateEntryCurrency(idx, e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                className="w-10 bg-transparent border-none p-0 focus:ring-0 text-[9px] font-bold text-muted-foreground/50 uppercase tracking-widest text-right focus:text-primary transition-colors"
                                placeholder="BRL"
                              />
                              {fetchingRateIdx === idx && <Loader2 className="w-2.5 h-2.5 animate-spin text-muted-foreground/40 shrink-0" />}
                            </div>
                            <div className="flex items-center">
                              <input
                                type="number"
                                step="0.01"
                                value={Math.abs(entry.amount) || ''}
                                onChange={(e) => updateEntry(idx, 'amount', e.target.value)}
                                className={cn(
                                  "w-full bg-transparent border-none p-0 focus:ring-0 text-right font-mono text-[13px] font-bold",
                                  colorClass
                                )}
                                placeholder="0.00"
                              />
                            </div>
                          </>
                        )}
                      </div>
                      {!isSimple && (
                        <button onClick={() => removeEntry(idx)} className="p-1 hover:text-destructive transition-colors">
                           <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
                <button 
                  onClick={addEntry}
                  className="w-full py-1.5 border border-dashed border-border/40 rounded-lg text-[11px] font-bold text-muted-foreground/50 hover:border-primary/40 hover:text-primary transition-all flex items-center justify-center gap-1.5"
                >
                  <Plus className="w-3 h-3" /> Add Split
                </button>
              </div>

              <div className="flex justify-between items-center pt-2 border-t border-border/20">
                 <div className="text-[11px] font-bold uppercase tracking-tight">
                    {isBalanced ? (
                        <span className="text-green-500/60 flex items-center gap-1">
                            <Check className="w-3 h-3" /> Balanced
                        </span>
                    ) : (
                        <span className="text-destructive/60">
                            Difference: {new Intl.NumberFormat('en-US', { style: 'currency', currency: item.currency }).format(totalDifference)}
                        </span>
                    )}
                 </div>
                 <div className="flex gap-2">
                    <button 
                        onClick={() => {
                            if (window.confirm('Delete this transaction?')) {
                                deleteMutation.mutate(item.id);
                            }
                        }}
                        disabled={deleteMutation.isPending}
                        className="px-3 py-1.5 rounded-md text-[12px] font-bold text-destructive/60 hover:bg-destructive/10 transition-all flex items-center gap-1"
                    >
                    {deleteMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    Delete
                    </button>
                    <button 
                        onClick={cancelEditing}
                        className="px-3 py-1.5 rounded-md text-[12px] font-bold text-muted-foreground hover:bg-muted/50 transition-all flex items-center gap-1"
                    >
                    <X className="w-3.5 h-3.5" /> Cancel
                    </button>
                    <button 
                        onClick={saveChanges}
                        disabled={mutation.isPending || !isBalanced}
                        className={cn(
                            "px-4 py-1.5 rounded-md text-[12px] font-bold shadow-sm transition-all flex items-center gap-1.5",
                            isBalanced 
                                ? "bg-green-600 text-white hover:bg-green-700 active:scale-95" 
                                : "bg-muted text-muted-foreground cursor-not-allowed"
                        )}
                    >
                    {mutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    Confirm Changes
                    </button>
                 </div>
              </div>
            </div>
          ) : (
            <>
              <div className="flex justify-between items-center mb-2 px-1">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Transaction Entries</span>
                <span className="text-[10px] text-muted-foreground/50 font-mono uppercase">{item.id.slice(0, 8)}</span>
              </div>
              {item.entries.map((entry, idx) => {
                const entryAcc = accounts?.find(a => a.account_id === entry.account_id);
                const entryIconName = entryAcc?.account_name || entry.account_name;
                return (
                <div key={idx} className="flex justify-between items-center py-1 border-b border-border/10 last:border-0 text-[13px]">
                  <div className="flex items-center gap-2">
                    <AccountIcon accountName={entryIconName} icon={entryAcc?.icon} color={entryAcc?.color} size="sm" />
                    <div className="flex flex-col">
                      <span className="font-medium text-primary/80">{formatHierarchicalName(entry.account_name)}</span>
                      <span className="text-[10px] text-muted-foreground/60 uppercase font-bold tracking-tighter">{entry.account_type}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={cn(
                      "font-mono font-medium",
                      entry.amount_base < 0 ? "text-destructive/70" : "text-green-500/70"
                    )}>
                      {new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: entry.currency || 'BRL',
                      }).format(entry.amount)}
                    </div>
                    {entry.currency && entry.currency !== 'BRL' && (
                      <div className="text-[10px] text-muted-foreground/50 font-mono">
                        ≈ {new Intl.NumberFormat('en-US', {
                          style: 'currency',
                          currency: 'BRL',
                        }).format(entry.amount_base)}
                      </div>
                    )}
                  </div>
                </div>
                );
              })}
              {allSeriesItems.length > 0 && (
                <div className="mt-3 pt-2 border-t border-border/20">
                  {(() => {
                    const seriesTotal = allSeriesItems.reduce((s, t) => s + t.amount, 0);
                    const expectedTotal = installmentPattern ? parseInt(installmentPattern[3]) : 0;
                    const seriesFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: item.currency || 'BRL' });
                    return (
                      <>
                        <div className="flex items-center justify-between mb-1.5 px-1">
                          <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/40">
                            Installment Series ({allSeriesItems.length}/{expectedTotal})
                          </p>
                          <span className="text-[10px] font-bold text-muted-foreground/50">
                            Total: <span className="font-mono text-foreground/60">{seriesFormatter.format(seriesTotal)}</span>
                          </span>
                        </div>
                        <div className="space-y-0.5">
                          {allSeriesItems.map(t => {
                            const isCurrentItem = t.id === item.id;
                            const isFuture = t.date > item.date;
                            const relFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: t.currency || 'BRL' });
                            return (
                              <div key={t.id} className={cn(
                                "flex items-center px-2 py-1 rounded-md text-[12px]",
                                isCurrentItem ? "bg-primary/10" : "hover:bg-muted/10"
                              )}>
                                <span className={cn("font-mono shrink-0 mr-2", isCurrentItem ? "text-muted-foreground/60" : "text-muted-foreground/40")}>{t.date}</span>
                                <span className={cn("font-medium flex-1 truncate", isCurrentItem ? "text-foreground/80" : "text-foreground/60")}>{t.description}</span>
                                <span className={cn("font-mono ml-2", isCurrentItem ? "font-bold text-primary/70" : "text-muted-foreground/60")}>{relFormatter.format(Math.abs(t.amount))}</span>
                                {!isCurrentItem && isFuture && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); anticipateInstallment(t); }}
                                    className="ml-2 text-[9px] font-bold text-blue-400/60 hover:text-blue-400 uppercase tracking-wider shrink-0 transition-colors"
                                  >
                                    Anticipate
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        {allSeriesItems.length < expectedTotal && (
                          <div className="mt-1.5 flex items-center gap-1.5 px-2 py-1 rounded bg-yellow-500/10 border border-yellow-500/20 text-[10px] text-yellow-400/80">
                            <span>⚠</span>
                            <span>
                              Showing {allSeriesItems.length} of {expectedTotal} installments
                              {hasFilters ? ' — others hidden by active filter' : ' — scroll to load more'}
                            </span>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}

              <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-border/20">
                <button
                    onClick={() => {
                        if (window.confirm('Delete this transaction?')) {
                            deleteMutation.mutate(item.id);
                        }
                    }}
                    disabled={deleteMutation.isPending}
                    className="px-3 py-1.5 rounded-md text-[12px] font-bold text-destructive/60 hover:bg-destructive/10 transition-all flex items-center gap-1"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </button>
                <button
                    onClick={startEditing}
                    className="px-3 py-1.5 rounded-md text-[12px] font-bold text-primary/70 hover:bg-primary/10 transition-all flex items-center gap-1"
                >
                  Edit Transaction
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function LedgerTable({ filters }: { filters: LedgerFilters }) {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
  } = useInfiniteQuery({
    queryKey: ['transactions', filters],
    queryFn: ({ pageParam = 0 }) => fetchTransactions(
        50,
        pageParam,
        filters.startDate,
        filters.endDate,
        filters.accountIds,
        filters.description
    ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < 50) return undefined;
      return allPages.length * 50;
    },
  });

  const allDates = useMemo(() => {
    if (!data) return [];
    const dates = new Set<string>();
    data.pages.forEach(page => page.forEach(t => dates.add(t.date)));
    return Array.from(dates);
  }, [data]);

  const { data: dateBalances = [] } = useQuery({
    queryKey: ['dateBalances', allDates, filters.accountIds],
    queryFn: () => fetchDailyAccountBalances(allDates, filters.accountIds),
    enabled: allDates.length > 0
  });

  const { data: netWorthBalances = [] } = useQuery({
    queryKey: ['netWorthBalances'],
    queryFn: fetchDailyBalances,
  });

  const getBalanceForDate = (date: string) => {
    if (filters.accountIds.length > 0) {
        return dateBalances
            .filter(db => db.date === date)
            .reduce((sum, db) => sum + Number(db.balance), 0);
    } else {
        return netWorthBalances
            .find(db => db.date === date && db.account_type === 'net_worth')
            ?.balance || 0;
    }
  };

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { threshold: 0.1 }
    );

    if (loadMoreRef.current) {
      observer.observe(loadMoreRef.current);
    }

    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const allTransactionItems = useMemo<TransactionItem[]>(() => {
    if (!data) return [];
    return data.pages.flatMap(page => page.flatMap(t => {
      const expenseEntries = t.entries.filter(e => e.account_type === 'expense');
      const incomeEntries = t.entries.filter(e => e.account_type === 'income');
      const assetEntries = t.entries.filter(e => ['asset', 'liability', 'equity'].includes(e.account_type));
      
      const expenseSum = expenseEntries.reduce((sum, e) => sum + (Number(e.amount_base) || 0), 0);
      const incomeSum = incomeEntries.reduce((sum, e) => sum + (Number(e.amount_base) || 0), 0);

      let amount = 0, currency = 'BRL';
      let primaryType: 'expense' | 'income' | 'transfer' = 'transfer';

      if (Math.abs(expenseSum) > 0.01) {
        amount = Math.abs(expenseSum);
        // amount is derived from amount_base (always in base currency BRL)
        primaryType = expenseSum > 0 ? 'expense' : 'income';
      } else if (Math.abs(incomeSum) > 0.01) {
        amount = Math.abs(incomeSum);
        // amount is derived from amount_base (always in base currency BRL)
        primaryType = incomeSum < 0 ? 'income' : 'expense';
      } else {
        const posAssetEntries = assetEntries.filter(e => (Number(e.amount_base) || 0) > 0);
        amount = posAssetEntries.reduce((sum, e) => sum + (Number(e.amount_base) || 0), 0);
        // amount is derived from amount_base (always in base currency BRL)
        primaryType = 'transfer';
      }

      const categories = expenseEntries.concat(incomeEntries).map(e => e.account_name);
      const accounts = assetEntries.map(e => e.account_name);

      return [{ type: 'transaction' as const, id: t.id, date: t.date, description: t.description, accounts, categories, amount, currency, entries: t.entries, primaryType }];
    }));
  }, [data]);

  const ledgerItems = useMemo<LedgerItem[]>(() => {
    if (!data) return [];

    const items: LedgerItem[] = [];
    let lastDate = '';

    data.pages.forEach((page) => {
      page.forEach((t) => {
        if (t.date !== lastDate) {
          items.push({
            type: 'date-header',
            id: `date-${t.date}`,
            date: t.date,
          });
          lastDate = t.date;
        }

        const expenseEntries = t.entries.filter(e => e.account_type === 'expense');
        const incomeEntries = t.entries.filter(e => e.account_type === 'income');
        const assetEntries = t.entries.filter(e => ['asset', 'liability', 'equity'].includes(e.account_type));
        
        const expenseSum = expenseEntries.reduce((sum, e) => sum + (Number(e.amount_base) || 0), 0);
        const incomeSum = incomeEntries.reduce((sum, e) => sum + (Number(e.amount_base) || 0), 0);

        let amount = 0;
        let currency = 'BRL';
        let primaryType: 'expense' | 'income' | 'transfer' = 'transfer';

        if (Math.abs(expenseSum) > 0.01) {
          amount = Math.abs(expenseSum);
          // amount is derived from amount_base (always in base currency BRL)
          primaryType = expenseSum > 0 ? 'expense' : 'income';
        } else if (Math.abs(incomeSum) > 0.01) {
          amount = Math.abs(incomeSum);
          // amount is derived from amount_base (always in base currency BRL)
          primaryType = incomeSum < 0 ? 'income' : 'expense';
        } else {
          const posAssetEntries = assetEntries.filter(e => (Number(e.amount_base) || 0) > 0);
          amount = posAssetEntries.reduce((sum, e) => sum + (Number(e.amount_base) || 0), 0);
          // amount is derived from amount_base (always in base currency BRL)
          primaryType = 'transfer';
        }

        const categories = expenseEntries.concat(incomeEntries).map(e => e.account_name);
        const accounts = assetEntries.map(e => e.account_name);

        items.push({
          type: 'transaction',
          id: t.id,
          date: t.date,
          description: t.description,
          accounts,
          categories,
          amount,
          currency,
          entries: t.entries,
          primaryType,
        });
      });
    });

    return items;
  }, [data]);

  const hasFilters = !!(filters.startDate || filters.endDate || filters.accountIds.length > 0 || filters.description);

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  if (isLoading) {
    return (
      <div className="w-full mt-8 max-w-4xl mx-auto space-y-2 animate-pulse px-4">
        {[...Array(10)].map((_, i) => (
          <div key={i} className="h-10 bg-muted/20 rounded-md" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="w-full mt-8 max-w-4xl mx-auto py-10 text-center text-destructive bg-destructive/5 rounded-xl border border-destructive/10">
        <p className="font-semibold">Failed to load ledger</p>
        <button 
          onClick={() => window.location.reload()}
          className="mt-2 text-sm underline hover:text-destructive/80"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="w-full mt-4 mb-20">
      {showExport && (
        <ExportWizard
          initialFilters={filters}
          onClose={() => setShowExport(false)}
        />
      )}
      <div className="flex justify-end mb-2">
        <button
          onClick={() => setShowExport(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-bold uppercase tracking-wider text-white/40 hover:text-white/70 hover:bg-white/[0.05] border border-white/[0.06] transition-all"
        >
          <Download className="w-3.5 h-3.5" /> Export
        </button>
      </div>
      <div className="w-full">
        {ledgerItems.map((item) => {
          if (item.type === 'date-header') {
            const date = new Date(item.date + 'T00:00:00');
            const balance = getBalanceForDate(item.date);
            return (
              <div 
                key={item.id} 
                className="pt-4 pb-2 px-4 sticky top-0 bg-background/90 backdrop-blur-xl z-10 border-b border-white/[0.05] flex justify-between items-end"
              >
                <h3 className="text-[11px] font-bold uppercase tracking-[0.15em] text-white/50">
                  {date.toLocaleDateString('en-US', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </h3>
                <div className="flex flex-col items-end gap-0.5">
                   <span className="text-[9px] uppercase tracking-widest font-bold text-white/20">Total to this day</span>
                   <span className={cn(
                       "text-[14px] font-mono font-bold tracking-tighter",
                       balance < 0 ? "text-destructive/80" : "text-green-500/80"
                   )}>
                    R$ {balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                   </span>
                </div>
              </div>
            );
          }

          return (
            <TransactionRow
              key={item.id}
              item={item}
              isExpanded={expandedId === item.id}
              onToggle={() => toggleExpand(item.id)}
              allTransactions={allTransactionItems}
              hasFilters={hasFilters}
            />
          );
        })}

        {/* Loading Indicator */}
        <div 
          ref={loadMoreRef} 
          className="h-20 flex items-center justify-center text-muted-foreground/20"
        >
          {isFetchingNextPage ? (
            <div className="flex gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" />
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:0.2s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:0.4s]" />
            </div>
          ) : hasNextPage ? (
            <span className="text-[10px] uppercase tracking-[0.2em] font-bold">Scroll to discover</span>
          ) : (
            <span className="text-[10px] uppercase tracking-[0.2em] font-bold opacity-20">End of History</span>
          )}
        </div>
      </div>
    </div>
  );
}
