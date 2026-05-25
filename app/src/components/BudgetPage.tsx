import { useState, useRef } from 'react';
import { addMonths, subMonths, startOfMonth, format } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { fetchCurrentBudgetPlan } from '@/lib/api';
import { BudgetExecutionView } from './BudgetExecutionView';
import { BudgetPlanningView } from './BudgetPlanningView';
import { BudgetPlanWizard } from './BudgetPlanWizard';
import { BudgetPlanListModal } from './BudgetPlanListModal';

type SubMode = 'execution' | 'planning';
type PeriodView = 'monthly' | 'period';

interface BudgetPageProps {
  onNavigateToLedger: (accountId: string, startDate: string, endDate: string) => void;
}

export function BudgetPage({ onNavigateToLedger }: BudgetPageProps) {
  const [subMode, setSubMode] = useState<SubMode>('execution');
  const [currentMonth, setCurrentMonth] = useState<Date>(() => startOfMonth(new Date()));
  const [periodView, setPeriodView] = useState<PeriodView>('monthly');
  const [showPlansModal, setShowPlansModal] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const isDirtyRef = useRef(false);

  const { data: currentPlan = null } = useQuery({
    queryKey: ['budgetCurrentPlan'],
    queryFn: fetchCurrentBudgetPlan,
  });

  function handleSubModeChange(nextMode: SubMode) {
    if (subMode === 'planning' && nextMode === 'execution' && isDirtyRef.current) {
      if (!window.confirm('Discard unsaved changes?')) return;
      isDirtyRef.current = false;
    }
    setSubMode(nextMode);
  }

  function openWizard() {
    setShowPlansModal(false);
    setShowWizard(true);
  }

  return (
    <div className="w-full space-y-6 pb-20">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        {/* Sub-mode switcher */}
        <nav className="flex rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5 backdrop-blur-md">
          {(['execution', 'planning'] as SubMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => handleSubModeChange(mode)}
              className={cn(
                'flex items-center px-4 py-2 rounded-md text-[13px] font-medium tracking-[-0.01em] transition-colors capitalize',
                subMode === mode
                  ? 'bg-white/10 text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground/80',
              )}
            >
              {mode}
            </button>
          ))}
        </nav>

        {/* Month navigator */}
        <div className="flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5 backdrop-blur-md">
          <button
            onClick={() => setCurrentMonth((m) => subMonths(m, 1))}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/[0.06] transition-colors"
            aria-label="Previous month"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span className="px-3 text-[13px] font-medium tracking-[-0.01em] tabular-nums min-w-[7rem] text-center">
            {format(currentMonth, 'MMMM yyyy')}
          </span>
          <button
            onClick={() => setCurrentMonth((m) => addMonths(m, 1))}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/[0.06] transition-colors"
            aria-label="Next month"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          {/* Period toggle */}
          <nav className="flex rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5 backdrop-blur-md">
            {(['monthly', 'period'] as PeriodView[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriodView(p)}
                className={cn(
                  'flex items-center px-4 py-2 rounded-md text-[13px] font-medium tracking-[-0.01em] transition-colors capitalize',
                  periodView === p
                    ? 'bg-white/10 text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground/80',
                )}
              >
                {p === 'monthly' ? 'Monthly' : 'Period'}
              </button>
            ))}
          </nav>

          {/* Plans button */}
          <button
            onClick={() => setShowPlansModal(true)}
            className="flex items-center px-4 py-2 rounded-lg border border-white/[0.08] bg-white/[0.02] text-[13px] font-medium tracking-[-0.01em] text-muted-foreground hover:text-foreground/80 transition-colors backdrop-blur-md"
          >
            Plans
          </button>
        </div>
      </div>

      {/* Content area */}
      {subMode === 'execution' ? (
        <BudgetExecutionView
          currentMonth={currentMonth}
          periodView={periodView}
          onNavigateToLedger={onNavigateToLedger}
          onCreatePlan={openWizard}
        />
      ) : (
        <BudgetPlanningView
          plan={currentPlan}
          onOpenWizard={openWizard}
          setDirty={(v) => { isDirtyRef.current = v; }}
          onSaved={() => setSubMode('execution')}
        />
      )}

      {/* Modals */}
      {showPlansModal && (
        <BudgetPlanListModal
          onClose={() => setShowPlansModal(false)}
          onNewPlan={openWizard}
        />
      )}

      {showWizard && (
        <BudgetPlanWizard
          onClose={() => setShowWizard(false)}
          onSuccess={() => {
            setShowWizard(false);
            setSubMode('planning');
          }}
        />
      )}
    </div>
  );
}
