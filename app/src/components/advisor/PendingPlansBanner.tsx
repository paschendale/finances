import { ArrowRight, ClipboardCheck } from 'lucide-react';
import { usePendingPlans } from './usePendingPlans';

/** Slim banner under the nav when plans await approval. */
export function PendingPlansBanner({ onOpen }: { onOpen: (planId: string, conversationId: string) => void }) {
  const { data: plans = [] } = usePendingPlans();
  if (plans.length === 0) return null;
  const first = plans[0];
  return (
    <button
      onClick={() => onOpen(first.id, first.conversation_id)}
      className="w-full max-w-5xl mb-5 flex items-center gap-3 px-4 py-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.07] hover:bg-amber-500/[0.12] transition-all active:scale-[0.995] text-left"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
      <ClipboardCheck className="w-3.5 h-3.5 text-amber-300 shrink-0" />
      <span className="text-[13px] font-semibold text-amber-100">{plans.length === 1 ? '1 plano esperando sua aprovação' : `${plans.length} planos esperando sua aprovação`}</span>
      <span className="text-[12px] text-amber-200/60 truncate hidden sm:inline">{plans.map((p) => p.title).join(' · ')}</span>
      <span className="flex-1" />
      <span className="flex items-center gap-1 text-[12px] font-semibold text-amber-200">Revisar <ArrowRight className="w-3.5 h-3.5" /></span>
    </button>
  );
}
