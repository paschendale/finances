import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { QuickEntryInput } from '@/components/QuickEntryInput';
import { LedgerTable } from '@/components/LedgerTable';
import { Dashboard } from '@/components/Dashboard';
import { AccountsPage } from '@/components/AccountsPage';
import { BudgetPage } from '@/components/BudgetPage';
import { LedgerFilterBar, type LedgerFilters } from '@/components/LedgerFilterBar';
import { LoginPage } from '@/components/LoginPage';
import { AdvisorPage, type AdvisorTarget } from '@/components/advisor/AdvisorPage';
import { PendingPlansBanner } from '@/components/advisor/PendingPlansBanner';
import { useState, useEffect, useCallback } from 'react';
import { LayoutDashboard, List, Wallet, LogOut, BookMarked, PiggyBank, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format, startOfYear, endOfMonth } from 'date-fns';
import { AUTH_TOKEN_KEY, logout, setOnLogout, fetchAccounts } from '@/lib/api';

const queryClient = new QueryClient();

type View = 'ledger' | 'dashboard' | 'accounts' | 'budget' | 'advisor';

const NAV_ITEMS: { view: View; label: string; icon: typeof LayoutDashboard }[] = [
  { view: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { view: 'ledger', label: 'Ledger', icon: List },
  { view: 'accounts', label: 'Accounts', icon: BookMarked },
  { view: 'budget', label: 'Budget', icon: PiggyBank },
  { view: 'advisor', label: 'Advisor', icon: Sparkles },
];

/** One column for every view: centred, capped at 1280px, with the side padding on the page wrapper. */
const PAGE_WIDTH = 'max-w-7xl';

function AppContent() {
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!localStorage.getItem(AUTH_TOKEN_KEY));

  useEffect(() => {
    setOnLogout(() => setIsAuthenticated(false));
    return () => setOnLogout(() => {});
  }, []);

  const [view, setView] = useState<View>(() => {
    const params = new URLSearchParams(window.location.search);
    return (params.get('view') as View) || 'dashboard';
  });

  const [advisorTarget, setAdvisorTarget] = useState<AdvisorTarget>(() => {
    const params = new URLSearchParams(window.location.search);
    return { conversationId: params.get('conversation'), planId: params.get('plan') };
  });


  const [fromBudget, setFromBudget] = useState(false);

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
    enabled: isAuthenticated,
  });

  const navigateToLedger = useCallback((accountId: string, startDate: string, endDate: string, accountFullName?: string) => {
    let accountIds: string[];
    if (accountFullName) {
      const prefix = accountFullName + ':';
      const matching = accounts.filter(a => a.account_name === accountFullName || a.account_name.startsWith(prefix));
      accountIds = matching.length > 0 ? matching.map(a => a.account_id) : [accountId];
    } else {
      accountIds = [accountId];
    }
    setFilters(f => ({ ...f, accountIds, startDate, endDate }));
    setFromBudget(true);
    setView('ledger');
  }, [accounts]);

  const [filters, setFilters] = useState<LedgerFilters>(() => {
    const params = new URLSearchParams(window.location.search);
    const startDate = params.get('start') || format(startOfYear(new Date()), 'yyyy-MM-dd');
    const endDate = params.get('end') || format(endOfMonth(new Date()), 'yyyy-MM-dd');
    const accountIds = params.get('accounts')?.split(',').filter(Boolean) || [];
    const description = params.get('desc') || '';
    return { startDate, endDate, accountIds, description };
  });

  const openAdvisor = useCallback((target: AdvisorTarget = {}) => {
    setAdvisorTarget({ conversationId: target.conversationId ?? null, planId: target.planId ?? null });
    setFromBudget(false);
    setView('advisor');
  }, []);

  const goTo = useCallback((v: View) => {
    if (v === 'advisor') openAdvisor(advisorTarget);
    else { setView(v); setFromBudget(false); }
  }, [openAdvisor, advisorTarget]);

  const updateURL = useCallback((view: string, filters: LedgerFilters, advisor: AdvisorTarget) => {
    const params = new URLSearchParams();
    params.set('view', view);
    if (view === 'advisor') {
      if (advisor.conversationId) params.set('conversation', advisor.conversationId);
      if (advisor.planId) params.set('plan', advisor.planId);
    }
    if (filters.startDate) params.set('start', filters.startDate);
    if (filters.endDate) params.set('end', filters.endDate);
    if (filters.accountIds.length > 0) params.set('accounts', filters.accountIds.join(','));
    if (filters.description) params.set('desc', filters.description);
    
    const newURL = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newURL);
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      updateURL(view, filters, advisorTarget);
    }
  }, [view, filters, advisorTarget, updateURL, isAuthenticated]);

  if (!isAuthenticated) {
    return <LoginPage onLogin={() => setIsAuthenticated(true)} />;
  }

  return (
    <div className="dark min-h-screen bg-[#050505] text-foreground flex flex-col items-center px-4 sm:px-6 lg:px-8">
      {/* Every view shares one centred column (PAGE_WIDTH), so switching views never changes the width. */}
      <header className={cn("w-full flex flex-row justify-between items-center border-b border-white/[0.06] pb-3 py-3 shrink-0", PAGE_WIDTH, view === 'advisor' ? 'mb-3' : 'mb-6')}>
        <h1 className="logo-glassy text-xl font-semibold tracking-tight antialiased flex items-center gap-2.5">
          <Wallet className="h-6 w-6 opacity-90 shrink-0" />
          <span className="tracking-[-0.03em]">Finances</span>
        </h1>
        
        <div className="flex items-center gap-4">
          {/* Desktop: pill switcher. Phones get the bottom bar below. */}
          <nav className="hidden sm:flex rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5 backdrop-blur-md">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.view}
                onClick={() => goTo(item.view)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-md text-[13px] font-medium tracking-[-0.01em] transition-colors",
                  view === item.view ? "bg-white/10 text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground/80",
                )}
              >
                <item.icon className="w-3.5 h-3.5 opacity-80" />
                {item.label}
              </button>
            ))}
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

      {view !== 'advisor' && <PendingPlansBanner className={PAGE_WIDTH} onOpen={(planId, conversationId) => openAdvisor({ planId, conversationId })} />}

      <main className={cn("w-full flex-1 pb-20 sm:pb-0", PAGE_WIDTH)}>
        {view === "advisor" ? (
          <AdvisorPage
            conversationId={advisorTarget.conversationId ?? null}
            planId={advisorTarget.planId ?? null}
            onNavigate={(t) => setAdvisorTarget({ conversationId: t.conversationId ?? null, planId: t.planId ?? null })}
          />
        ) : view === "ledger" ? (
          <div className="w-full space-y-6 pb-20">
            <QuickEntryInput filters={filters} />
            <div className="w-full space-y-4">
              <LedgerFilterBar filters={filters} onChange={setFilters} />
              <LedgerTable
                filters={filters}
                onBackToBudget={fromBudget ? () => { setView('budget'); setFromBudget(false); } : undefined}
              />
            </div>
          </div>
        ) : view === "accounts" ? (
          <AccountsPage onOpenAdvisor={openAdvisor} />
        ) : view === "budget" ? (
          <BudgetPage onNavigateToLedger={navigateToLedger} onOpenAdvisor={openAdvisor} />
        ) : (
          <Dashboard filters={filters} onFilterChange={setFilters} onNavigateToBudget={() => setView('budget')} onOpenAdvisor={openAdvisor} />
        )}
      </main>

      {/* Phones: bottom tab bar, icons with short labels, clear of the home indicator */}
      <nav className="sm:hidden fixed bottom-0 inset-x-0 z-40 border-t border-white/[0.08] bg-[#050505]/92 backdrop-blur-xl" aria-label="Seções" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="grid grid-cols-5">
          {NAV_ITEMS.map((item) => {
            const active = view === item.view;
            return (
              <button
                key={item.view}
                onClick={() => goTo(item.view)}
                className={cn('flex flex-col items-center justify-center gap-1 h-14 text-[10px] font-medium tracking-[-0.01em] transition-colors', active ? 'text-foreground' : 'text-muted-foreground/70 active:text-foreground')}
                aria-current={active ? 'page' : undefined}
              >
                <span className={cn('flex items-center justify-center w-9 h-6 rounded-full transition-colors', active && 'bg-white/[0.12]')}>
                  <item.icon className="w-[18px] h-[18px]" />
                </span>
                {item.label}
              </button>
            );
          })}
        </div>
      </nav>
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
