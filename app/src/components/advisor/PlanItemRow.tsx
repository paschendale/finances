import { useState } from 'react';
import { format } from 'date-fns';
import { X, RotateCcw, Tag, Wallet } from 'lucide-react';
import { cn, formatHierarchicalName } from '@/lib/utils';
import { formatBRL, type PlanEntry, type PlanItem } from '@/lib/advisor-api';
import { accountItemLabel, isAccountItem, primaryLeg } from '@/lib/plan-utils';
import { SearchableSelect, type Option } from '../SearchableSelect';

export interface AccountOption extends Option {
  type: string;
}

const KIND_STYLE: Record<string, string> = {
  create: 'bg-emerald-500/15 text-emerald-300',
  update: 'bg-blue-500/15 text-blue-300',
  delete: 'bg-rose-500/15 text-rose-300',
  adjust: 'bg-amber-500/15 text-amber-300',
  skip: 'bg-white/[0.06] text-muted-foreground',
  budget_upsert: 'bg-violet-500/15 text-violet-300',
  budget_delete: 'bg-rose-500/15 text-rose-300',
  mark_checked: 'bg-white/[0.06] text-muted-foreground',
  account_create: 'bg-cyan-500/15 text-cyan-200',
  account_update: 'bg-cyan-500/15 text-cyan-200',
};

const KIND_LABEL: Record<string, string> = { create: 'novo', update: 'correção', delete: 'excluir', adjust: 'ajuste', skip: 'já registrado', budget_upsert: 'orçamento', budget_delete: 'orçamento', mark_checked: 'conferido', account_create: 'nova conta', account_update: 'conta' };

function fmtDate(d: string | null): string {
  if (!d) return '—';
  try { return format(new Date(`${d}T00:00:00`), 'dd/MM'); } catch { return d; }
}

export function ConfidenceBar({ value }: { value: number | null }) {
  if (value == null) return <span className="text-[11px] text-muted-foreground/40">—</span>;
  const low = value < 0.6;
  return (
    <div className="flex items-center gap-1.5" title={`certeza ${value.toFixed(2)}`}>
      <div className="w-12 h-1 rounded-full bg-white/[0.08] overflow-hidden"><div className={cn('h-full rounded-full', low ? 'bg-amber-400' : 'bg-emerald-400')} style={{ width: `${Math.round(value * 100)}%` }} /></div>
      <span className={cn('text-[11px] font-mono', low ? 'text-amber-300' : 'text-muted-foreground/70')}>{value.toFixed(2).replace(/^0/, '')}</span>
    </div>
  );
}

export function PlanItemRow({
  item,
  accountOptions,
  categoryOptions,
  expanded,
  onToggle,
  onPatch,
  disabled,
  mobile,
}: {
  item: PlanItem;
  accountOptions: AccountOption[];
  categoryOptions: AccountOption[];
  expanded: boolean;
  onToggle: () => void;
  onPatch: (patch: { kind?: PlanItem['kind']; date?: string; description?: string; entries?: PlanEntry[]; status?: 'proposed' | 'edited' | 'removed' }) => void;
  disabled: boolean;
  mobile: boolean;
}) {
  const { asset, category, isTransfer } = primaryLeg(item);
  const removed = item.status === 'removed';
  const edited = item.status === 'edited';
  const amount = asset?.amount_base ?? item.entries[0]?.amount_base ?? 0;
  const positive = amount > 0;
  const [desc, setDesc] = useState(item.description ?? '');
  const [date, setDate] = useState(item.date ?? '');
  const [amt, setAmt] = useState(String(Math.abs(amount)));
  const editable = !disabled && !removed && ['create', 'update', 'adjust'].includes(item.kind);
  const reopens = Boolean(item.payload?.reopens_reconciliation);
  const accountLabel = accountItemLabel(item);
  const label = accountLabel ?? item.description;
  const kindLabel = KIND_LABEL[item.kind] ?? item.kind;

  const setEntryAccount = (accountId: string, which: 'asset' | 'category') => {
    const target = which === 'asset' ? asset : category;
    if (!target) return;
    const opt = (which === 'asset' ? accountOptions : categoryOptions).find((o) => o.value === accountId);
    const entries = item.entries.map((e) => (e === target ? { ...e, account_id: accountId, account_name: opt?.label ?? null, account_type: opt?.type ?? null } : e));
    onPatch({ entries });
  };
  const commitAmount = () => {
    const n = Number(amt.replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0 || item.entries.length !== 2 || !asset) return;
    const sign = asset.amount_base < 0 ? -1 : 1;
    const entries = item.entries.map((e) => {
      const base = e === asset ? sign * n : -sign * n;
      const rate = e.exchange_rate || 1;
      return { ...e, amount_base: Math.round(base * 100) / 100, amount: Math.round((base / rate) * 100) / 100 };
    });
    onPatch({ entries });
  };

  const kindToggle = item.kind === 'skip' && item.entries.length >= 2 ? 'create' : item.kind === 'create' ? 'skip' : null;

  const accountCell = (
    <div className="flex items-center gap-1 min-w-0 flex-wrap">
      {isTransfer || !category ? (
        <>
          {item.entries.map((e, i) => (
            <span key={i} className="flex items-center gap-1 min-w-0">
              {i > 0 && <span className="text-muted-foreground/40">→</span>}
              <span className="px-1.5 py-0.5 rounded-md bg-white/[0.05] border border-white/[0.06] text-[11px] font-mono truncate max-w-[160px]">{formatHierarchicalName(e.account_name ?? e.account_id.slice(0, 8))}</span>
            </span>
          ))}
        </>
      ) : (
        <>
          <span className="px-1.5 py-0.5 rounded-md bg-white/[0.05] border border-white/[0.06] text-[11px] font-mono truncate max-w-[150px]">{formatHierarchicalName(asset?.account_name ?? '?')}</span>
          <span className="text-muted-foreground/40">{positive ? '←' : '→'}</span>
          <span className={cn('px-1.5 py-0.5 rounded-md text-[11px] font-mono truncate max-w-[180px] border', edited ? 'bg-amber-500/10 border-amber-500/20 text-amber-200' : 'bg-primary/10 border-transparent text-primary/90')}>{formatHierarchicalName(category.account_name ?? '?')}</span>
        </>
      )}
    </div>
  );

  return (
    <div className={cn('border-b border-white/[0.05] transition-colors', expanded ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]', removed && 'opacity-45')}>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter') onToggle(); }}
        className={cn('w-full text-left px-3 py-2 cursor-pointer', mobile ? 'flex flex-col gap-1.5' : 'grid grid-cols-[52px_1.3fr_1.6fr_96px_84px_72px_28px] gap-3 items-center')}
      >
        {mobile ? (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-muted-foreground/60 w-12 shrink-0">{fmtDate(item.date)}</span>
              <span className={cn('text-[13px] font-medium truncate flex-1', removed && 'line-through')}>{label ?? kindLabel}</span>
              {!isAccountItem(item.kind) && <span className={cn('font-mono text-[13px] tabular-nums shrink-0', positive ? 'text-emerald-400' : 'text-rose-300')}>{positive ? '+' : '−'}{formatBRL(Math.abs(amount)).replace('R$', '').trim()}</span>}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {accountCell}
              <span className="flex-1" />
              <ConfidenceBar value={item.confidence} />
              <span className={cn('px-1.5 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider', KIND_STYLE[removed ? 'skip' : item.kind])}>{removed ? 'fora do plano' : kindLabel}</span>
            </div>
          </>
        ) : (
          <>
            <span className="text-[11px] font-mono text-muted-foreground/60">{fmtDate(item.date)}</span>
            <span className={cn('text-[13px] font-medium truncate', removed && 'line-through')}>{label ?? <span className="text-muted-foreground/50">{kindLabel}</span>}{edited && <span className="ml-1.5 text-[10px] text-amber-300/80">· editado</span>}{reopens && <span className="ml-1.5 text-[10px] text-rose-300/80">· reabre a conferência</span>}</span>
            {isAccountItem(item.kind) ? <span /> : accountCell}
            {isAccountItem(item.kind) ? <span /> : <span className={cn('font-mono text-[13px] tabular-nums text-right', positive ? 'text-emerald-400' : 'text-rose-300')}>{positive ? '+' : '−'}{formatBRL(Math.abs(amount)).replace('R$', '').trim()}</span>}
            <ConfidenceBar value={item.confidence} />
            <span className={cn('px-1.5 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider text-center', KIND_STYLE[removed ? 'skip' : item.kind], item.status === 'failed' && 'bg-rose-500/20 text-rose-300', item.status === 'applied' && 'bg-emerald-500/20 text-emerald-300')}>{removed ? 'fora do plano' : item.status === 'applied' ? 'gravado' : item.status === 'failed' ? 'erro' : kindLabel}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onPatch({ status: removed ? 'proposed' : 'removed' }); }}
              disabled={disabled}
              className="w-7 h-7 rounded-lg text-muted-foreground/50 hover:text-foreground hover:bg-white/[0.08] flex items-center justify-center disabled:opacity-30"
              aria-label={removed ? 'Devolver ao plano' : 'Tirar do plano'}
            >{removed ? <RotateCcw className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}</button>
          </>
        )}
      </div>

      {/* overflow is only clipped while collapsed: the account dropdowns inside must be able to spill out */}
      <div className={cn('transition-all duration-300 ease-in-out', expanded ? 'max-h-[900px] opacity-100 overflow-visible' : 'max-h-0 opacity-0 overflow-hidden')}>
        <div className="mx-3 mb-3 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-xl border border-white/[0.06] bg-black/30 p-3 space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">De onde sai, para onde vai</div>
            {editable && (
              <div className="flex gap-2">
                <input value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== (item.description ?? '') && onPatch({ description: desc })} className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1 text-[13px] font-semibold outline-none focus:border-white/20" placeholder="Descrição" />
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} onBlur={() => date && date !== item.date && onPatch({ date })} className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1 text-[12px] font-mono outline-none" />
              </div>
            )}
            {item.entries.map((e, i) => {
              const isCat = e.account_type === 'expense' || e.account_type === 'income';
              const canPick = editable && ((isCat && e === category) || (!isCat && e === asset));
              return (
                <div key={i} className="flex items-center justify-between gap-2 text-[13px]">
                  <div className="flex-1 min-w-0">
                    {canPick ? (
                      <SearchableSelect options={isCat ? categoryOptions : accountOptions} value={e.account_id} onChange={(v) => setEntryAccount(v, isCat ? 'category' : 'asset')} placeholder="Conta…" icon={isCat ? Tag : Wallet} className="bg-transparent border-none" />
                    ) : (
                      <span className="font-mono text-[12px] text-foreground/80">{formatHierarchicalName(e.account_name ?? e.account_id)}</span>
                    )}
                  </div>
                  {editable && e === asset && item.entries.length === 2 ? (
                    <input value={amt} onChange={(ev) => setAmt(ev.target.value)} onBlur={commitAmount} onKeyDown={(ev) => { if (ev.key === 'Enter') ev.currentTarget.blur(); }} className="w-28 text-right bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1 font-mono text-[12px] outline-none" />
                  ) : (
                    <span className={cn('font-mono text-[12px] tabular-nums', e.amount_base < 0 ? 'text-rose-300' : 'text-emerald-400')}>{e.amount_base < 0 ? '−' : '+'}{formatBRL(Math.abs(e.amount_base)).replace('R$', '').trim()}{e.currency !== 'BRL' && <span className="text-muted-foreground/50"> ({e.amount} {e.currency})</span>}</span>
                  )}
                </div>
              );
            })}
            {item.rationale && <p className="text-[12px] text-muted-foreground/70 leading-relaxed pt-1">Por quê: {item.rationale}</p>}
            {item.error && <p className="text-[12px] text-rose-300">Erro: {item.error}</p>}
            {kindToggle && !removed && !disabled && (
              <button onClick={() => onPatch({ kind: kindToggle })} className="text-[11px] font-semibold text-primary/80 hover:underline">{kindToggle === 'create' ? 'Registrar mesmo assim' : 'Não registrar esta linha'}</button>
            )}
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-black/30 p-3 space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Linha do extrato</div>
            {item.source_line ? (
              <>
                <pre className="font-mono text-[11px] text-foreground/80 whitespace-pre-wrap leading-relaxed">{item.source_line.date}  {item.source_line.amount < 0 ? '−' : '+'}{Math.abs(item.source_line.amount).toFixed(2)}  {item.source_line.raw}{'\n'}{item.source_line.balance_after != null ? `saldo depois ${item.source_line.balance_after.toFixed(2)}` : ''}{item.source_line.already_in_ledger ? ' · já registrado' : item.source_line.likely_duplicate ? ' · parece repetido' : ''}</pre>
                {item.source_line.alias && <p className="text-[11px] text-muted-foreground/70">Você costuma chamar de <span className="font-semibold text-foreground/80">{item.source_line.alias.canonical_description}</span></p>}
                {item.source_line.candidates && item.source_line.candidates.length > 0 && (
                  <div className="text-[11px] text-muted-foreground/70">
                    <span className="font-semibold text-foreground/70">Parecido com: </span>
                    {item.source_line.candidates.slice(0, 3).map((c) => `${c.category_name} (${c.confidence.toFixed(2)})`).join(' · ')}
                  </div>
                )}
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground/50 break-all">{item.kind === 'budget_upsert' || isAccountItem(item.kind) ? JSON.stringify(item.payload) : 'Sem linha de extrato (veio da conversa).'}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
