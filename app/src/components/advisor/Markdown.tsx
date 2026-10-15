import { cn } from '@/lib/utils';
import { parseMarkdown, type Span } from '@/lib/markdown';

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) =>
        s.kind === 'bold' ? <strong key={i} className="font-semibold text-foreground">{s.text}</strong>
        : s.kind === 'code' ? <code key={i} className="font-mono text-[12px] px-1 py-0.5 rounded bg-white/[0.08]">{s.text}</code>
        : <span key={i}>{s.text}</span>,
      )}
    </>
  );
}

const numeric = /^[-+−]?R?\$?\s?[\d.,]+%?$/;

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className={cn('space-y-2.5 text-[14px] leading-relaxed text-foreground/90', className)}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'heading':
            return <p key={i} className={cn('font-semibold tracking-tight', b.level <= 2 ? 'text-[15px]' : 'text-[12px] uppercase tracking-wider text-muted-foreground')}><Spans spans={b.spans} /></p>;
          case 'list':
            return (
              <ul key={i} className={cn('pl-4 space-y-1', b.ordered ? 'list-decimal' : 'list-disc')}>
                {b.items.map((it, j) => <li key={j}><Spans spans={it} /></li>)}
              </ul>
            );
          case 'table':
            return (
              <div key={i} className="overflow-x-auto rounded-lg border border-white/[0.08]">
                <table className="w-full text-[12px] font-mono">
                  <thead className="bg-white/[0.04]">
                    <tr>{b.header.map((h, j) => <th key={j} className="text-left px-2.5 py-1.5 font-semibold text-muted-foreground">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j} className="border-t border-white/[0.06]">
                        {r.map((c, k) => <td key={k} className={cn('px-2.5 py-1 whitespace-nowrap', numeric.test(c) && 'text-right tabular-nums')}>{c}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'code':
            return <pre key={i} className="font-mono text-[12px] p-3 rounded-lg bg-white/[0.04] border border-white/[0.06] overflow-x-auto whitespace-pre-wrap">{b.text}</pre>;
          default:
            return <p key={i}><Spans spans={b.spans} /></p>;
        }
      })}
    </div>
  );
}
