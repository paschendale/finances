import { useState, useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, PiggyBank, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { createBudgetPlan, type BudgetPlan } from '@/lib/api';

interface BudgetPlanWizardProps {
  onClose: () => void;
  onSuccess: (plan: BudgetPlan) => void;
}

export function BudgetPlanWizard({ onClose, onSuccess }: BudgetPlanWizardProps) {
  const currentYear = new Date().getFullYear();
  const [name, setName] = useState('');
  const [periodStart, setPeriodStart] = useState(`${currentYear}-01-01`);
  const [periodEnd, setPeriodEnd] = useState(`${currentYear}-12-31`);
  const queryClient = useQueryClient();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: () => createBudgetPlan(name.trim(), periodStart, periodEnd),
    onSuccess: (plan) => {
      queryClient.invalidateQueries({ queryKey: ['budgetCurrentPlan'] });
      queryClient.invalidateQueries({ queryKey: ['budgetPlans'] });
      onSuccess(plan);
    },
  });

  const canConfirm = name.trim().length > 0 && periodStart && periodEnd && periodStart <= periodEnd;

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-md flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md bg-[#111] border border-white/[0.08] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-3">
            <PiggyBank className="w-4 h-4 text-white/50" />
            <h2 className="text-[15px] font-bold tracking-tight">New Budget Plan</h2>
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
          <div className="space-y-1.5">
            <label className="text-[11px] font-bold uppercase tracking-[0.1em] text-white/40">Plan Name</label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && canConfirm) mutation.mutate(); }}
              placeholder="2026 Annual Budget"
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-[14px] placeholder:text-white/20 focus:outline-none focus:border-white/20 focus:bg-white/[0.06] transition-all"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold uppercase tracking-[0.1em] text-white/40">Start</label>
              <input
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-[14px] focus:outline-none focus:border-white/20 focus:bg-white/[0.06] transition-all"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold uppercase tracking-[0.1em] text-white/40">End</label>
              <input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-[14px] focus:outline-none focus:border-white/20 focus:bg-white/[0.06] transition-all"
              />
            </div>
          </div>

          {mutation.isError && (
            <p className="text-[12px] text-red-400/80">Failed to create plan. Please try again.</p>
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
            onClick={() => mutation.mutate()}
            disabled={!canConfirm || mutation.isPending}
            className={cn(
              'flex items-center gap-2 px-5 py-2 rounded-lg text-[13px] font-semibold transition-all',
              canConfirm && !mutation.isPending
                ? 'bg-white text-black hover:bg-white/90 active:scale-[0.98]'
                : 'bg-white/10 text-white/30 cursor-not-allowed',
            )}
          >
            {mutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Create Plan
          </button>
        </div>
      </div>
    </div>
  );
}
