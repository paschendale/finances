import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Check, Plus, Loader2 } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { fetchAllBudgetPlans, setCurrentBudgetPlan } from '@/lib/api';
import { cn } from '@/lib/utils';

interface BudgetPlanListModalProps {
  onClose: () => void;
  onNewPlan: () => void;
}

function formatPeriod(start: string, end: string): string {
  return `${format(parseISO(start), 'MMM yyyy')} – ${format(parseISO(end), 'MMM yyyy')}`;
}

export function BudgetPlanListModal({ onClose, onNewPlan }: BudgetPlanListModalProps) {
  const queryClient = useQueryClient();

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ['budgetPlans'],
    queryFn: fetchAllBudgetPlans,
  });

  const setCurrent = useMutation({
    mutationFn: (planId: string) => setCurrentBudgetPlan(planId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgetCurrentPlan'] });
      queryClient.invalidateQueries({ queryKey: ['budgetPlans'] });
    },
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-md flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md bg-[#111] border border-white/[0.08] rounded-2xl shadow-2xl flex flex-col overflow-hidden max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] shrink-0">
          <h2 className="text-[15px] font-bold tracking-tight">Budget Plans</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/[0.06] text-white/40 hover:text-white/80 transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Plan list */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-white/30" />
            </div>
          ) : plans.length === 0 ? (
            <div className="py-12 text-center text-[13px] text-white/30">No plans yet.</div>
          ) : (
            <div className="p-2">
              {plans.map((plan) => (
                <div
                  key={plan.id}
                  className="flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-white/[0.03] transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-[14px] font-medium text-foreground/90 truncate">{plan.name}</p>
                    <p className="text-[11px] text-white/35 font-mono tabular-nums mt-0.5">
                      {formatPeriod(plan.period_start, plan.period_end)}
                    </p>
                  </div>

                  {plan.is_current ? (
                    <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/[0.06] text-[11px] font-semibold text-white/60">
                      <Check className="w-3 h-3" />
                      Current
                    </span>
                  ) : (
                    <button
                      onClick={() => setCurrent.mutate(plan.id)}
                      disabled={setCurrent.isPending}
                      className={cn(
                        'px-3 py-1 rounded-md text-[11px] font-semibold border border-white/[0.08] transition-all',
                        setCurrent.isPending
                          ? 'text-white/20 cursor-not-allowed'
                          : 'text-white/50 hover:text-white/80 hover:bg-white/[0.05] hover:border-white/[0.15]',
                      )}
                    >
                      Set current
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-white/[0.06] shrink-0">
          <button
            onClick={onNewPlan}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-dashed border-white/[0.12] text-[13px] font-medium text-white/50 hover:text-white/80 hover:border-white/[0.25] hover:bg-white/[0.03] transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            New Plan
          </button>
        </div>
      </div>
    </div>
  );
}
