import React, { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { parseQuickEntry, type TransactionPreview } from '@/lib/ledger-parser/parser';
import { fetchAccounts, createTransaction } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Check, Loader2, AlertCircle } from 'lucide-react';

export function QuickEntryInput() {
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState<TransactionPreview | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const { data: accounts } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  });

  const mutation = useMutation({
    mutationFn: createTransaction,
    onSuccess: () => {
      setInput('');
      setPreview(null);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });

  useEffect(() => {
    if (input.trim()) {
      setPreview(parseQuickEntry(input));
    } else {
      setPreview(null);
    }
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      handleAutocomplete(e);
    } else if (e.key === 'Enter' && preview && preview.entries.length >= 2) {
      e.preventDefault();
      confirmTransaction();
    }
  };

  const handleAutocomplete = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!accounts) return;

    const cursorPosition = inputRef.current?.selectionStart || 0;
    const textBeforeCursor = input.slice(0, cursorPosition);
    const textAfterCursor = input.slice(cursorPosition);

    // Identify if we are in an account name position
    // Simple logic: last word before cursor if it contains ':' or follows '>' or '<'
    const words = textBeforeCursor.split(/\s+/);
    const lastWord = words[words.length - 1];

    if (!lastWord) return;

    const matchingAccount = accounts.find(a => 
      a.account_name.toLowerCase().includes(lastWord.toLowerCase())
    );

    if (matchingAccount) {
      e.preventDefault();
      const newWords = [...words];
      newWords[newWords.length - 1] = matchingAccount.account_name;
      const newInput = newWords.join(' ') + textAfterCursor;
      setInput(newInput);
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
          if (!account) {
            // If account doesn't exist, we might need to handle it.
            // For now, let's assume it must exist or we fail.
            throw new Error(`Account not found: ${e.account}`);
          }
          return {
            account_id: account.account_id,
            amount: e.amount,
            currency: 'BRL', // Default currency
            exchange_rate: 1.0,
            amount_base: e.amount,
          };
        }),
      };

      mutation.mutate(transaction);
    } catch (err: any) {
      console.error(err);
      alert(err.message);
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Lunch 25.50 or assets:bank > expenses:food 50"
          className={cn(
            "w-full bg-input text-foreground px-4 py-3 rounded-lg border-2 border-transparent",
            "focus:outline-none focus:border-primary transition-all text-lg font-medium",
            "placeholder:text-muted-foreground"
          )}
          autoFocus
        />
        <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
          {mutation.isPending && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}
          {mutation.isSuccess && <Check className="w-5 h-5 text-green-500" />}
          {mutation.isError && <AlertCircle className="w-5 h-5 text-destructive" />}
        </div>
      </div>

      {preview && (
        <div className="bg-card border border-border rounded-lg p-4 shadow-xl animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex justify-between items-start mb-4 border-b border-border pb-2">
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Preview</h3>
              <p className="text-lg font-bold">{preview.description}</p>
            </div>
            <div className="text-right">
              <p className="text-sm text-muted-foreground">{preview.date}</p>
            </div>
          </div>

          <div className="space-y-2">
            {preview.entries.map((entry, i) => (
              <div key={i} className="flex justify-between items-center text-sm">
                <span className={cn(
                  "font-mono",
                  entry.account === 'expenses:unknown' || entry.account === 'assets:unknown' 
                    ? "text-yellow-500" 
                    : "text-primary"
                )}>
                  {entry.account}
                </span>
                <span className={cn(
                  "font-bold",
                  entry.amount < 0 ? "text-destructive" : "text-green-500"
                )}>
                  {entry.amount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-4 flex justify-end">
            <p className="text-xs text-muted-foreground">
              Press <kbd className="px-1.5 py-0.5 rounded border border-border bg-muted">Enter</kbd> to confirm • <kbd className="px-1.5 py-0.5 rounded border border-border bg-muted">Tab</kbd> to autocomplete
            </p>
          </div>
        </div>
      )}

      {mutation.isError && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 text-destructive rounded-md text-sm">
          {mutation.error.message}
        </div>
      )}
    </div>
  );
}
