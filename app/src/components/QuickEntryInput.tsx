import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { parseQuickEntry, type TransactionPreview, type InstallmentInfo } from '@/lib/ledger-parser/parser';
import {
  fetchAccounts,
  fetchTransactions,
  createTransaction,
  fetchCategoryUsage,
  fetchGlobalSettings,
  fetchExchangeRate,
  matchDescriptionMemory,
  matchAccount
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { Check, Loader2, AlertCircle, Calendar, Wallet, Tag, Info, ArrowUpRight, ArrowDownLeft, Plus, Trash2, Zap } from 'lucide-react';
import { SearchableSelect } from './SearchableSelect';

// --- Helper for normalization ---
function normalizeString(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/[^\w\s]/g, '')        // Remove punctuation
    .replace(/\s+/g, ' ')           // Collapse spaces
    .trim();
}

// --- Installment date helper ---
function calcInstallmentDate(baseDate: string, current: number, n: number): string {
  if (n === current) return baseDate;
  const base = new Date(baseDate + 'T12:00:00');
  const monthsOffset = n - current;
  return new Date(base.getFullYear(), base.getMonth() + monthsOffset, 1)
    .toISOString().split('T')[0];
}

// --- Main QuickEntryInput Component ---
export function QuickEntryInput() {
  const [input, setInput] = useState('');
  const [selectedDate, setSelectedDate] = useState(() => {
    try {
      const saved = localStorage.getItem('quick_entry_last');
      if (saved) return JSON.parse(saved).date || new Date().toISOString().split('T')[0];
    } catch {}
    return new Date().toISOString().split('T')[0];
  });
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [preview, setPreview] = useState<TransactionPreview | null>(null);
  const [isEdited, setIsEdited] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [matchInfo, setMatchInfo] = useState<{ similarity: number, categoryType?: string } | null>(null);
  const [parsedInstallments, setParsedInstallments] = useState<InstallmentInfo | null>(null);
  const [createInstallments, setCreateInstallments] = useState(true);
  const [installmentAmountMode, setInstallmentAmountMode] = useState<'total' | 'per'>('total');
  const [parsedCurrency, setParsedCurrency] = useState('BRL');
  const [exchangeRate, setExchangeRate] = useState<number | null>(null);
  const [isFetchingRate, setIsFetchingRate] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const { data: accounts } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  });

  const { data: transactions } = useQuery({
    queryKey: ['transactions', { limit: 100 }],
    queryFn: () => fetchTransactions(100),
  });

  const { data: topCategories } = useQuery({
    queryKey: ['categoryUsage'],
    queryFn: fetchCategoryUsage,
  });

  const { data: globalSettings } = useQuery({
    queryKey: ['globalSettings'],
    queryFn: fetchGlobalSettings,
  });

  const accountOptions = useMemo(() =>
    (accounts || [])
      .filter(a => !a.hidden && (a.account_type === 'asset' || a.account_type === 'liability' || a.account_type === 'equity'))
      .map(a => ({ label: a.account_name, value: a.account_name, icon: a.icon, color: a.color })),
  [accounts]);

  const allAccountOptions = useMemo(() =>
    (accounts || []).filter(a => !a.hidden).map(a => ({ label: a.account_name, value: a.account_name, icon: a.icon, color: a.color })),
  [accounts]);

  const topCategoryOptions = useMemo(() =>
    (topCategories || []).map(c => {
      const acc = accounts?.find(a => a.account_name === c.category_name);
      return { label: c.category_name, value: c.category_name, icon: acc?.icon ?? null, color: acc?.color ?? null, hidden: acc?.hidden ?? false };
    }).filter(o => !o.hidden),
  [topCategories, accounts]);

  const lastUsedCurrency = useMemo(() =>
    globalSettings?.find(s => s.key === 'last_used_currency')?.value || 'BRL',
  [globalSettings]);

  const baseCurrency = useMemo(() =>
    globalSettings?.find(s => s.key === 'base_currency')?.value || 'BRL',
  [globalSettings]);

  const lastUsedAccountId = useMemo(() => 
    globalSettings?.find(s => s.key === 'last_used_account_id')?.value,
  [globalSettings]);

  const lastUsedAccount = useMemo(() => {
    if (lastUsedAccountId && accounts) {
      const match = accounts.find(a => a.account_id === lastUsedAccountId);
      if (match) return match.account_name;
    }
    // Fallback to most recent transaction's asset account if global settings are empty
    if (transactions && transactions.length > 0) {
      const recentAsset = transactions[0].entries.find(e => ['asset', 'liability', 'equity'].includes(e.account_type));
      if (recentAsset) return recentAsset.account_name;
    }
    // Final fallback to first available asset/liability account
    return accountOptions[0]?.value || '';
  }, [lastUsedAccountId, accounts, transactions, accountOptions]);

  const installmentPlan = useMemo(() => {
    if (!parsedInstallments || !preview || !createInstallments) return [];
    const results = [];
    for (let n = parsedInstallments.current; n <= parsedInstallments.total; n++) {
      results.push({
        n,
        date: calcInstallmentDate(preview.date, parsedInstallments.current, n),
        description: `${preview.description} (${n} de ${parsedInstallments.total})`,
        amount: preview.entries[0].amount,
      });
    }
    return results;
  }, [parsedInstallments, preview, createInstallments]);

  const mutation = useMutation({
    mutationFn: createTransaction,
    onSuccess: () => {
      setInput('');
      setPreview(null);
      setIsEdited(false);
      setMatchInfo(null);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['categoryUsage'] });
      queryClient.invalidateQueries({ queryKey: ['globalSettings'] });
      if (inputRef.current) inputRef.current.focus();
    },
  });

  // Descriptions for autocomplete still come from transaction history
  const historyDescriptions = useMemo(() => {
    if (!transactions) return [];
    return Array.from(new Set(transactions.map(t => t.description)));
  }, [transactions]);

  // Sync default account from localStorage, then global settings
  useEffect(() => {
    if (!selectedAccount && (lastUsedAccount || accounts)) {
      try {
        const saved = localStorage.getItem('quick_entry_last');
        if (saved) {
          const { account } = JSON.parse(saved);
          if (account && accounts?.some(a => a.account_name === account && !a.hidden)) {
            setSelectedAccount(account);
            return;
          }
        }
      } catch {}
      if (lastUsedAccount) setSelectedAccount(lastUsedAccount);
    }
  }, [lastUsedAccount, selectedAccount, accounts]);

  useEffect(() => {
    if (!input.trim()) {
      setPreview(null);
      setSuggestion(null);
      setIsEdited(false);
      setMatchInfo(null);
      setParsedInstallments(null);
      setCreateInstallments(true);
      setInstallmentAmountMode('total');
      setParsedCurrency(baseCurrency);
      setExchangeRate(null);
      setIsFetchingRate(false);
      return;
    }

    const parsed = parseQuickEntry(input, {
      selectedAccount,
      selectedDate,
      defaultCurrency: baseCurrency,
    });
    
    // Description Autocomplete
    const lowerInput = parsed.description.toLowerCase();
    if (lowerInput.length > 1) {
      const match = historyDescriptions.find(d => d.toLowerCase().startsWith(lowerInput));
      setSuggestion(match && match.toLowerCase() !== lowerInput ? match : null);
    } else {
      setSuggestion(null);
    }

    if (!isEdited) {
      if (parsed.type === 'error') {
        setPreview(null);
        setMatchInfo(null);
        return;
      }

      let cancelled = false;

      const updatePreview = async () => {
        const remainingCount = parsed.installments
          ? parsed.installments.total - parsed.installments.current + 1
          : 1;

        const perInstallmentAmount = parsed.installments
          ? installmentAmountMode === 'total'
            ? (parsed.amount || 0) / remainingCount
            : (parsed.amount || 0)
          : (parsed.amount || 0);

        setParsedInstallments(parsed.installments || null);
        setParsedCurrency(parsed.currency);

        if (parsed.type === 'transfer') {
          // Resolve accounts for transfer
          const [fromRes, toRes] = await Promise.all([
            matchAccount(parsed.from!),
            matchAccount(parsed.to!)
          ]);

          const fromAccount = fromRes?.full_name || `assets:checking:${parsed.from}`;
          const toAccount = toRes?.full_name || `assets:checking:${parsed.to}`;

          if (!cancelled) {
            setPreview({
              date: parsed.date!,
              description: parsed.description,
              entries: [
                { account: toAccount, amount: perInstallmentAmount },
                { account: fromAccount, amount: -perInstallmentAmount },
              ],
            });
            setMatchInfo({ similarity: 1 });
          }
        } else {
          // Resolve memory and account for expense
          const [matches, accMatch] = await Promise.all([
            matchDescriptionMemory(normalizeString(parsed.description)),
            parsed.account ? matchAccount(parsed.account) : Promise.resolve(null)
          ]);

          const bestMatch = matches[0];
          const categoryFallback = topCategoryOptions[0]?.value || allAccountOptions.find(o => o.value.startsWith('expenses:'))?.value || 'expenses:unknown';

          const finalAccount = accMatch?.full_name || bestMatch?.account_name || selectedAccount;
          const finalCategory = bestMatch?.category_name || categoryFallback;

          if (!cancelled) {
            setPreview({
              date: parsed.date!,
              description: parsed.description,
              entries: [
                { account: finalCategory, amount: perInstallmentAmount },
                { account: finalAccount, amount: -perInstallmentAmount },
              ],
            });
            setMatchInfo({
              similarity: bestMatch ? bestMatch.similarity : 0,
              categoryType: bestMatch?.category_type || (finalCategory.startsWith('income:') ? 'income' : 'expense')
            });
          }
        }

        // Fetch exchange rate when currency differs from base
        if (parsed.currency !== baseCurrency) {
          if (!cancelled) {
            setIsFetchingRate(true);
            setExchangeRate(null);
          }
          try {
            const rate = await fetchExchangeRate(parsed.date!, parsed.currency, baseCurrency);
            if (!cancelled) {
              setExchangeRate(rate);
              setIsFetchingRate(false);
            }
          } catch {
            if (!cancelled) {
              setExchangeRate(null);
              setIsFetchingRate(false);
            }
          }
        } else {
          if (!cancelled) {
            setExchangeRate(1.0);
            setIsFetchingRate(false);
          }
        }
      };

      // Simple debounce-like behavior
      const timeoutId = setTimeout(updatePreview, 50);
      return () => {
        cancelled = true;
        clearTimeout(timeoutId);
      };
    }
  }, [input, historyDescriptions, isEdited, selectedAccount, selectedDate, topCategoryOptions, allAccountOptions, lastUsedCurrency, accountOptions, installmentAmountMode]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab' && suggestion) {
      e.preventDefault();
      const parsed = parseQuickEntry(input);
      const newInput = input.replace(parsed.description, suggestion);
      setInput(newInput);
      setSuggestion(null);
    } else if (e.key === 'Enter' && preview && !isEdited && (preview.entries[0].amount !== 0) && !(createInstallments && parsedInstallments)) {
      e.preventDefault();
      confirmTransaction();
    }
  };

  const confirmTransaction = async () => {
    if (!preview || !accounts) return;

    const currency = parsedCurrency;
    const rate = exchangeRate ?? (parsedCurrency !== baseCurrency
      ? await fetchExchangeRate(preview.date, parsedCurrency, baseCurrency)
      : 1.0);

    const buildTx = (date: string, description: string) => ({
      date,
      description,
      entries: preview.entries.map(e => {
        const account = accounts.find(a => a.account_name === e.account);
        if (!account) throw new Error(`Account not found: ${e.account}`);
        return {
          account_id: account.account_id,
          amount: e.amount,
          currency,
          exchange_rate: rate,
          amount_base: e.amount * rate,
        };
      }),
    });

    const isTransfer = parseQuickEntry(input).type === 'transfer';

    try {
      if (createInstallments && parsedInstallments) {
        const txns = [];
        for (let n = parsedInstallments.current; n <= parsedInstallments.total; n++) {
          const date = calcInstallmentDate(preview.date, parsedInstallments.current, n);
          const desc = `${preview.description} (${n} de ${parsedInstallments.total})`;
          txns.push(buildTx(date, desc));
        }
        await Promise.all(txns.map(createTransaction));
        if (!isTransfer) {
          localStorage.setItem('quick_entry_last', JSON.stringify({ date: preview.date, account: selectedAccount }));
        }
        setInput('');
        setPreview(null);
        setIsEdited(false);
        setMatchInfo(null);
        setParsedInstallments(null);
        setCreateInstallments(true);
        setInstallmentAmountMode('total');
        queryClient.invalidateQueries({ queryKey: ['accounts'] });
        queryClient.invalidateQueries({ queryKey: ['transactions'] });
        queryClient.invalidateQueries({ queryKey: ['categoryUsage'] });
        queryClient.invalidateQueries({ queryKey: ['globalSettings'] });
        if (inputRef.current) inputRef.current.focus();
      } else {
        if (!isTransfer) {
          localStorage.setItem('quick_entry_last', JSON.stringify({ date: preview.date, account: selectedAccount }));
        }
        mutation.mutate(buildTx(preview.date, preview.description));
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const updateEntryField = (index: number, field: string, value: any) => {
    if (!preview) return;
    setIsEdited(true);
    const newEntries = [...preview.entries];
    newEntries[index] = { ...newEntries[index], [field]: value };
    
    if (newEntries.length === 2) {
      if (field === 'amount') {
        newEntries[index === 0 ? 1 : 0].amount = -value;
      }
    } else {
      // Multiple entries (Split)
      if (field === 'amount') {
        const sourceIndex = newEntries.findIndex(e => e.amount < 0);
        if (sourceIndex !== -1 && index !== sourceIndex) {
          const positiveSum = newEntries.reduce((sum, e, i) => i !== sourceIndex ? sum + (e.amount || 0) : sum, 0);
          newEntries[sourceIndex].amount = -positiveSum;
        }
      }
    }
    
    setPreview({ ...preview, entries: newEntries });
  };

  const addSplit = () => {
    if (!preview) return;
    setIsEdited(true);
    const categoryFallback = topCategoryOptions[0]?.value || allAccountOptions.find(o => o.value.startsWith('expenses:'))?.value || 'expenses:unknown';
    
    setPreview({
      ...preview,
      entries: [
        ...preview.entries,
        { account: categoryFallback, amount: 0 }
      ]
    });
  };

  const removeSplit = (index: number) => {
    if (!preview || preview.entries.length <= 2) return;
    setIsEdited(true);
    const newEntries = preview.entries.filter((_, i) => i !== index);
    
    // Re-balance
    const sourceIndex = newEntries.findIndex(e => e.amount < 0);
    if (sourceIndex !== -1) {
      const positiveSum = newEntries.reduce((sum, e, i) => i !== sourceIndex ? sum + (e.amount || 0) : sum, 0);
      newEntries[sourceIndex].amount = -positiveSum;
    }
    
    setPreview({ ...preview, entries: newEntries });
  };

  const toggleAllSigns = () => {
    if (!preview) return;
    setIsEdited(true);
    const newEntries = preview.entries.map(e => ({ ...e, amount: -e.amount }));
    setPreview({ ...preview, entries: newEntries });
  };

  const computedTotal = (installmentAmountMode === 'per' && parsedInstallments && preview)
    ? preview.entries[0].amount * (parsedInstallments.total - parsedInstallments.current + 1)
    : null;

  return (
    <div className="w-full space-y-2 relative z-[100]">
      {/* Compact Context Bar - High Z-Index relative to sibling sections */}
      <div className="flex flex-wrap gap-2 items-center bg-muted/10 px-2 py-0.5 rounded-lg border border-border/30 backdrop-blur-xl relative z-30">
        <div className="flex items-center gap-1.5 group cursor-pointer px-1">
          <Calendar className="w-3 h-3 text-muted-foreground/50 group-hover:text-primary transition-colors" />
          <input 
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="bg-transparent border-none p-0 focus:ring-0 text-[11px] font-semibold text-foreground/70"
          />
        </div>
        <div className="h-3 w-px bg-border/30 mx-0.5" />
        <div className="flex-1 min-w-[150px]">
          <SearchableSelect
            options={accountOptions}
            value={selectedAccount}
            onChange={setSelectedAccount}
            placeholder="Account"
            icon={Wallet}
            className="border-none bg-transparent [&>button]:py-1"
          />
        </div>
        <div className="px-2 group relative">
          <Info className="w-3 h-3 text-muted-foreground/30 hover:text-primary transition-colors cursor-help" />
          <div className="absolute right-0 top-full mt-2 w-64 p-3 bg-popover border border-border rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-[110] text-[10px] space-y-2 leading-relaxed">
            <p className="font-bold border-b border-border pb-1 mb-1">Parsing Rules</p>
            <ul className="list-disc pl-3 space-y-1">
              <li><strong>Transfer:</strong> <code className="text-primary">from &gt; to amount [CURRENCY]</code></li>
              <li><strong>Expense:</strong> <code className="text-primary">description amount [CURRENCY] [ACCOUNT]</code></li>
              <li>Last number is always the <strong>amount</strong>.</li>
              <li>Optional <strong>CURRENCY</strong> (3 letters) and <strong>ACCOUNT</strong> follow amount.</li>
              <li>Rest of string is the <strong>description</strong>.</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Main Input - Medium Z-Index relative to sibling sections */}
      <div className="relative group z-20">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="New transaction..."
          className={cn(
            "w-full bg-input/40 text-foreground px-4 py-3 rounded-xl border border-border/40 backdrop-blur-md",
            "focus:outline-none focus:border-primary/40 focus:bg-input/60 transition-all text-lg font-semibold shadow-[0_4px_20px_rgba(0,0,0,0.08)]",
            "placeholder:text-muted-foreground/20"
          )}
          autoFocus
        />
        
        {suggestion && (
          <div className="absolute left-5 top-1/2 -translate-y-1/2 pointer-events-none opacity-15 text-xl font-semibold">
            <span className="invisible">{parseQuickEntry(input).description}</span>
            <span>{suggestion.slice(parseQuickEntry(input).description.length)}</span>
          </div>
        )}

        <div className="absolute right-5 top-1/2 -translate-y-1/2 flex items-center gap-2">
          {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground/40" />}
          {mutation.isSuccess && <Check className="w-4 h-4 text-green-500/60" />}
        </div>
      </div>

      {/* Apple-style Staging Area - Lower Z-Index relative to sibling sections but above table */}
      {preview && (
        <div className="bg-card/30 border border-border/40 rounded-xl shadow-[0_15px_40px_rgba(0,0,0,0.08)] backdrop-blur-2xl animate-in slide-in-from-bottom-2 duration-400 relative z-10">
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-border/20 pb-2.5 gap-4">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <input 
                  value={preview.description}
                  onChange={(e) => { setIsEdited(true); setPreview({...preview, description: e.target.value})}}
                  className="bg-transparent border-none p-0 focus:ring-0 text-[15px] font-bold text-foreground/80 w-full truncate"
                  placeholder="Description"
                />
                {matchInfo && matchInfo.similarity > 0 && (
                  <div className={cn(
                    "flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest shrink-0 whitespace-nowrap",
                    matchInfo.similarity > 0.8 ? "bg-green-500/15 text-green-500" : "bg-yellow-500/15 text-yellow-500"
                  )}>
                    <Zap className="w-2.5 h-2.5 fill-current" />
                    {Math.round(matchInfo.similarity * 100)}% Match
                  </div>
                )}
              </div>
              <span className="text-[10px] font-black text-muted-foreground/30 tracking-widest uppercase shrink-0 tabular-nums">{preview.date}</span>
            </div>

            <div className="space-y-2">
              {preview.entries.map((entry, i) => {
                const isTransfer = parseQuickEntry(input).type === 'transfer';
                
                // Refined Label/Icon logic:
                // !isTransfer: i=0 is Category, i=1 is Account, i>1 are Category splits
                // isTransfer: i=0 is Destination, i=1 is Source
                let label = '';
                let Icon = Tag;

                if (isTransfer) {
                  label = i === 0 ? 'Destination Account' : 'Source Account';
                  Icon = i === 0 ? ArrowDownLeft : ArrowUpRight;
                } else {
                  const isCategory = i === 0 || i > 1;
                  label = isCategory ? (i > 1 ? `Category Split ${i - 1}` : 'Category') : 'Account';
                  Icon = isCategory ? Tag : Wallet;
                }

                const entryAcc = accounts?.find(a => a.account_name === entry.account);
                const isExpense = !isTransfer && preview.entries[0].amount > 0;
                const isIncome = !isTransfer && preview.entries[0].amount < 0;
                const colorClass = isExpense ? "text-red-500/80" : isIncome ? "text-green-500/80" : "text-foreground/70";

                return (
                  <div key={i} className="flex gap-2 items-center bg-background/20 p-0.5 rounded-lg border border-border/10 relative" style={{ zIndex: 20 - i }}>
                    <div className="flex-1 min-w-0">
                      <div className="px-2.5 pb-0.5 text-[9px] font-black text-muted-foreground/40 uppercase tracking-widest flex items-center gap-2 h-4">
                        <span className="shrink-0">{label}</span>
                        {!isTransfer && i === 0 && (
                          <span className={cn(
                            "px-1.5 py-0.5 rounded-[3px] text-[8px] font-black uppercase leading-none",
                            isExpense ? "bg-red-500/20 text-red-500" : "bg-green-500/20 text-green-500"
                          )}>
                            {isExpense ? 'expense' : 'income'}
                          </span>
                        )}
                        {!isTransfer && i === 0 && (
                          <button 
                            onClick={(e) => { e.preventDefault(); toggleAllSigns(); }}
                            className="ml-auto text-[8px] font-black uppercase tracking-widest text-primary hover:underline"
                          >
                            Toggle Sign
                          </button>
                        )}
                        {!isTransfer && i > 1 && (
                          <button 
                            onClick={() => removeSplit(i)}
                            className="ml-auto hover:text-destructive transition-colors"
                          >
                            <Trash2 className="w-2.5 h-2.5" />
                          </button>
                        )}
                      </div>
                      <SearchableSelect
                        options={allAccountOptions}
                        topOptions={!isTransfer && (i === 0 || i > 1) ? topCategoryOptions : []}
                        value={entry.account}
                        onChange={(val) => updateEntryField(i, 'account', val)}
                        placeholder="Select..."
                        icon={entryAcc ? undefined : Icon}
                        className="border-none bg-transparent shadow-none"
                      />
                    </div>
                    <div className="w-36 flex flex-col items-end bg-background/40 rounded-md border border-border/20 px-2 py-1">
                      <div className="text-[9px] font-bold text-muted-foreground/40 uppercase tracking-wider mb-0.5">Amount</div>
                      <div className="flex items-center w-full">
                        <span className="text-muted-foreground/40 mr-1 text-[12px] font-bold">
                          {parsedCurrency}
                        </span>
                        <input
                          type="number"
                          step="0.01"
                          value={Math.abs(entry.amount) || ''}
                          onChange={(e) => updateEntryField(i, 'amount', (entry.amount >= 0 ? 1 : -1) * parseFloat(e.target.value))}
                          className={cn(
                            "w-full bg-transparent border-none p-0 focus:ring-0 text-right font-mono text-[13px] font-bold",
                            colorClass
                          )}
                          placeholder="0.00"
                        />
                      </div>
                      {parsedCurrency !== baseCurrency && entry.amount !== 0 && (
                        <div className="text-[10px] font-mono text-muted-foreground/50 mt-0.5 w-full text-right">
                          {isFetchingRate
                            ? <span className="animate-pulse">converting…</span>
                            : exchangeRate
                              ? `≈ ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: baseCurrency }).format(Math.abs(entry.amount) * exchangeRate)}`
                              : null
                          }
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {parsedCurrency !== baseCurrency && (
                <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground/50 font-mono">
                  {isFetchingRate ? (
                    <><Loader2 className="w-2.5 h-2.5 animate-spin" /> Fetching rate…</>
                  ) : exchangeRate ? (
                    <>1 {parsedCurrency} = {exchangeRate.toFixed(4)} {baseCurrency}</>
                  ) : null}
                </div>
              )}

              {parsedInstallments && (
                <div className="rounded-lg bg-muted/10 border border-border/20 mt-2 overflow-hidden">
                  {/* Row 1: Amount mode toggle */}
                  <div className="flex items-center gap-3 px-3 py-2 border-b border-border/10">
                    <span className="text-[10px] font-bold text-muted-foreground/50 uppercase tracking-widest flex-1">Amount mode</span>
                    <div className="flex items-center gap-1 bg-background/40 rounded-md p-0.5 border border-border/20">
                      <button
                        onClick={() => setInstallmentAmountMode('total')}
                        className={cn("px-2.5 py-1 rounded text-[10px] font-bold transition-all",
                          installmentAmountMode === 'total'
                            ? "bg-white/10 text-foreground shadow-sm"
                            : "text-muted-foreground/50 hover:text-muted-foreground")}
                      >Total</button>
                      <button
                        onClick={() => setInstallmentAmountMode('per')}
                        className={cn("px-2.5 py-1 rounded text-[10px] font-bold transition-all",
                          installmentAmountMode === 'per'
                            ? "bg-white/10 text-foreground shadow-sm"
                            : "text-muted-foreground/50 hover:text-muted-foreground")}
                      >Per installment</button>
                    </div>
                    {computedTotal !== null && (
                      <span className="text-[10px] text-muted-foreground/50 shrink-0">
                        = <span className="font-bold text-foreground/70">
                          {computedTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                        </span>
                      </span>
                    )}
                  </div>

                  {/* Row 2: Create installments toggle */}
                  <div className="flex items-center justify-between px-3 py-2">
                    <div>
                      <span className="text-[11px] font-bold text-foreground/70">Create all installments</span>
                      <p className="text-[10px] text-muted-foreground/40 mt-0.5">
                        {createInstallments
                          ? `${parsedInstallments.total - parsedInstallments.current + 1} transactions, one per month`
                          : 'Only create this single installment'}
                      </p>
                    </div>
                    <button
                      onClick={() => setCreateInstallments(v => !v)}
                      className={cn("w-9 h-5 rounded-full transition-colors relative shrink-0 ml-4",
                        createInstallments ? "bg-emerald-500/80" : "bg-white/10 border border-white/15")}
                    >
                      <span className={cn(
                        "absolute top-0.5 w-4 h-4 rounded-full shadow transition-transform",
                        createInstallments ? "translate-x-4 bg-white" : "translate-x-0.5 bg-white/40"
                      )} />
                    </button>
                  </div>
                </div>
              )}

              {installmentPlan.length > 0 && (
                <div className="rounded-lg border border-border/20 mt-2 overflow-hidden">
                  <div className="px-3 py-1.5 bg-muted/5 border-b border-border/10 flex items-center justify-between">
                    <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/40">
                      Installment Plan
                    </span>
                    <span className="text-[9px] font-bold text-muted-foreground/30">
                      {installmentPlan.length} transactions
                    </span>
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    {installmentPlan.map(inst => (
                      <div key={inst.n} className="flex items-center px-3 py-1 border-b border-border/5 last:border-0 text-[11px] gap-2">
                        <span className="font-mono text-muted-foreground/40 w-16 shrink-0">{inst.date}</span>
                        <span className="text-foreground/60 flex-1 truncate">{inst.description}</span>
                        <span className="font-mono font-bold text-foreground/70 shrink-0">
                          {inst.amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!parseQuickEntry(input).type.includes('transfer') && (
                <button
                  onClick={addSplit}
                  className="w-full py-2 border-2 border-dashed border-border/20 rounded-lg text-[11px] font-bold text-muted-foreground/40 hover:border-primary/30 hover:text-primary/50 transition-all flex items-center justify-center gap-1.5 mt-2"
                >
                  <Plus className="w-3 h-3" />
                  Add Category Split
                </button>
              )}
            </div>
          </div>

          <div className="px-4 py-2.5 bg-muted/5 border-t border-border/20 flex justify-between items-center">
            <div className="text-[10px] font-bold text-muted-foreground/30 flex gap-4 uppercase tracking-tighter">
              <span><kbd className="opacity-40 font-sans">TAB</kbd> Jump</span>
              {!isEdited && <span><kbd className="opacity-40 font-sans">ENTER</kbd> Quick Submit</span>}
            </div>
            
            <button
              onClick={confirmTransaction}
              disabled={mutation.isPending || (preview.entries[0].amount === 0)}
              className={cn(
                "px-4 py-1.5 rounded-lg text-[12px] font-bold transition-all flex items-center gap-1.5",
                (isEdited || !input) && !mutation.isPending
                  ? "bg-primary text-primary-foreground shadow-md hover:brightness-105 active:scale-95"
                  : "bg-muted/50 text-muted-foreground/50"
              )}
            >
              {mutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              {isEdited ? 'Done' : 'Confirm'}
            </button>
          </div>
        </div>
      )}

      {mutation.isError && (
        <div className="p-4 bg-destructive/5 border border-destructive/10 text-destructive/90 rounded-2xl text-[13px] font-medium flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
          <AlertCircle className="w-4 h-4" />
          {mutation.error.message}
        </div>
      )}
    </div>
  );
}
