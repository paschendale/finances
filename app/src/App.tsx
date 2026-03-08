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
      <div className="dark min-h-screen bg-[#050505] text-foreground flex flex-col items-center pt-20 pb-20 px-4">
        <header className="mb-12 text-center relative w-full max-w-4xl">
          <h1 className="text-5xl font-extrabold tracking-tight lg:text-6xl mb-2 bg-gradient-to-b from-white to-white/40 bg-clip-text text-transparent">
            Finance<span className="text-primary">Ledger</span>
          </h1>
          <p className="text-muted-foreground text-lg">
            Simple. Fast. Beautiful.
          </p>

          <div className="mt-8 flex justify-center">
            <div className="bg-white/5 backdrop-blur-xl p-1 rounded-2xl border border-white/10 flex gap-1">
              <button
                onClick={() => setView('dashboard')}
                className={cn(
                  "flex items-center gap-2 px-6 py-2 rounded-xl text-sm font-semibold transition-all duration-300",
                  view === 'dashboard' 
                    ? "bg-white/10 text-white shadow-lg" 
                    : "text-muted-foreground hover:text-white"
                )}
              >
                <LayoutDashboard className="w-4 h-4" />
                Dashboard
              </button>
              <button
                onClick={() => setView('ledger')}
                className={cn(
                  "flex items-center gap-2 px-6 py-2 rounded-xl text-sm font-semibold transition-all duration-300",
                  view === 'ledger' 
                    ? "bg-white/10 text-white shadow-lg" 
                    : "text-muted-foreground hover:text-white"
                )}
              >
                <List className="w-4 h-4" />
                Ledger
              </button>
            </div>
          </div>
        </header>

        <main className="w-full max-w-5xl">
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
