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
    out.push(isRow ? line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\s*\|\s*/g, '  ') : line);
  }
  if (inTable) out.push('```');
  return out.join('\n');
}

export const APPROVE_WORDS = /^(aprova(r|do)?|approve[d]?|go|ok|pode aplicar|aplica(r)?|manda|yes|sim|✅)\b/i;
export const REJECT_WORDS = /^(rejeita(r|do)?|reject(ed)?|cancela(r)?|n[ãa]o|no|descarta(r)?)\b/i;
