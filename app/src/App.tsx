import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QuickEntryInput } from '@/components/QuickEntryInput';
import { LedgerTable } from '@/components/LedgerTable';
import { Dashboard } from '@/components/Dashboard';
import { useState } from 'react';
import { LayoutDashboard, List } from 'lucide-react';
import { cn } from '@/lib/utils';

const queryClient = new QueryClient();

function App() {
  const [view, setView] = useState<'ledger' | 'dashboard'>('dashboard');

  return (
    <QueryClientProvider client={queryClient}>
      <div className="dark min-h-screen bg-[#050505] text-foreground flex flex-col items-center pt-8 pb-20 px-4">
        <header className="mb-12 w-full max-w-[95%] flex items-center justify-between px-2">
          <div className="flex flex-col gap-0.5">
            <h1 className="text-[10px] uppercase tracking-[0.4em] text-white/20 font-medium select-none">
                Paschendale's Finances
            </h1>
            <div className="h-[1px] w-12 bg-gradient-to-r from-white/10 to-transparent" />
          </div>

          <div className="bg-white/5 backdrop-blur-xl p-1 rounded-2xl border border-white/5 flex gap-0.5">
            <button
              onClick={() => setView('dashboard')}
              className={cn(
                "flex items-center gap-2 px-4 py-1.5 rounded-xl text-[11px] font-bold tracking-tight transition-all duration-300",
                view === 'dashboard' 
                  ? "bg-white/10 text-white shadow-lg" 
                  : "text-white/30 hover:text-white"
              )}
            >
              <LayoutDashboard className="w-3.5 h-3.5" />
              Dashboard
            </button>
            <button
              onClick={() => setView('ledger')}
              className={cn(
                "flex items-center gap-2 px-4 py-1.5 rounded-xl text-[11px] font-bold tracking-tight transition-all duration-300",
                view === 'ledger' 
                  ? "bg-white/10 text-white shadow-lg" 
                  : "text-white/30 hover:text-white"
              )}
            >
              <List className="w-3.5 h-3.5" />
              Ledger
            </button>
          </div>
        </header>

        <main className="w-full max-w-[95%]">
          {view === 'ledger' ? (
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
