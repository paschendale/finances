import React, { useState } from 'react';
import { Wallet, ArrowRight, Lock, Loader2 } from 'lucide-react';
import { loginWithToken } from '@/lib/api';
import { cn } from '@/lib/utils';

interface LoginPageProps {
  onLogin: () => void;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [token, setToken] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;

    setIsLoading(true);
    setError(null);

    try {
      await loginWithToken(token.trim());
      onLogin();
    } catch (err: any) {
      setError(err.message || 'Invalid access token');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="dark min-h-screen bg-[#050505] text-foreground flex flex-col items-center justify-center px-4 overflow-hidden relative">
      {/* Background Glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-primary/10 rounded-full blur-[120px] pointer-events-none opacity-30" />
      
      <div className="w-full max-w-sm relative z-10">
        <div className="flex flex-col items-center mb-10">
          <div className="w-16 h-16 bg-white/[0.03] border border-white/[0.08] rounded-[1.25rem] flex items-center justify-center mb-6 backdrop-blur-xl shadow-2xl">
            <Wallet className="h-8 w-8 text-primary/90" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight mb-2">Welcome Back</h1>
          <p className="text-muted-foreground/60 text-[14px] text-center max-w-[240px]">
            Enter your access token to view your personal ledger.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative group">
            <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
              <Lock className="h-4 w-4 text-muted-foreground/40 group-focus-within:text-primary/60 transition-colors" />
            </div>
            <input
              type="password"
              placeholder="Access Token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={isLoading}
              className={cn(
                "w-full bg-white/[0.03] border border-white/[0.08] rounded-2xl py-4 pl-11 pr-4 text-[15px] outline-none transition-all placeholder:text-muted-foreground/30",
                "focus:bg-white/[0.05] focus:border-primary/30 focus:ring-4 focus:ring-primary/5",
                error && "border-destructive/40 bg-destructive/[0.02] focus:border-destructive/50 focus:ring-destructive/5"
              )}
              autoFocus
            />
          </div>

          {error && (
            <p className="text-destructive/80 text-[12px] font-medium text-center animate-in fade-in slide-in-from-top-1">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={isLoading || !token.trim()}
            className={cn(
              "w-full bg-foreground text-background font-semibold py-4 rounded-2xl flex items-center justify-center gap-2 transition-all active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100",
              !isLoading && "hover:bg-foreground/90 shadow-lg shadow-foreground/5"
            )}
          >
            {isLoading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <>
                Continue
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>
        </form>

        <p className="mt-12 text-center text-[12px] text-muted-foreground/30 font-medium tracking-wide uppercase">
          Private Financial Ledger
        </p>
      </div>
    </div>
  );
}
