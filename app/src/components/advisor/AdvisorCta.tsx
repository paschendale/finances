import { useMemo, useState } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import type { Account, DashboardEntry } from '@/lib/api';
import { createConversation } from '@/lib/advisor-api';
import { advisorReasons, type AdvisorReason } from '@/lib/advisor-reasons';
import { useAdvisorHealth } from './useAdvisorHealth';
import type { AdvisorTarget } from './AdvisorPage';
import { cn } from '@/lib/utils';

/** Dashboard call to action: shown only when the advisor is reachable and there is something for it to do. */
export function AdvisorCta({
  accounts,
  entries,
  range,
  onOpenAdvisor,
}: {
  accounts: Account[];
  entries: DashboardEntry[];
  range: { start: string; end: string };
  onOpenAdvisor?: (target: AdvisorTarget) => void;
}) {
  const { data: health } = useAdvisorHealth();
  const [busy, setBusy] = useState<string | null>(null);
  const reasons = useMemo(() => advisorReasons(accounts, entries, range), [accounts, entries, range]);
  if (!health || !onOpenAdvisor || reasons.length === 0) return null;

  const open = async (r: AdvisorReason) => {
    if (busy) return;
    setBusy(r.key);
    try {
      const conv = await createConversation({ title: r.title, message: r.message, context: r.context });
      onOpenAdvisor({ conversationId: conv.id });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-3xl border border-primary/20 bg-primary/[0.06] p-4 sm:p-5" aria-label="Advisor suggestions">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="w-4 h-4 text-primary" />
        <h3 className="text-[13px] font-semibold tracking-tight">O advisor pode ajudar agora</h3>
        {!health.ok && <span className="text-[11px] text-amber-300/80 ml-auto">advisor com problemas</span>}
      </div>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {reasons.map((r) => (
          <li key={r.key}>
            <button
              onClick={() => void open(r)}
              disabled={busy !== null}
              className={cn(
                'w-full text-left flex items-center gap-3 px-3.5 py-2.5 rounded-2xl border border-white/[0.08] bg-black/20 hover:bg-white/[0.06] transition-all active:scale-[0.99] disabled:opacity-60',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold truncate">{r.label}</div>
                <div className="text-[11px] text-muted-foreground/70 truncate">{r.detail}</div>
              </div>
              <ArrowRight className={cn('w-3.5 h-3.5 shrink-0 text-primary/80', busy === r.key && 'animate-pulse')} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
