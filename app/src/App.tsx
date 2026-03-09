import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QuickEntryInput } from '@/components/QuickEntryInput';
import { LedgerTable } from '@/components/LedgerTable';
import { Dashboard } from '@/components/Dashboard';
import { LedgerFilterBar, type LedgerFilters } from '@/components/LedgerFilterBar';
import { LoginPage } from '@/components/LoginPage';
import { useState, useEffect, useCallback } from 'react';
import { LayoutDashboard, List, Wallet, LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format, startOfYear, endOfMonth } from 'date-fns';
import { AUTH_TOKEN_KEY, logout, setOnLogout } from '@/lib/api';

const queryClient = new QueryClient();

function AppContent() {
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!localStorage.getItem(AUTH_TOKEN_KEY));

  useEffect(() => {
    setOnLogout(() => setIsAuthenticated(false));
    return () => setOnLogout(() => {});
  }, []);

  const [view, setView] = useState<'ledger' | 'dashboard'>(() => {
    const params = new URLSearchParams(window.location.search);
    return (params.get('view') as 'ledger' | 'dashboard') || 'dashboard';
  });

  const [filters, setFilters] = useState<LedgerFilters>(() => {
    const params = new URLSearchParams(window.location.search);
    const startDate = params.get('start') || format(startOfYear(new Date()), 'yyyy-MM-dd');
    const endDate = params.get('end') || format(endOfMonth(new Date()), 'yyyy-MM-dd');
    const accountIds = params.get('accounts')?.split(',').filter(Boolean) || [];
    return { startDate, endDate, accountIds };
  });

  const updateURL = useCallback((view: string, filters: LedgerFilters) => {
    const params = new URLSearchParams();
    params.set('view', view);
    if (filters.startDate) params.set('start', filters.startDate);
    if (filters.endDate) params.set('end', filters.endDate);
    if (filters.accountIds.length > 0) params.set('accounts', filters.accountIds.join(','));
    
    const newURL = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newURL);
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      updateURL(view, filters);
    }
  }, [view, filters, updateURL, isAuthenticated]);

  if (!isAuthenticated) {
    return <LoginPage onLogin={() => setIsAuthenticated(true)} />;
  }

  return (
    <div className="dark min-h-screen bg-[#050505] text-foreground flex flex-col items-center px-4">
      <header className="w-full max-w-5xl mb-6 flex flex-row justify-between items-center border-b border-white/[0.06] pb-3 py-3 shrink-0">
        <h1 className="logo-glassy text-xl font-semibold tracking-tight antialiased flex items-center gap-2.5">
          <Wallet className="h-6 w-6 opacity-90 shrink-0" />
          <span className="tracking-[-0.03em]">Finances</span>
        </h1>
        
        <div className="flex items-center gap-4">
          <nav className="flex rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5 backdrop-blur-md">
            <button
              onClick={() => setView("dashboard")}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-md text-[13px] font-medium tracking-[-0.01em] transition-colors",
                view === "dashboard"
                  ? "bg-white/10 text-foreground shadow-sm"
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
                  ? "bg-white/10 text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground/80",
              )}
            >
              <List className="w-3.5 h-3.5 opacity-80" />
              Ledger
            </button>
          </nav>

          <button
            onClick={logout}
            className="p-2 rounded-lg border border-white/[0.08] bg-white/[0.02] text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
            title="Logout"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      <main className="w-full max-w-5xl flex-1">
        {view === "ledger" ? (
          <div className="w-full space-y-6 pb-20">
            <QuickEntryInput />
            <div className="w-full space-y-4">
              <LedgerFilterBar filters={filters} onChange={setFilters} />
              <LedgerTable filters={filters} />
            </div>
          </div>
        ) : (
          <Dashboard filters={filters} onFilterChange={setFilters} />
        )}
      </main>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  );
}

export default App;
