export type Span = { kind: 'text' | 'bold' | 'code'; text: string };
export type Block =
  | { type: 'paragraph'; spans: Span[] }
  | { type: 'heading'; level: number; spans: Span[] }
  | { type: 'list'; ordered: boolean; items: Span[][] }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'code'; text: string };

/** Inline **bold** and `code`; everything else is literal text (no HTML). */
export function parseSpans(text: string): Span[] {
  const out: Span[] = [];
  let i = 0;
  let buf = '';
  const flush = () => { if (buf) { out.push({ kind: 'text', text: buf }); buf = ''; } };
  while (i < text.length) {
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end > i + 2) { flush(); out.push({ kind: 'bold', text: text.slice(i + 2, end) }); i = end + 2; continue; }
    }
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) { flush(); out.push({ kind: 'code', text: text.slice(i + 1, end) }); i = end + 1; continue; }
    }
    buf += text[i];
    i++;
  }
  flush();
  return out;
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSeparator = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const splitRow = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.trim().startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', text: buf.join('\n') });
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { blocks.push({ type: 'heading', level: h[1].length, spans: parseSpans(h[2]) }); i++; continue; }
    if (isTableRow(line)) {
      const header = splitRow(line);
      i++;
      if (i < lines.length && isSeparator(lines[i])) i++;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(splitRow(lines[i++]));
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    const li = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items: Span[][] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*•]|\d+[.)])\s+(.*)$/);
        if (!m) break;
        items.push(parseSpans(m[2]));
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isTableRow(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !lines[i].trim().startsWith('```')) buf.push(lines[i++]);
    blocks.push({ type: 'paragraph', spans: parseSpans(buf.join(' ')) });
  }
  return blocks;
}

