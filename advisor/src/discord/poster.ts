/**
 * Text helpers for Discord, written for a phone screen: short messages, one idea per line, a blank
 * line between lines, tables turned into code blocks, and one "tracker" message per topic that is
 * edited in place as the topic moves along (details live in the topic's thread).
 */

/** Splits text into Discord-sized chunks (2000 chars) on paragraph/line boundaries. */
export function chunkMessage(text: string, limit = 1990): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Markdown tables do not render on Discord; wrap them in code blocks so columns line up. */
export function discordify(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let inTable = false;
  for (const line of lines) {
    const isRow = /^\s*\|.*\|\s*$/.test(line);
    if (isRow && !inTable) {
      out.push('```');
      inTable = true;
    }
    if (!isRow && inTable) {
      out.push('```');
      inTable = false;
    }
    if (isRow && /^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // separator row
    out.push(isRow ? line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\s*\|\s*/g, '  ') : line);
  }
  if (inTable) out.push('```');
  return out.join('\n');
}

/**
 * Mobile layout: every line becomes its own paragraph (a blank line between lines), headings become
 * bold, runs of blank lines collapse to one. Code blocks are kept as they are.
 */
export function mobileify(text: string): string {
  const out: string[] = [];
  let inCode = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.trimStart().startsWith('```')) {
      inCode = !inCode;
      out.push(line);
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    if (!line.trim()) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    out.push(heading ? `**${heading[1]!.replace(/\*\*/g, '')}**` : line);
  }
  // blank line between consecutive non-code lines
  const spaced: string[] = [];
  inCode = false;
  for (const line of out) {
    const fence = line.trimStart().startsWith('```');
    if (spaced.length > 0 && !inCode) spaced.push('');
    spaced.push(line);
    if (fence) inCode = !inCode;
  }
  return spaced.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Formats an assistant reply for a Discord thread. */
export function formatReply(markdown: string): string {
  return mobileify(discordify(markdown));
}

/** First sentence or line of a reply, trimmed to `max` characters, for the tracker message. */
export function headline(text: string, max = 110): string {
  const firstLine = text
    .split('\n')
    .map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '').trim())
    .find((l) => l.length > 0 && !l.startsWith('|') && !l.startsWith('```'));
  if (!firstLine) return '';
  const sentence = /^(.*?[.!?])(\s|$)/.exec(firstLine)?.[1] ?? firstLine;
  const s = sentence.length <= max ? sentence : `${sentence.slice(0, max - 1).trimEnd()}…`;
  return s;
}

export interface TrackerState {
  title: string;
  /** One line with a leading emoji: "✅ Aplicado", "🟡 Plano aguardando aprovação" */
  status: string;
  /** At most two or three short lines of detail */
  lines?: string[];
  /** Deep link to the web app, when configured */
  link?: string | null;
  /** Shown as the last line when there is a thread */
  hint?: string | null;
}

/** The channel message that tracks a topic; edited in place as the topic moves along. */
export function trackerText(s: TrackerState): string {
  const parts = [`**${s.title.trim()}**`, s.status.trim()];
  for (const l of s.lines ?? []) if (l && l.trim()) parts.push(l.trim());
  if (s.hint) parts.push(s.hint.trim());
  if (s.link) parts.push(`<${s.link}>`);
  return parts.join('\n\n').slice(0, 1900);
}

export const fmtBRL = (n: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}` : iso;
}

export const APPROVE_WORDS = /^(aprova(r|do)?|approve[d]?|go|ok|pode aplicar|aplica(r)?|manda|yes|sim|✅)\b/i;
export const REJECT_WORDS = /^(rejeita(r|do)?|reject(ed)?|cancela(r)?|n[ãa]o|no|descarta(r)?)\b/i;
