import { useCallback, useState, type DragEvent, type ReactNode } from 'react';
import { Upload } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Wraps a pane: drag-and-drop anywhere over it uploads the dropped files. */
export function UploadDrop({ onFiles, disabled, children, className }: { onFiles: (files: File[]) => void; disabled?: boolean; children: ReactNode; className?: string }) {
  const [over, setOver] = useState(false);
  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) onFiles(files);
  }, [onFiles, disabled]);
  return (
    <div
      className={cn('relative', className)}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={onDrop}
    >
      {children}
      {over && (
        <div className="absolute inset-0 z-20 rounded-2xl border-2 border-dashed border-white/30 bg-black/60 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground/90"><Upload className="w-4 h-4" /> Solte aqui o extrato ou comprovante</div>
        </div>
      )}
    </div>
  );
}
