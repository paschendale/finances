import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QuickEntryInput } from '@/components/QuickEntryInput';
import { LedgerTable } from '@/components/LedgerTable';
import { Dashboard } from '@/components/Dashboard';
import { useState } from 'react';
import { LayoutDashboard, List, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';

const queryClient = new QueryClient();

function App() {
  const [view, setView] = useState<'ledger' | 'dashboard'>('dashboard');

  return (
    <QueryClientProvider client={queryClient}>
      <div className="dark min-h-screen bg-[#050505] text-foreground flex flex-col items-center px-2">
        <header className="w-full max-w-4xl mb-14 flex flex-row justify-between items-center border-b border-white/[0.06] pb-4 py-4">
          <h1 className="logo-glassy text-xl font-semibold tracking-tight antialiased flex items-center gap-2.5">
            <Wallet className="h-6 w-6 opacity-90 shrink-0" />
            <span className="tracking-[-0.03em]">Finances</span>
          </h1>
          <nav className="flex rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
            <button
              onClick={() => setView("dashboard")}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-md text-[13px] font-medium tracking-[-0.01em] transition-colors",
                view === "dashboard"
                  ? "bg-white/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground/80",
              )}
            >
              <LayoutDashboard className="w-3.5 h-3.5 opacity-80" />
              Dashboard
            </button>
            <button
              onClick={() => setView("ledger")}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-md text-[13px] font-medium tracking-[-0.01em] transition-colors",
                view === "ledger"
                  ? "bg-white/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground/80",
              )}
            >
              <List className="w-3.5 h-3.5 opacity-80" />
              Ledger
            </button>
          </nav>
        </header>

        <main className="w-full max-w-5xl">
          {view === "ledger" ? (
            <div className="space-y-12">
              <QuickEntryInput />
              <LedgerTable />
            </div>
          ) : (
            <Dashboard />
          )}
        </main>
      </div>
    </QueryClientProvider>
  );
}

export default App;
