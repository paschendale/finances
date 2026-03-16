import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useMemo } from 'react';
import {
  fetchAccountsTree, fetchAliases, updateAccount, deleteAccount,
  createAlias, deleteAlias,
  type AccountNode,
} from '@/lib/api';
import { AccountIcon } from './AccountIcon';
import { INSTITUTION_ICONS, CATEGORY_ICONS } from '@/lib/account-icons';
import { cn } from '@/lib/utils';
import { X, Check, Plus, Trash2, Loader2 } from 'lucide-react';

const TYPE_TABS = ['asset', 'liability', 'expense', 'income', 'equity'] as const;
type AccountType = typeof TYPE_TABS[number];

const TYPE_LABELS: Record<AccountType, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  expense: 'Expenses',
  income: 'Income',
  equity: 'Equity',
};

// ── Icon Picker ───────────────────────────────────────────────────────────────

function IconPicker({
  accountType,
  current,
  onChange,
}: {
  accountType: string;
  current: string | null;
  onChange: (icon: string | null) => void;
}) {
  const isAssetLiability = accountType === 'asset' || accountType === 'liability';

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">Icon</p>
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => onChange(null)}
          className={cn(
            "w-8 h-8 rounded-lg border text-[10px] font-bold transition-all",
            current === null
              ? "border-primary bg-primary/10 text-primary"
              : "border-border/30 text-muted-foreground hover:border-border/60"
          )}
        >
          —
        </button>
        {isAssetLiability
          ? Object.entries(INSTITUTION_ICONS).map(([key, inst]) => (
              <button
                key={key}
                onClick={() => onChange(key)}
                title={key}
                className={cn(
                  "w-8 h-8 rounded-lg border-2 transition-all overflow-hidden flex items-center justify-center",
                  current === key ? "border-white/70 scale-110" : "border-transparent hover:border-white/20"
                )}
                style={{ backgroundColor: inst.color }}
              >
                <AccountIcon accountName={key} icon={key} size="xs" className="pointer-events-none" />
              </button>
            ))
          : Object.entries(CATEGORY_ICONS).map(([key, Icon]) => (
              <button
                key={key}
                onClick={() => onChange(key)}
                title={key}
                className={cn(
                  "w-8 h-8 rounded-lg border flex items-center justify-center transition-all",
                  current === key
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border/30 text-muted-foreground/50 hover:border-border/60 hover:text-foreground"
                )}
              >
                <Icon className="w-3.5 h-3.5" />
              </button>
            ))}
      </div>
    </div>
  );
}

// ── Color Picker ──────────────────────────────────────────────────────────────

const PRESET_COLORS = [
  '#820AD1', '#EC7000', '#163300', '#FFCC00', '#FF7A00',
  '#11C76F', '#F0B90B', '#000000', '#00C65E', '#004B8D',
  '#00D4AA', '#6366F1', '#EA1D2C', '#6B7280', '#3B82F6',
];

function ColorPicker({ current, onChange }: { current: string | null; onChange: (c: string | null) => void }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">Color</p>
      <div className="flex flex-wrap gap-2 items-center">
        <button
          onClick={() => onChange(null)}
          className={cn(
            "w-6 h-6 rounded border text-[9px] font-bold transition-all",
            current === null ? "border-primary text-primary" : "border-border/30 text-muted-foreground/40"
          )}
        >—</button>
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => onChange(c)}
            className={cn("w-5 h-5 rounded-full border-2 transition-all", current === c ? "border-white scale-110" : "border-transparent hover:scale-105")}
            style={{ backgroundColor: c }}
            title={c}
          />
        ))}
        <input
          type="color"
          value={current || '#6366F1'}
          onChange={(e) => onChange(e.target.value)}
          className="w-6 h-6 rounded cursor-pointer border border-border/30"
          title="Custom"
        />
      </div>
    </div>
  );
}

// ── Alias Manager ─────────────────────────────────────────────────────────────

function AliasManager({ account }: { account: AccountNode }) {
  const [newAlias, setNewAlias] = useState('');
  const queryClient = useQueryClient();

  const { data: aliases = [] } = useQuery({
    queryKey: ['aliases', account.id],
    queryFn: () => fetchAliases(account.id),
  });

  const createMut = useMutation({
    mutationFn: () => createAlias(newAlias.trim(), account.id),
    onSuccess: () => { setNewAlias(''); queryClient.invalidateQueries({ queryKey: ['aliases', account.id] }); },
  });

  const deleteMut = useMutation({
    mutationFn: (alias: string) => deleteAlias(alias),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['aliases', account.id] }),
  });

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">Aliases</p>
      <div className="flex flex-wrap gap-1.5 min-h-[24px]">
        {aliases.length === 0 && (
          <span className="text-[12px] text-muted-foreground/30 italic">No aliases</span>
        )}
        {aliases.map((a) => (
          <span key={a.alias} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] font-mono text-foreground/70">
            {a.alias}
            <button onClick={() => deleteMut.mutate(a.alias)} className="hover:text-destructive transition-colors ml-0.5">
              <X className="w-2.5 h-2.5" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={newAlias}
          onChange={(e) => setNewAlias(e.target.value)}
          placeholder="Add alias…"
          className="flex-1 bg-white/[0.03] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[12px] font-mono focus:outline-none focus:ring-1 focus:ring-primary/30 placeholder:text-muted-foreground/30"
          onKeyDown={(e) => e.key === 'Enter' && newAlias.trim() && createMut.mutate()}
        />
        <button
          onClick={() => newAlias.trim() && createMut.mutate()}
          disabled={!newAlias.trim() || createMut.isPending}
          className="px-2.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-foreground/60 hover:text-foreground transition-all disabled:opacity-30"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Edit Modal ────────────────────────────────────────────────────────────────

function EditModal({ account, onClose }: { account: AccountNode; onClose: () => void }) {
  const [icon, setIcon] = useState<string | null>(account.icon);
  const [color, setColor] = useState<string | null>(account.color);
  const queryClient = useQueryClient();

  const saveMut = useMutation({
    mutationFn: () => updateAccount(account.id, { icon, color }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accountsTree'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onClose();
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteAccount(account.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accountsTree'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-md" />
      <div
        className="relative z-10 w-full max-w-[420px] bg-[#111] border border-white/[0.08] rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-5 pt-5 pb-4 flex items-center gap-3 border-b border-white/[0.06]">
          <AccountIcon accountName={account.full_name} icon={icon} color={color} size="lg" />
          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-bold text-foreground truncate">
              {account.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
            </p>
            <p className="text-[11px] text-muted-foreground/50 font-mono truncate">{account.full_name}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground/40 hover:text-foreground transition-colors shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="px-5 py-4 space-y-5">
          <IconPicker accountType={account.type} current={icon} onChange={setIcon} />
          <ColorPicker current={color} onChange={setColor} />
          <AliasManager account={account} />
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3 bg-white/[0.02] border-t border-white/[0.06] flex items-center justify-between">
          <button
            onClick={() => window.confirm(`Delete "${account.full_name}"?`) && deleteMut.mutate()}
            disabled={deleteMut.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-destructive/50 hover:bg-destructive/10 hover:text-destructive/80 transition-all"
          >
            {deleteMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Delete
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-muted-foreground hover:bg-white/[0.05] transition-all"
            >
              Cancel
            </button>
            <button
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending}
              className="px-4 py-1.5 rounded-lg text-[12px] font-bold bg-white text-black hover:bg-white/90 transition-all flex items-center gap-1.5 disabled:opacity-50"
            >
              {saveMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Account Card ──────────────────────────────────────────────────────────────

function AccountCard({ account, onClick }: { account: AccountNode; onClick: () => void }) {
  const { data: aliases = [] } = useQuery({
    queryKey: ['aliases', account.id],
    queryFn: () => fetchAliases(account.id),
    staleTime: 60_000,
  });

  const leafName = account.name
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const parentPath = account.full_name.split(':').slice(0, -1).join(' › ');

  return (
    <button
      onClick={onClick}
      className="group flex flex-col gap-2.5 p-3.5 rounded-2xl bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] hover:border-white/[0.12] transition-all text-left active:scale-[0.98]"
    >
      {/* Top row: icon + name */}
      <div className="flex items-start gap-2.5">
        <AccountIcon accountName={account.full_name} icon={account.icon} color={account.color} size="md" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-foreground/90 truncate leading-tight">{leafName}</p>
          {parentPath && (
            <p className="text-[10px] text-muted-foreground/40 font-mono truncate mt-0.5">{parentPath}</p>
          )}
        </div>
      </div>

      {/* Aliases */}
      {aliases.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {aliases.slice(0, 3).map(a => (
            <span key={a.alias} className="px-1.5 py-0.5 rounded-md bg-white/[0.04] border border-white/[0.06] text-[10px] font-mono text-muted-foreground/50 truncate max-w-[100px]">
              {a.alias}
            </span>
          ))}
          {aliases.length > 3 && (
            <span className="px-1.5 py-0.5 text-[10px] text-muted-foreground/30">+{aliases.length - 3}</span>
          )}
        </div>
      )}
    </button>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function AccountsPage() {
  const [activeTab, setActiveTab] = useState<AccountType>('asset');
  const [editingAccount, setEditingAccount] = useState<AccountNode | null>(null);
  const [search, setSearch] = useState('');

  const { data: allAccounts = [], isLoading } = useQuery({
    queryKey: ['accountsTree'],
    queryFn: fetchAccountsTree,
  });

  const filtered = useMemo(() =>
    allAccounts.filter(a =>
      a.type === activeTab &&
      (!search || a.full_name.toLowerCase().includes(search.toLowerCase()))
    ),
  [allAccounts, activeTab, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const a of allAccounts) c[a.type] = (c[a.type] || 0) + 1;
    return c;
  }, [allAccounts]);

  return (
    <div className="w-full space-y-5 pb-20">
      {/* Header */}
      <div className="flex items-center gap-3 justify-between">
        <div>
          <h2 className="text-[20px] font-bold tracking-tight">Accounts</h2>
          <p className="text-[12px] text-muted-foreground/50 mt-0.5">{allAccounts.length} accounts</p>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="w-44 bg-white/[0.03] border border-white/[0.08] rounded-xl px-3 py-1.5 text-[13px] focus:outline-none focus:ring-1 focus:ring-white/20 placeholder:text-muted-foreground/30"
        />
      </div>

      {/* Type tabs */}
      <nav className="flex rounded-xl border border-white/[0.08] bg-white/[0.02] p-0.5 w-fit">
        {TYPE_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium tracking-[-0.01em] transition-colors",
              activeTab === tab
                ? "bg-white/10 text-foreground shadow-sm"
                : "text-muted-foreground/50 hover:text-foreground/70"
            )}
          >
            {TYPE_LABELS[tab]}
            <span className="text-[10px] opacity-40 tabular-nums">{counts[tab] || 0}</span>
          </button>
        ))}
      </nav>

      {/* Cards grid */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 animate-pulse">
          {[...Array(12)].map((_, i) => <div key={i} className="h-[76px] bg-white/[0.03] rounded-2xl" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-16 text-center text-muted-foreground/30 text-[13px]">No accounts found</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {filtered.map((account) => (
            <AccountCard key={account.id} account={account} onClick={() => setEditingAccount(account)} />
          ))}
        </div>
      )}

      {editingAccount && (
        <EditModal account={editingAccount} onClose={() => setEditingAccount(null)} />
      )}
    </div>
  );
}
