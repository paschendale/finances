import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QuickEntryInput } from '@/components/QuickEntryInput';
import { LedgerTable } from '@/components/LedgerTable';

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="dark min-h-screen bg-background text-foreground flex flex-col items-center pt-20 px-4">
        <header className="mb-12 text-center">
          <h1 className="text-4xl font-extrabold tracking-tight lg:text-5xl mb-2">
            Finance<span className="text-primary">Ledger</span>
          </h1>
          <p className="text-muted-foreground">
            Keyboard-first transaction entry. Simple. Fast.
          </p>
        </header>

        <main className="w-full max-w-4xl">
          <QuickEntryInput />
          <LedgerTable />
        </main>
      </div>
    </QueryClientProvider>
  );
}

export default App;
