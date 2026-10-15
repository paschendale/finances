import { useMemo, useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { ChevronRight, Plus, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { channelLabel, type ConversationListRow } from '@/lib/advisor-api';

function relative(iso: string): string {
  try {
    return formatDistanceToNowStrict(new Date(iso), { addSuffix: false })
      .replace(' seconds', ' s').replace(' second', ' s')
      .replace(' minutes', ' min').replace(' minute', ' min')
      .replace(' hours', ' h').replace(' hour', ' h')
      .replace(' days', ' d').replace(' day', ' d')
      .replace(' months', ' m').replace(' month', ' m')
      .replace(' years', ' a').replace(' year', ' a');
  } catch {
    return '';
  }
}

export function ChannelBadge({ row, className }: { row: Pick<ConversationListRow, 'channel' | 'created_by'>; className?: string }) {
  const label = channelLabel(row);
  return (
    <span className={cn(
      'px-1.5 py-[1px] rounded-md text-[9px] font-bold uppercase tracking-wider border',
      label === 'Gmail' ? 'bg-rose-500/10 border-rose-500/20 text-rose-300/80'
      : label === 'Discord' ? 'bg-indigo-500/10 border-indigo-500/20 text-indigo-300/80'
      : 'bg-white/[0.04] border-white/[0.08] text-muted-foreground/70',
      className,
    )}>{label}</span>
  );
}

function Row({ row, active, waiting, onClick }: { row: ConversationListRow; active: boolean; waiting: boolean; onClick: () => void }) {
  const preview = row.last_message?.replace(/\s+/g, ' ').slice(0, 70) ?? (row.statement_count ? `${row.statement_count} extrato${row.statement_count === 1 ? '' : 's'}` : 'Sem mensagens ainda');
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-3 py-2.5 rounded-xl transition-all active:scale-[0.99] border',
        active ? 'bg-white/[0.07] border-white/[0.1]' : 'border-transparent hover:bg-white/[0.04]',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', row.pending_plans > 0 ? 'bg-amber-400' : 'bg-transparent')} aria-label={row.pending_plans > 0 ? 'Plano esperando sua aprovação' : undefined} />
        <span className="text-[13px] font-semibold truncate flex-1 text-foreground/90">{row.title}</span>
        <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0">{relative(row.last_activity_at)}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-1 pl-3.5 min-w-0">
        <ChannelBadge row={row} />
        {waiting ? (
          <span className="flex items-center gap-1 text-[11px] text-amber-300/80 truncate"><Clock className="w-3 h-3" /> esperando uma folga para processar</span>
        ) : (
          <span className="text-[11px] text-muted-foreground/60 truncate">{preview}</span>
        )}
      </div>
    </button>
  );
}

function Section({ title, items, activeId, isWaiting, onSelect }: { title: string; items: ConversationListRow[]; activeId: string | null; isWaiting: (r: ConversationListRow) => boolean; onSelect: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="mb-2">
      {title && <div className="px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/40">{title}</div>}
      <div className="space-y-0.5">
        {items.map((r) => <Row key={r.id} row={r} active={r.id === activeId} waiting={isWaiting(r)} onClick={() => onSelect(r.id)} />)}
      </div>
    </div>
  );
}

export function ConversationList({
  rows,
  activeId,
  gateClosed,
  onSelect,
  onNew,
}: {
  rows: ConversationListRow[];
  activeId: string | null;
  gateClosed: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const groups = useMemo(() => {
    const needs = rows.filter((r) => r.status === 'active' && r.pending_plans > 0);
    const recent = rows.filter((r) => r.status === 'active' && r.pending_plans === 0);
    const archived = rows.filter((r) => r.status === 'archived');
    return { needs, recent, archived };
  }, [rows]);
  const isWaiting = (r: ConversationListRow) => gateClosed && channelLabel(r) === 'Gmail' && r.last_message_role !== 'assistant';

  return (
    <div className="flex flex-col h-full">
      <div className="p-2">
        <button
          onClick={onNew}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-[13px] font-semibold transition-all active:scale-[0.99]"
        >
          <Plus className="w-3.5 h-3.5" /> Nova conversa
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-1 pb-4 scroll-smooth">
        <Section title="Precisa de você" items={groups.needs} activeId={activeId} isWaiting={isWaiting} onSelect={onSelect} />
        <Section title="Recentes" items={groups.recent} activeId={activeId} isWaiting={isWaiting} onSelect={onSelect} />
        {groups.archived.length > 0 && (
          <>
            <button onClick={() => setShowArchived((v) => !v)} className="w-full flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold text-muted-foreground/50 hover:text-muted-foreground/80 transition-colors">
              <ChevronRight className={cn('w-3 h-3 transition-transform', showArchived && 'rotate-90')} /> Arquivadas · {groups.archived.length}
            </button>
            {showArchived && <Section title="" items={groups.archived} activeId={activeId} isWaiting={isWaiting} onSelect={onSelect} />}
          </>
        )}
      </div>
    </div>
  );
}
