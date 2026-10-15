import { useState, useRef } from 'react';
import { addMonths, subMonths, startOfMonth, format } from 'date-fns';
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { fetchCurrentBudgetPlan } from '@/lib/api';
import { createConversation } from '@/lib/advisor-api';
import type { AdvisorTarget } from './advisor/AdvisorPage';
import { BudgetExecutionView } from './BudgetExecutionView';
import { BudgetPlanningView } from './BudgetPlanningView';
import { BudgetPlanWizard } from './BudgetPlanWizard';
import { BudgetPlanListModal } from './BudgetPlanListModal';

type SubMode = 'execution' | 'planning';
type PeriodView = 'monthly' | 'period';

interface BudgetPageProps {
  onNavigateToLedger: (accountId: string, startDate: string, endDate: string, accountFullName?: string) => void;
  onOpenAdvisor?: (target: AdvisorTarget) => void;
}

export function BudgetPage({ onNavigateToLedger, onOpenAdvisor }: BudgetPageProps) {
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

  async function planWithAdvisor() {
    if (!onOpenAdvisor) return;
    const context = currentPlan
      ? `Current budget plan "${currentPlan.name}" runs ${currentPlan.period_start} to ${currentPlan.period_end}${currentPlan.is_current ? ' (current)' : ''}. Propose budget_upsert items for it, or for a new plan if the user asks.`
      : 'There is no budget plan yet. Ask the user to create one in the Budget page (name and period), then propose budget_upsert items from the spending history.';
    const conv = await createConversation({ title: 'Planejar orçamento', message: 'Quero planejar o orçamento', context });
    onOpenAdvisor({ conversationId: conv.id });
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

          {onOpenAdvisor && (
            <button
              onClick={() => void planWithAdvisor()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-white/[0.08] bg-white/[0.02] text-[13px] font-medium tracking-[-0.01em] text-muted-foreground hover:text-foreground/80 transition-colors backdrop-blur-md"
            >
              <Sparkles className="w-3.5 h-3.5 opacity-80" /> Planejar com o assistente
            </button>
          )}

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
          onPlanWithAdvisor={onOpenAdvisor ? () => void planWithAdvisor() : undefined}
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
