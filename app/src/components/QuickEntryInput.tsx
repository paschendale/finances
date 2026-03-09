import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { parseQuickEntry, type TransactionPreview } from '@/lib/ledger-parser/parser';
import { fetchAccounts, fetchTransactions, createTransaction, fetchCategoryUsage, fetchDescriptionMemories, fetchGlobalSettings } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Check, Loader2, AlertCircle, Calendar, Wallet, Tag, Info, ArrowUpRight, ArrowDownLeft, Plus, Trash2 } from 'lucide-react';
import { SearchableSelect } from './SearchableSelect';

// --- Main QuickEntryInput Component ---
export function QuickEntryInput() {
  const [input, setInput] = useState('');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [preview, setPreview] = useState<TransactionPreview | null>(null);
  const [isEdited, setIsEdited] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  
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

  const { data: descriptionMemories } = useQuery({
    queryKey: ['descriptionMemories'],
    queryFn: fetchDescriptionMemories,
  });

  const { data: globalSettings } = useQuery({
    queryKey: ['globalSettings'],
    queryFn: fetchGlobalSettings,
  });

  const accountOptions = useMemo(() => 
    (accounts || []).filter(a => a.account_type === 'asset' || a.account_type === 'liability' || a.account_type === 'equity').map(a => ({ label: a.account_name, value: a.account_name })),
  [accounts]);

  const allAccountOptions = useMemo(() => 
    (accounts || [])
      .map(a => ({ label: a.account_name, value: a.account_name })),
  [accounts]);

  const topCategoryOptions = useMemo(() => 
    (topCategories || []).map(c => ({ label: c.category_name, value: c.category_name })),
  [topCategories]);

  const lastUsedCurrency = useMemo(() => 
    globalSettings?.find(s => s.key === 'last_used_currency')?.value || 'BRL',
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

  const memoryMap = useMemo(() => {
    const map = new Map<string, { category: string, account: string, currency: string }>();
    (descriptionMemories || []).forEach(m => {
      map.set(m.description.toLowerCase(), {
        category: m.category_name,
        account: m.account_name,
        currency: m.currency
      });
    });
    return map;
  }, [descriptionMemories]);

  const mutation = useMutation({
    mutationFn: createTransaction,
    onSuccess: () => {
      setInput('');
      setPreview(null);
      setIsEdited(false);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['descriptionMemories'] });
      queryClient.invalidateQueries({ queryKey: ['globalSettings'] });
      if (inputRef.current) inputRef.current.focus();
    },
  });

  // Descriptions for autocomplete still come from transaction history
  const historyDescriptions = useMemo(() => {
    if (!transactions) return [];
    return Array.from(new Set(transactions.map(t => t.description)));
  }, [transactions]);

  // Sync default account from global settings
  useEffect(() => {
    if (lastUsedAccount && !selectedAccount) {
      setSelectedAccount(lastUsedAccount);
    }
  }, [lastUsedAccount, selectedAccount]);

  useEffect(() => {
    if (!input.trim()) {
      setPreview(null);
      setSuggestion(null);
      setIsEdited(false);
      return;
    }

    const parsed = parseQuickEntry(input, {
      selectedAccount,
      selectedDate,
      defaultCurrency: lastUsedCurrency,
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
        return;
      }

      if (parsed.type === 'transfer') {
        const fromAccount = allAccountOptions.find(o => o.value.toLowerCase().includes(parsed.from!.toLowerCase()))?.value || `assets:checking:${parsed.from}`;
        const toAccount = allAccountOptions.find(o => o.value.toLowerCase().includes(parsed.to!.toLowerCase()))?.value || `assets:checking:${parsed.to}`;
        
        setPreview({
          date: parsed.date!,
          description: parsed.description,
          entries: [
            { account: toAccount, amount: parsed.amount || 0 },
            { account: fromAccount, amount: -(parsed.amount || 0) },
          ],
        });
      } else {
        const memory = memoryMap.get(parsed.description.toLowerCase());
        const categoryFallback = topCategoryOptions[0]?.value || allAccountOptions.find(o => o.value.startsWith('expenses:'))?.value || 'expenses:unknown';
        
        const finalAccountName = parsed.account || (memory?.account) || selectedAccount;
        
        // Robust account resolution
        const accountMatch = allAccountOptions.find(o => o.value.toLowerCase() === finalAccountName.toLowerCase() || o.value.toLowerCase().includes(finalAccountName.toLowerCase()));
        const finalAccount = accountMatch ? accountMatch.value : (finalAccountName.includes(':') ? finalAccountName : `assets:checking:${finalAccountName}`);

        const memoryCategoryName = memory?.category;
        const categoryMatch = memoryCategoryName ? allAccountOptions.find(o => o.value === memoryCategoryName) : null;
        const finalCategory = categoryMatch ? categoryMatch.value : categoryFallback;

        setPreview({
          date: parsed.date!,
          description: parsed.description,
          entries: [
            { account: finalCategory, amount: parsed.amount || 0 },
            { account: finalAccount, amount: -(parsed.amount || 0) },
          ],
        });
      }
    }
  }, [input, historyDescriptions, memoryMap, isEdited, selectedAccount, selectedDate, topCategoryOptions, allAccountOptions, lastUsedCurrency, accountOptions]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab' && suggestion) {
      e.preventDefault();
      const parsed = parseQuickEntry(input);
      const newInput = input.replace(parsed.description, suggestion);
      setInput(newInput);
      setSuggestion(null);
    } else if (e.key === 'Enter' && preview && !isEdited && (preview.entries[0].amount !== 0)) {
      e.preventDefault();
      confirmTransaction();
    }
  };

  const confirmTransaction = () => {
    if (!preview || !accounts) return;

    try {
      const transaction = {
        date: preview.date,
        description: preview.description,
        entries: preview.entries.map(e => {
          const account = accounts.find(a => a.account_name === e.account);
          if (!account) throw new Error(`Account not found: ${e.account}`);
          return {
            account_id: account.account_id,
            amount: e.amount,
            currency: lastUsedCurrency,
            exchange_rate: 1.0,
            amount_base: e.amount,
          };
        }),
      };
      mutation.mutate(transaction);
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

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4 relative z-[100]">
      {/* Compact Context Bar - High Z-Index relative to sibling sections */}
      <div className="flex flex-wrap gap-2 items-center bg-muted/10 px-2 py-1 rounded-lg border border-border/30 backdrop-blur-xl relative z-30">
        <div className="flex items-center gap-1.5 group cursor-pointer px-1">
          <Calendar className="w-3 h-3 text-muted-foreground/50 group-hover:text-primary transition-colors" />
          <input 
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="bg-transparent border-none p-0 focus:ring-0 text-[12px] font-semibold text-foreground/70"
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
            className="border-none bg-transparent"
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
            "w-full bg-input/40 text-foreground px-5 py-4 rounded-xl border border-border/40 backdrop-blur-md",
            "focus:outline-none focus:border-primary/40 focus:bg-input/60 transition-all text-xl font-semibold shadow-[0_4px_20px_rgba(0,0,0,0.08)]",
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
            <div className="flex justify-between items-center border-b border-border/20 pb-2.5">
              <input 
                value={preview.description}
                onChange={(e) => { setIsEdited(true); setPreview({...preview, description: e.target.value})}}
                className="bg-transparent border-none p-0 focus:ring-0 text-[15px] font-bold text-foreground/80 w-full"
                placeholder="Description"
              />
              <span className="text-[11px] font-bold text-muted-foreground/40 tracking-tight uppercase">{preview.date}</span>
            </div>

            <div className="space-y-2">
              {preview.entries.map((entry, i) => {
                const isTransfer = parseQuickEntry(input).type === 'transfer';
                const isPositive = entry.amount >= 0;
                
                let label = isPositive ? (preview.entries.filter(e => e.amount >= 0).length > 1 ? `Category Split ${preview.entries.filter((e, idx) => e.amount >= 0 && idx <= i).length}` : 'Category') : 'Source Account';
                let Icon = isPositive ? Tag : Wallet;

                if (isTransfer) {
                  label = isPositive ? 'Destination Account' : 'Source Account';
                  Icon = isPositive ? ArrowDownLeft : ArrowUpRight;
                }

                return (
                  <div key={i} className="flex gap-2 items-center bg-background/20 p-0.5 rounded-lg border border-border/10 relative" style={{ zIndex: 20 - i }}>
                    <div className="flex-1 min-w-0">
                      <div className="px-2.5 pb-0.5 text-[9px] font-bold text-muted-foreground/40 uppercase tracking-wider flex justify-between">
                        <span>{label}</span>
                        {isPositive && preview.entries.length > 2 && (
                          <button 
                            onClick={() => removeSplit(i)}
                            className="hover:text-destructive transition-colors"
                          >
                            <Trash2 className="w-2.5 h-2.5" />
                          </button>
                        )}
                      </div>
                      <SearchableSelect
                        options={allAccountOptions}
                        topOptions={!isTransfer && isPositive ? topCategoryOptions : []}
                        value={entry.account}
                        onChange={(val) => updateEntryField(i, 'account', val)}
                        placeholder="Select..."
                        icon={Icon}
                        className="border-none bg-transparent shadow-none"
                      />
                    </div>
                    <div className="w-28 flex flex-col items-end bg-background/40 rounded-md border border-border/20 px-2 py-1">
                      <div className="text-[9px] font-bold text-muted-foreground/40 uppercase tracking-wider mb-0.5">Amount</div>
                      <div className="flex items-center w-full">
                        <span className="text-muted-foreground/40 mr-1 text-[12px] font-bold">$</span>
                        <input
                          type="number"
                          step="0.01"
                          value={Math.abs(entry.amount) || ''}
                          onChange={(e) => updateEntryField(i, 'amount', (isPositive ? 1 : -1) * parseFloat(e.target.value))}
                          className={cn(
                            "w-full bg-transparent border-none p-0 focus:ring-0 text-right font-mono text-[13px] font-bold",
                            isPositive ? "text-green-500/80" : "text-destructive/70"
                          )}
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}

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
