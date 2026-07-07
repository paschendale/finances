import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UndoDot, X, Loader2 } from 'lucide-react';
import { cn, formatHierarchicalName } from '@/lib/utils';
import { fetchAccounts, updateTransaction, createTransaction, type Entry } from '@/lib/api';
import { SearchableSelect } from './SearchableSelect';

interface AdvanceInstallmentTransaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  currency: string;
  entries: Entry[];
}

function getTodayLocalISO(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getInstallmentNumber(desc: string): number {
  const m = desc.match(/\((\d+) de \d+\)$/);
  return m ? parseInt(m[1]) : 0;
}

export function AdvanceInstallmentModal({
  transaction,
  siblings,
  onClose,
}: {
  transaction: AdvanceInstallmentTransaction;
  siblings: AdvanceInstallmentTransaction[];
  onClose: () => void;
}) {
  const [date, setDate] = useState(getTodayLocalISO());
  const [discountAmount, setDiscountAmount] = useState('');
  const [discountAccountId, setDiscountAccountId] = useState('');
  const queryClient = useQueryClient();
  const discountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    discountRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const { data: accounts } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  });

  const discountAccountOptions = useMemo(() =>
    (accounts || [])
      .filter(a => a.account_type === 'income' && !a.hidden)
      .map(a => ({ label: a.account_name, value: a.account_id, icon: a.icon, color: a.color })),
  [accounts]);

  // Earlier, still-pending installments in the same series get swept into this
  // action: you can't settle a later installment early while an earlier one
  // sits unpaid in the future. They move to the same target date, full amount,
  // no discount (the discount is a one-time incentive for the installment you
  // actually opened the modal on).
  const anchorNumber = getInstallmentNumber(transaction.description);
  const today = getTodayLocalISO();
  const sweepSiblings = siblings.filter(s =>
    s.id !== transaction.id
    && getInstallmentNumber(s.description) > 0
    && getInstallmentNumber(s.description) < anchorNumber
    && s.date > today,
  );

  const earliestDate = [transaction.date, ...sweepSiblings.map(s => s.date)].sort()[0];

  // The discount is booked as its own separate income transaction rather than
  // an extra leg on the installment itself — the installment's own entries
  // never change (just its date), so this needs to identify exactly one
  // asset/liability entry to know which account the discount gets credited
  // back into; any number of category entries can still be present.
  const assetEntries = transaction.entries.filter(e => ['asset', 'liability', 'equity'].includes(e.account_type));
  const assetEntry = assetEntries.length === 1 ? assetEntries[0] : null;
  const discountSupported = !!assetEntry;

  const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: transaction.currency || 'BRL' });

  const A = assetEntry ? Math.abs(assetEntry.amount) : Math.abs(transaction.amount);
  const D = discountSupported ? (parseFloat(discountAmount) || 0) : 0;

  const isValid = date.length > 0 && date <= earliestDate
    && D >= 0 && (!discountSupported || D < A)
    && (D === 0 || discountAccountId !== '');

  const mutation = useMutation({
    mutationFn: async () => {
      const calls: Promise<unknown>[] = [
        updateTransaction({
          id: transaction.id,
          date,
          description: transaction.description,
          entries: transaction.entries,
          account_ids: transaction.entries.map(e => e.account_id),
        }),
        ...sweepSiblings.map(s => updateTransaction({
          id: s.id,
          date,
          description: s.description,
          entries: s.entries,
          account_ids: s.entries.map(e => e.account_id),
        })),
      ];
      if (D > 0 && assetEntry && discountAccountId) {
        const rate = assetEntry.exchange_rate || 1.0;
        calls.push(createTransaction({
          date,
          description: `Desconto - ${transaction.description}`,
          entries: [
            { account_id: discountAccountId, amount: -D, currency: assetEntry.currency, exchange_rate: rate, amount_base: -D * rate },
            { account_id: assetEntry.account_id, amount: D, currency: assetEntry.currency, exchange_rate: rate, amount_base: D * rate },
          ],
        }));
      }
      await Promise.all(calls);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onClose();
    },
  });

  const handleConfirm = () => {
    if (!isValid) return;
    mutation.mutate();
  };

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-md flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md bg-[#111] border border-white/[0.08] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-3">
            <UndoDot className="w-4 h-4 text-white/50" />
            <h2 className="text-[15px] font-bold tracking-tight">Adiantar Parcela</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/[0.06] text-white/40 hover:text-white/80 transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          <div className="space-y-1">
            <p className="text-[14px] font-semibold text-white/80 truncate">{transaction.description}</p>
            <p className="text-[11px] text-white/40 font-mono">{transaction.date}</p>
          </div>

          {sweepSiblings.length > 0 && (
            <div className="rounded-xl bg-blue-500/[0.06] border border-blue-500/20 p-3 space-y-1.5">
              <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400/70">
                Also anticipated ({sweepSiblings.length})
              </p>
              {sweepSiblings.sort((a, b) => a.date.localeCompare(b.date)).map(s => (
                <div key={s.id} className="flex items-center justify-between text-[12px]">
                  <span className="text-white/50 font-mono">{s.date}</span>
                  <span className="text-white/40">{s.description}</span>
                </div>
              ))}
              <p className="text-[11px] text-white/30 pt-1">
                These earlier, still-pending installments move to the same new date, full amount, no discount.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[11px] font-bold uppercase tracking-[0.1em] text-white/40">New Date</label>
            <input
              type="date"
              value={date}
              max={earliestDate}
              onChange={(e) => setDate(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-[14px] focus:outline-none focus:border-white/20 focus:bg-white/[0.06] transition-all"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-bold uppercase tracking-[0.1em] text-white/40">Discount</label>
            <input
              ref={discountRef}
              type="number"
              step="0.01"
              min="0"
              disabled={!discountSupported}
              value={discountAmount}
              onChange={(e) => setDiscountAmount(e.target.value)}
              placeholder="0.00"
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-[14px] font-mono placeholder:text-white/20 focus:outline-none focus:border-white/20 focus:bg-white/[0.06] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            />
            {!discountSupported && (
              <p className="text-[11px] text-white/30">Discount isn't available for this transaction's entry layout — you can still move the date.</p>
            )}
            {discountSupported && D >= A && (
              <p className="text-[11px] text-red-400/80">Discount must be less than {formatter.format(A)}</p>
            )}
          </div>

          {discountSupported && D > 0 && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold uppercase tracking-[0.1em] text-white/40">Discount Category</label>
              <SearchableSelect
                options={discountAccountOptions}
                value={discountAccountId}
                onChange={setDiscountAccountId}
                placeholder="Select income category..."
              />
            </div>
          )}

          {/* Preview */}
          <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3 space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/30">Preview</p>
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-white/40 truncate">{transaction.description}</span>
              <span className="font-mono text-red-400/80 shrink-0 ml-2">{date} · -{formatter.format(A)}</span>
            </div>
            {D > 0 && (
              <div className="flex items-center justify-between text-[13px] pt-1 border-t border-white/[0.06]">
                <span className="text-white/40 truncate">Desconto - {transaction.description}</span>
                <span className="font-mono text-green-400/80 shrink-0 ml-2">
                  {date} · +{formatter.format(D)}
                </span>
              </div>
            )}
            {D > 0 && discountAccountId && (
              <p className="text-[11px] text-white/30">
                New income transaction → {formatHierarchicalName(discountAccountOptions.find(o => o.value === discountAccountId)?.label || '')}
              </p>
            )}
          </div>

          {mutation.isError && (
            <p className="text-[12px] text-red-400/80">{(mutation.error as Error)?.message || 'Failed to advance installment.'}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-white/[0.06]">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-[13px] font-medium text-white/50 hover:text-white/80 hover:bg-white/[0.05] transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!isValid || mutation.isPending}
            className={cn(
              'flex items-center gap-2 px-5 py-2 rounded-lg text-[13px] font-semibold transition-all',
              isValid && !mutation.isPending
                ? 'bg-white text-black hover:bg-white/90 active:scale-[0.98]'
                : 'bg-white/10 text-white/30 cursor-not-allowed',
            )}
          >
            {mutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
