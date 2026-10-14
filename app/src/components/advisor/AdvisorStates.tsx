import { Sparkles, FileUp, Scale, PiggyBank, AlertTriangle } from 'lucide-react';
import type { AdvisorHealth } from '@/lib/advisor-api';

const STARTER_PROMPTS = [
  { label: 'Importar extrato', icon: FileUp, message: 'Quero importar um extrato. Vou anexar o arquivo a seguir.' },
  { label: 'Conferir saldo', icon: Scale, message: 'Quero conferir os saldos das contas. Quais estão sem conferência há mais tempo?' },
  { label: 'Planejar orçamento', icon: PiggyBank, message: 'Quero planejar o orçamento do próximo período com base no que gastei até agora.' },
];

export function EmptyState({ onStart }: { onStart: (message: string) => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6 py-16 gap-6">
      <div className="w-12 h-12 rounded-2xl bg-white/[0.05] border border-white/[0.1] flex items-center justify-center">
        <Sparkles className="w-5 h-5 text-foreground/80" />
      </div>
      <div className="max-w-md">
        <h2 className="text-[17px] font-semibold tracking-tight">Your ledger, with someone to talk to</h2>
        <p className="text-[13px] text-muted-foreground mt-2 leading-relaxed">
          Send a statement, a receipt or a balance. The advisor reads, proposes a plan, and only writes to the ledger after you approve it.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {STARTER_PROMPTS.map((p) => (
          <button key={p.label} onClick={() => onStart(p.message)} className="flex items-center gap-2 px-3.5 py-2 rounded-xl border border-white/[0.1] bg-white/[0.03] hover:bg-white/[0.07] text-[13px] font-medium transition-all active:scale-[0.99]">
            <p.icon className="w-3.5 h-3.5 opacity-70" /> {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function OfflineBanner({ health }: { health: AdvisorHealth | null | undefined }) {
  if (health === undefined) return null;
  if (health === null) {
    return (
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3.5 py-2.5 text-[12px] text-amber-200/90 flex items-start gap-2">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>The advisor service is unreachable. Check <code className="font-mono">VITE_APP_ADVISOR_URL</code> and that the advisor container is running.</span>
      </div>
    );
  }
  if (health.claude.loggedIn) return null;
  return (
    <div className="rounded-xl border border-rose-500/20 bg-rose-500/[0.06] px-3.5 py-2.5 text-[12px] text-rose-200/90 space-y-1.5">
      <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="w-3.5 h-3.5" /> The advisor cannot reach Claude</div>
      <p className="text-rose-200/70">Claude Code is not logged in on the advisor host. Your ledger is untouched; statements that arrive are kept and processed after re-login.</p>
      <pre className="font-mono text-[11px] px-2.5 py-1.5 rounded-lg bg-black/40 border border-white/[0.06]">docker compose exec -it advisor claude login{'\n'}# then open the printed URL on any device</pre>
    </div>
  );
}
