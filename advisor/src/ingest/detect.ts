import fs from 'node:fs/promises';
import path from 'node:path';
import type { StatementFormat } from '../db/types.js';
import { decodeOfxBuffer, parseOfx } from './ofx.js';
import { parseNubankCsv } from './nubank-csv.js';
import { parsePdfText, pdfToText } from './pdf.js';
import type { ParsedStatement } from './normalize.js';

export function detectFormat(filename: string, buf: Buffer): StatementFormat {
  const head = buf.subarray(0, 512);
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return 'image';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image';
  if (head.subarray(4, 12).toString('latin1').includes('ftyp')) return 'image'; // HEIC/HEIF
  if (head.subarray(0, 3).toString('latin1') === 'GIF') return 'image';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image';
  const ext = path.extname(filename).toLowerCase();
  if (head[0] === 0x50 && head[1] === 0x4b) return ext === '.xlsx' || ext === '.xlsm' ? 'xlsx' : 'other';
  const text = head.toString('latin1');
  if (/OFXHEADER|<OFX>|<\?OFX/i.test(text) || ext === '.ofx' || ext === '.qfx') return 'ofx';
  if (ext === '.csv') return 'csv';
  if (ext === '.pdf') return 'pdf';
  if (/^[\x09\x0a\x0d\x20-\x7e\x80-\xff]*$/.test(text) && /[,;]/.test(text) && /\n/.test(text)) return 'csv';
  return 'other';
}

export interface InstitutionGuess {
  institution: string | null;
  kind: 'account' | 'card' | 'investment' | 'other';
}

export function detectInstitution(input: { filename: string; sender?: string | null; subject?: string | null; text?: string | null }): InstitutionGuess {
  const sender = (input.sender ?? '').toLowerCase();
  const subject = (input.subject ?? '').toLowerCase();
  const filename = input.filename;
  const text = (input.text ?? '').toLowerCase();

  const nubankSender = sender.includes('@nubank.com.br');
  if (nubankSender || /nubank/.test(subject) || /^NU_|^Nubank_/i.test(filename) || /nu pagamentos|nubank/.test(text)) {
    if (subject.includes('extrato da fatura') || /^Nubank_\d{4}-\d{2}-\d{2}/i.test(filename) || /fatura/.test(subject)) return { institution: 'nubank', kind: 'card' };
    if (subject.includes('extrato da sua conta') || /^NU_/i.test(filename)) return { institution: 'nubank', kind: 'account' };
    return { institution: 'nubank', kind: 'account' };
  }
  if (sender.includes('@wise.com') || /\bwise\b/.test(subject) || /\bwise\b/i.test(filename)) return { institution: 'wise', kind: 'account' };
  if (/\bbrb\b/i.test(filename) || sender.includes('@brb.com.br') || /banco de bras[ií]lia/.test(text)) return { institution: 'brb', kind: 'account' };
  if (/ita[uú]/i.test(filename) || sender.includes('@itau') || /ita[uú]\.com\.br|banco ita[uú]/.test(text)) return { institution: 'itau', kind: 'account' };
  return { institution: null, kind: 'other' };
}

export interface ParseFileResult {
  format: StatementFormat;
  parsed: ParsedStatement | null;
  error?: string;
}

/** Detects the format and dispatches to a parser. Images/xlsx/other return parsed=null without error. */
export async function parseStatementFile(filePath: string, filename: string, hints: { sender?: string | null; subject?: string | null } = {}): Promise<ParseFileResult> {
  const buf = await fs.readFile(filePath);
  const format = detectFormat(filename, buf);
  const guess = detectInstitution({ filename, sender: hints.sender, subject: hints.subject });
  try {
    let parsed: ParsedStatement | null = null;
    if (format === 'ofx') parsed = parseOfx(decodeOfxBuffer(buf));
    else if (format === 'csv') parsed = parseNubankCsv(buf.toString('utf8'), filename);
    else if (format === 'pdf') parsed = parsePdfText(await pdfToText(filePath));
    if (parsed) {
      if (!parsed.institution && guess.institution) parsed.institution = guess.institution;
      if (parsed.kind === 'other' && guess.kind !== 'other') parsed.kind = guess.kind;
    }
    return { format, parsed };
  } catch (err) {
    return { format, parsed: null, error: (err as Error).message };
  }
}
