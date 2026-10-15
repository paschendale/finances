import { useRef, useState, type KeyboardEvent } from 'react';
import { Sparkles, FileUp, Scale, PiggyBank, AlertTriangle, FileSearch, Paperclip, ArrowUp, X } from 'lucide-react';
import type { AdvisorHealth } from '@/lib/advisor-api';

const STARTER_PROMPTS = [
  { label: 'Importar extrato', icon: FileUp, message: 'Quero importar um extrato. Vou anexar o arquivo a seguir.' },
  { label: 'Conferir saldo', icon: Scale, message: 'Quero conferir os saldos das contas. Quais estão sem conferência há mais tempo?' },
  { label: 'Planejar orçamento', icon: PiggyBank, message: 'Quero planejar o orçamento do próximo período com base no que gastei até agora.' },
];

const CHECK_FILE_MESSAGE = 'Confira este arquivo com o que está registrado e me diga o que falta ou está na categoria errada.';

/**
 * No conversation open: three quick starts, plus a composer for anything else. Text alone opens a
 * conversation with that message; with files attached (any kind: a list of compras, a comprovante, a
 * planilha) the files go up together with the text and the assistant reads them.
 */
/** Files staged next to a composer, each removable. */
export function AttachmentChips({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-2">
      {files.map((f, i) => (
        <span key={`${f.name}-${f.size}-${i}`} className="flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md border border-white/[0.1] bg-white/[0.04] text-[11px] text-muted-foreground max-w-[220px]">
          <span className="truncate">{f.name}</span>
          <button onClick={() => onRemove(i)} className="w-4 h-4 rounded hover:bg-white/[0.1] flex items-center justify-center" aria-label={`Remover ${f.name}`}><X className="w-3 h-3" /></button>
        </span>
      ))}
    </div>
  );
}

export function EmptyState({
  onStart,
  onUpload,
  busy,
  files,
  onAttach,
  onRemoveAttachment,
}: {
  onStart: (message: string) => void;
  onUpload: (files: File[], message?: string) => void;
  busy?: boolean;
  /** Files staged for the first message (dropped on the pane or picked with the clip); sent with the text */
  files: File[];
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (index: number) => void;
}) {
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const canSend = !busy && (text.trim().length > 0 || files.length > 0);

  const submit = () => {
    if (!canSend) return;
    const message = text.trim();
    if (files.length > 0) onUpload(files, message || undefined);
    else onStart(message);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };
  const pickFile = (prefill?: string) => {
    if (prefill && !text.trim()) setText(prefill);
    fileRef.current?.click();
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-10 gap-6 overflow-y-auto">
        <div className="w-12 h-12 rounded-2xl bg-white/[0.05] border border-white/[0.1] flex items-center justify-center">
          <Sparkles className="w-5 h-5 text-foreground/80" />
        </div>
        <div className="max-w-md">
          <h2 className="text-[17px] font-semibold tracking-tight">Converse sobre o seu dinheiro</h2>
          <p className="text-[13px] text-muted-foreground mt-2 leading-relaxed">
            Mande um extrato, um comprovante, uma lista de compras ou só uma pergunta. O assistente lê, propõe o que registrar e só grava depois que você aprovar.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {STARTER_PROMPTS.map((p) => (
            <button key={p.label} onClick={() => onStart(p.message)} disabled={busy} className="flex items-center gap-2 px-3.5 py-2 rounded-xl border border-white/[0.1] bg-white/[0.03] hover:bg-white/[0.07] disabled:opacity-50 text-[13px] font-medium transition-all active:scale-[0.99]">
              <p.icon className="w-3.5 h-3.5 opacity-70" /> {p.label}
            </button>
          ))}
          <button onClick={() => pickFile(CHECK_FILE_MESSAGE)} disabled={busy} className="flex items-center gap-2 px-3.5 py-2 rounded-xl border border-white/[0.1] bg-white/[0.03] hover:bg-white/[0.07] disabled:opacity-50 text-[13px] font-medium transition-all active:scale-[0.99]">
            <FileSearch className="w-3.5 h-3.5 opacity-70" /> Conferir um arquivo
          </button>
        </div>
      </div>

      {/* Composer */}
      <div className="shrink-0 px-3 sm:px-5 pb-4 pt-2 border-t border-white/[0.06] bg-[#050505]/95 backdrop-blur-md">
       <div className="max-w-[920px] mx-auto">
        <AttachmentChips files={files} onRemove={onRemoveAttachment} />
        <div className="flex items-end gap-1.5 px-1.5 py-1.5 rounded-2xl border border-white/[0.12] bg-white/[0.03] focus-within:border-white/[0.25] transition-colors">
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) onAttach(fs); e.target.value = ''; }} />
          <button onClick={() => pickFile()} disabled={busy} className="w-10 h-10 rounded-xl text-muted-foreground/70 hover:text-foreground hover:bg-white/[0.06] flex items-center justify-center shrink-0 transition-colors" aria-label="Anexar arquivo"><Paperclip className="w-4 h-4" /></button>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            disabled={busy}
            placeholder={files.length > 0 ? 'Diga o que fazer com o arquivo… (Enter envia)' : 'Pergunte, ou anexe um arquivo e diga o que fazer com ele…'}
            className="flex-1 min-h-[40px] max-h-40 resize-none bg-transparent outline-none text-[14px] leading-[22px] py-2 placeholder:text-muted-foreground/40"
            style={{ height: Math.min(160, 24 + 22 * Math.max(1, text.split('\n').length)) }}
          />
          <button onClick={submit} disabled={!canSend} className="w-10 h-10 rounded-xl bg-white/[0.1] hover:bg-white/[0.18] disabled:opacity-30 flex items-center justify-center shrink-0 transition-colors" aria-label="Enviar"><ArrowUp className="w-4 h-4" /></button>
        </div>
       </div>
      </div>
    </div>
  );
}

export function OfflineBanner({ health }: { health: AdvisorHealth | null | undefined }) {
  if (health === undefined) return null;
  if (health === null) {
    return (
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3.5 py-2.5 text-[12px] text-amber-200/90 flex items-start gap-2">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>O assistente está fora do ar no momento. Você pode continuar usando o resto do app normalmente. <span className="opacity-60">(técnico: confira <code className="font-mono">VITE_APP_ADVISOR_URL</code> e se o serviço do assistente está rodando)</span></span>
      </div>
    );
  }
  if (health.claude.loggedIn) return null;
  return (
    <div className="rounded-xl border border-rose-500/20 bg-rose-500/[0.06] px-3.5 py-2.5 text-[12px] text-rose-200/90 space-y-1.5">
      <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="w-3.5 h-3.5" /> O assistente perdeu o acesso ao Claude</div>
      <p className="text-rose-200/70">Nada foi alterado nos seus registros. Extratos que chegarem ficam guardados e são tratados quando o acesso voltar. Para religar, rode no servidor do assistente:</p>
      <pre className="font-mono text-[11px] px-2.5 py-1.5 rounded-lg bg-black/40 border border-white/[0.06]">docker compose exec -it advisor claude login{'\n'}# depois abra o link que aparecer em qualquer aparelho</pre>
    </div>
  );
}
