/** Minimal RFC 4180 reader: quoted fields, escaped quotes, CRLF/LF, BOM. Delimiter auto-detected (`,` or `;`). */
export function parseCsv(text: string, delimiter?: string): string[][] {
  let s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  s = s.replace(/\r\n?/g, '\n');
  const delim = delimiter ?? detectDelimiter(s);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function detectDelimiter(s: string): string {
  const firstLine = s.split('\n', 1)[0] ?? '';
  const commas = (firstLine.match(/,/g) ?? []).length;
  const semis = (firstLine.match(/;/g) ?? []).length;
  return semis > commas ? ';' : ',';
}
