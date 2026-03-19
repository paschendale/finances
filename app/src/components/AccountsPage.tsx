import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useMemo } from 'react';
import {
  fetchAccountsTree, fetchAliases, updateAccount, deleteAccount, createAccount,
  createAlias, deleteAlias,
  type AccountNode,
} from '@/lib/api';
import { AccountIcon } from './AccountIcon';
import { INSTITUTION_ICONS, CATEGORY_ICONS } from '@/lib/account-icons';
import { cn } from '@/lib/utils';
import { X, Check, Plus, Trash2, Loader2, Eye, EyeOff, ArrowUp, ArrowDown, Clock } from 'lucide-react';
import { SearchableSelect } from './SearchableSelect';

const TYPE_TABS = ['all', 'asset', 'liability', 'expense', 'income', 'equity'] as const;
type AccountType = typeof TYPE_TABS[number];

const TYPE_LABELS: Record<AccountType, string> = {
  all: 'All',
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

// ── Account Modal (create + edit) ─────────────────────────────────────────────

function AccountModal({
  account,
  allAccounts,
  onClose,
}: { account: AccountNode | null; allAccounts: AccountNode[]; onClose: () => void }) {
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<AccountType>((account?.type as AccountType) ?? 'expense');
  const [parentId, setParentId] = useState<string | null>(account?.parent_id ?? null);
  const [icon, setIcon] = useState<string | null>(account?.icon ?? null);
  const [color, setColor] = useState<string | null>(account?.color ?? null);
  const [hidden, setHidden] = useState<boolean>(account?.hidden ?? false);
  const queryClient = useQueryClient();

  const parentOptions = useMemo(() => {
    const opts = allAccounts
      .filter(a => a.type === type && a.id !== account?.id)
      .map(a => ({ label: a.full_name, value: a.id }));
    return [{ label: '— No parent', value: '' }, ...opts];
  }, [allAccounts, type, account?.id]);

  const saveMut = useMutation<void, Error, void>({
    mutationFn: () =>
      account
        ? updateAccount(account.id, { name, type, parent_id: parentId, icon, color, hidden })
        : createAccount({ name, type, parent_id: parentId, icon: icon ?? null, color: color ?? null, hidden }).then(() => undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accountsTree'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onClose();
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteAccount(account!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accountsTree'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onClose();
    },
  });

  const displayName = name
    ? name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : 'New Account';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-md" />
      <div
        className="relative z-10 w-full max-w-[420px] bg-[#111] border border-white/[0.08] rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-5 pt-5 pb-4 flex items-center gap-3 border-b border-white/[0.06]">
          <AccountIcon accountName={account?.full_name ?? name} icon={icon} color={color} size="lg" />
          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-bold text-foreground truncate">{displayName}</p>
            {account && (
              <p className="text-[11px] text-muted-foreground/50 font-mono truncate">{account.full_name}</p>
            )}
            {!account && (
              <p className="text-[11px] text-muted-foreground/50 font-mono truncate">New Account</p>
            )}
          </div>
          <button onClick={onClose} className="text-muted-foreground/40 hover:text-foreground transition-colors shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="px-5 py-4 space-y-5">
          {/* Name */}
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">Name</p>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="leaf name, e.g. grocery"
              className="w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[13px] font-mono focus:outline-none focus:ring-1 focus:ring-primary/30 placeholder:text-muted-foreground/30"
            />
          </div>

          {/* Type */}
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">Type</p>
            <div className="flex rounded-xl border border-white/[0.08] bg-white/[0.02] p-0.5 w-fit">
              {TYPE_TABS.map((t) => (
                <button
                  key={t}
                  onClick={() => { setType(t); setParentId(null); }}
                  className={cn(
                    "px-3 py-1 rounded-lg text-[12px] font-medium transition-colors",
                    type === t
                      ? "bg-white/10 text-foreground shadow-sm"
                      : "text-muted-foreground/50 hover:text-foreground/70"
                  )}
                >
                  {TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {/* Parent */}
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/60">Parent</p>
            <SearchableSelect
              options={parentOptions}
              value={parentId ?? ''}
              onChange={(v) => setParentId(v === '' ? null : v)}
              placeholder="No parent"
            />
          </div>

          <IconPicker accountType={type} current={icon} onChange={setIcon} />
          <ColorPicker current={color} onChange={setColor} />
          {account && <AliasManager account={account} />}
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3 bg-white/[0.02] border-t border-white/[0.06] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setHidden(h => !h)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-all",
                hidden
                  ? "text-muted-foreground/70 hover:bg-white/[0.05]"
                  : "text-muted-foreground/30 hover:bg-white/[0.05] hover:text-muted-foreground/60"
              )}
              title={hidden ? "Hidden — click to show" : "Visible — click to hide"}
            >
              {hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              {hidden ? 'Hidden' : 'Visible'}
            </button>
            {account && (
              <button
                onClick={() => window.confirm(`Delete "${account.full_name}"?`) && deleteMut.mutate()}
                disabled={deleteMut.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-destructive/50 hover:bg-destructive/10 hover:text-destructive/80 transition-all"
              >
                {deleteMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Delete
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-muted-foreground hover:bg-white/[0.05] transition-all"
            >
              Cancel
            </button>
            <button
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending || !name.trim()}
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

  // Sign convention for display:
  // Expenses and Assets are typically positive in the UI.
  // Income and Liabilities are flipped to be positive if they follow their normal sign.
  // In our ledger: 
  // - Assets: + (positive is money)
  // - Liabilities: - (negative is debt)
  // - Expenses: + (positive is spend)
  // - Income: - (negative is earn)
  const displayBalance = (account.type === 'income' || account.type === 'liability') 
    ? -account.balance 
    : account.balance;

  const balanceColor = displayBalance > 0
    ? (account.type === 'expense' || account.type === 'liability' ? 'text-rose-500/90' : 'text-emerald-500/90')
    : displayBalance < 0
      ? (account.type === 'expense' || account.type === 'liability' ? 'text-emerald-500/90' : 'text-rose-500/90')
      : 'text-muted-foreground/30';

  const lastEntryDate = account.last_entry_date 
    ? new Date(account.last_entry_date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
    : 'Never';

  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex flex-col justify-between gap-3 p-3.5 rounded-2xl bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] hover:border-white/[0.12] transition-all text-left active:scale-[0.98] min-h-[110px]",
        account.hidden && "opacity-50"
      )}
    >
      <div>
        {/* Top row: icon + name */}
        <div className="flex items-start gap-2.5">
          <AccountIcon accountName={account.full_name} icon={account.icon} color={account.color} size="md" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="text-[13px] font-semibold text-foreground/90 truncate leading-tight">{leafName}</p>
              {account.hidden && <EyeOff className="w-3 h-3 text-muted-foreground/30 shrink-0" />}
            </div>
            {parentPath && (
              <p className="text-[10px] text-muted-foreground/40 font-mono truncate mt-0.5">{parentPath}</p>
            )}
          </div>
        </div>

        {/* Aliases */}
        {aliases.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {aliases.slice(0, 2).map(a => (
              <span key={a.alias} className="px-1.5 py-0.5 rounded-md bg-white/[0.04] border border-white/[0.06] text-[10px] font-mono text-muted-foreground/50 truncate max-w-[80px]">
                {a.alias}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-end justify-between mt-auto">
        <div className="flex flex-col">
          <p className={cn("text-[14px] font-bold tracking-tight", balanceColor)}>
            {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(displayBalance)}
          </p>
          <p className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground/30">
            {lastEntryDate}
          </p>
        </div>
        {account.future_balance !== 0 && (
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20" title="Has future-dated entries (installments)">
            <Clock className="w-2.5 h-2.5 text-amber-500/70 shrink-0" />
            <span className="text-[9px] font-bold text-amber-500/70 tabular-nums">
              {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
                (account.type === 'income' || account.type === 'liability') ? -account.future_balance : account.future_balance
              )}
            </span>
          </div>
        )}
      </div>
    </button>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

type SortField = 'name' | 'balance' | 'last_entry';
type SortDir = 'asc' | 'desc';

export function AccountsPage() {
  const [activeTab, setActiveTab] = useState<AccountType>('asset');
  const [editingAccount, setEditingAccount] = useState<AccountNode | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const { data: allAccounts = [], isLoading } = useQuery({
    queryKey: ['accountsTree'],
    queryFn: fetchAccountsTree,
  });

  const filtered = useMemo(() =>
    allAccounts.filter(a =>
      (activeTab === 'all' || a.type === activeTab) &&
      (showHidden || !a.hidden) &&
      (!search || a.full_name.toLowerCase().includes(search.toLowerCase()))
    ),
  [allAccounts, activeTab, search, showHidden]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortField === 'name') return dir * a.full_name.localeCompare(b.full_name);
      if (sortField === 'balance') {
        const da = (a.type === 'income' || a.type === 'liability') ? -a.balance : a.balance;
        const db = (b.type === 'income' || b.type === 'liability') ? -b.balance : b.balance;
        return dir * (da - db);
      }
      // last_entry: null (never used) always sorts to the end
      const da = a.last_entry_date ? new Date(a.last_entry_date).getTime() : (sortDir === 'asc' ? Infinity : -Infinity);
      const db = b.last_entry_date ? new Date(b.last_entry_date).getTime() : (sortDir === 'asc' ? Infinity : -Infinity);
      return dir * (da - db);
    });
  }, [filtered, sortField, sortDir]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const a of allAccounts) {
      if (!a.hidden) {
        c[a.type] = (c[a.type] || 0) + 1;
        c.all++;
      }
    }
    return c;
  }, [allAccounts]);

  return (
    <div className="w-full space-y-5 pb-20">
      {/* Header */}
      <div className="flex items-center gap-3 justify-between flex-wrap">
        <div>
          <h2 className="text-[20px] font-bold tracking-tight">Accounts</h2>
          <p className="text-[12px] text-muted-foreground/50 mt-0.5">{allAccounts.length} accounts</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground/50 cursor-pointer hover:text-muted-foreground/70 transition-colors">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
              className="w-3.5 h-3.5 rounded accent-white/50"
            />
            Show hidden
          </label>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="w-44 bg-white/[0.03] border border-white/[0.08] rounded-xl px-3 py-1.5 text-[13px] focus:outline-none focus:ring-1 focus:ring-white/20 placeholder:text-muted-foreground/30"
          />
          <button
            onClick={() => setIsCreating(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-[13px] font-semibold transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            New
          </button>
        </div>
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

      {/* Sort controls */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/30 mr-1">Sort</span>
        {([['name', 'Name'], ['balance', 'Balance'], ['last_entry', 'Last entry']] as [SortField, string][]).map(([field, label]) => {
          const active = sortField === field;
          const Icon = sortDir === 'asc' ? ArrowUp : ArrowDown;
          return (
            <button
              key={field}
              onClick={() => {
                if (active) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
                else { setSortField(field); setSortDir('asc'); }
              }}
              className={cn(
                "flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all border",
                active
                  ? "bg-white/[0.08] border-white/[0.15] text-foreground/80"
                  : "border-transparent text-muted-foreground/40 hover:text-muted-foreground/70 hover:bg-white/[0.04]"
              )}
            >
              {label}
              {active && <Icon className="w-2.5 h-2.5" />}
            </button>
          );
        })}
      </div>

      {/* Cards grid */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 animate-pulse">
          {[...Array(12)].map((_, i) => <div key={i} className="h-[76px] bg-white/[0.03] rounded-2xl" />)}
        </div>
      ) : sorted.length === 0 ? (
        <div className="py-16 text-center text-muted-foreground/30 text-[13px]">No accounts found</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {sorted.map((account) => (
            <AccountCard key={account.id} account={account} onClick={() => setEditingAccount(account)} />
          ))}
        </div>
      )}

      {(editingAccount !== null || isCreating) && (
        <AccountModal
          account={editingAccount}
          allAccounts={allAccounts}
          onClose={() => { setEditingAccount(null); setIsCreating(false); }}
        />
      )}
    </div>
  );
}
