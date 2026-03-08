import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchTransactions, type Entry } from '@/lib/api';
import { useMemo, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

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

export function LedgerTable() {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
  } = useInfiniteQuery({
    queryKey: ['transactions'],
    queryFn: ({ pageParam = 0 }) => fetchTransactions(50, pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < 50) return undefined;
      return allPages.length * 50;
    },
  });

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

        const categories = t.entries
          .filter((e) => e.account_type === 'expense' || e.account_type === 'income')
          .map((e) => e.account_name); // Full hierarchy

        const accounts = t.entries
          .filter((e) => e.account_type === 'asset' || e.account_type === 'liability')
          .map((e) => e.account_name.split(':').pop() || e.account_name);

        let amount = 0;
        let currency = 'BRL';
        let primaryType: 'expense' | 'income' | 'transfer' = 'transfer';

        const expenseEntries = t.entries.filter((e) => e.account_type === 'expense');
        const incomeEntries = t.entries.filter((e) => e.account_type === 'income');

        if (expenseEntries.length > 0) {
          amount = expenseEntries.reduce((sum, e) => sum + e.amount_base, 0);
          currency = expenseEntries[0].currency;
          primaryType = 'expense';
        } else if (incomeEntries.length > 0) {
          amount = Math.abs(incomeEntries.reduce((sum, e) => sum + e.amount_base, 0));
          currency = incomeEntries[0].currency;
          primaryType = 'income';
        } else {
          const positiveAssetEntries = t.entries.filter(
            (e) => (e.account_type === 'asset' || e.account_type === 'liability') && e.amount_base > 0
          );
          amount = positiveAssetEntries.reduce((sum, e) => sum + e.amount_base, 0);
          if (positiveAssetEntries.length > 0) {
            currency = positiveAssetEntries[0].currency;
          }
          primaryType = 'transfer';
        }

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
    <div className="w-full mt-8 mb-20">
      <div className="max-w-5xl mx-auto">
        {ledgerItems.map((item) => {
          if (item.type === 'date-header') {
            const date = new Date(item.date + 'T00:00:00');
            return (
              <div 
                key={item.id} 
                className="pt-6 pb-2 px-4 sticky top-0 bg-background/90 backdrop-blur-sm z-10 border-b border-border/40"
              >
                <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground/70">
                  {date.toLocaleDateString('en-US', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </h3>
              </div>
            );
          }

          const isExpanded = expandedId === item.id;
          const formatter = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: item.currency || 'BRL',
          });

          return (
            <div
              key={item.id}
              className={cn(
                "group flex flex-col border-b border-border/30 transition-all duration-200",
                isExpanded ? "bg-muted/30" : "hover:bg-muted/15"
              )}
            >
              <button
                onClick={() => toggleExpand(item.id)}
                className="w-full flex items-center px-4 py-2 text-left focus:outline-none"
              >
                {/* Compact Row Grid */}
                <div className="grid grid-cols-[1.5fr_1fr_1fr_120px] gap-4 w-full items-center">
                  <span className="font-medium text-[14px] truncate text-foreground/90">
                    {item.description}
                  </span>
                  
                  <span className="text-[12px] text-muted-foreground/80 truncate font-mono">
                    {item.categories.join(', ')}
                  </span>
                  
                  <span className="text-[12px] text-muted-foreground/60 truncate">
                    {item.accounts.join(' • ')}
                  </span>
                  
                  <div className="text-right font-mono font-bold text-[14px]">
                    <span className={cn(
                      item.primaryType === 'expense' ? "text-destructive/90" : 
                      item.primaryType === 'income' ? "text-green-500/90" : 
                      "text-foreground/70"
                    )}>
                      {item.primaryType === 'expense' ? '-' : ''}
                      {formatter.format(item.amount)}
                    </span>
                  </div>
                </div>
              </button>

              {/* Expanded Details */}
              <div className={cn(
                "overflow-hidden transition-all duration-300 ease-in-out px-4",
                isExpanded ? "max-h-96 pb-4 opacity-100" : "max-h-0 opacity-0"
              )}>
                <div className="pt-2 space-y-1 bg-background/40 rounded-lg p-3 border border-border/30">
                  <div className="flex justify-between items-center mb-2 px-1">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Transaction Entries</span>
                    <span className="text-[10px] text-muted-foreground/50 font-mono uppercase">{item.id.slice(0, 8)}</span>
                  </div>
                  {item.entries.map((entry, idx) => (
                    <div key={idx} className="flex justify-between items-center py-1 border-b border-border/10 last:border-0 text-[13px]">
                      <div className="flex flex-col">
                        <span className="font-medium text-primary/80">{entry.account_name}</span>
                        <span className="text-[10px] text-muted-foreground/60 uppercase font-bold tracking-tighter">{entry.account_type}</span>
                      </div>
                      <span className={cn(
                        "font-mono font-medium",
                        entry.amount_base < 0 ? "text-destructive/70" : "text-green-500/70"
                      )}>
                        {new Intl.NumberFormat('en-US', {
                          style: 'currency',
                          currency: entry.currency || 'BRL',
                        }).format(entry.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
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
