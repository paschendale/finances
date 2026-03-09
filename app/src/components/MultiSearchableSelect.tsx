import { useState, useEffect, useRef, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { ChevronDown, Search, Check } from 'lucide-react';

export interface Option {
  label: string;
  value: string;
}

export function MultiSearchableSelect({ 
  options, 
  values, 
  onChange, 
  placeholder, 
  icon: Icon,
  className 
}: { 
  options: Option[]; 
  values: string[]; 
  onChange: (values: string[]) => void; 
  placeholder: string;
  icon?: any;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const formatLabel = (label: string) => {
    const parts = label.split(':');
    if (parts.length <= 1) return label;
    const leaf = parts[parts.length - 1];
    const path = parts.slice(0, -1).join(' > ');
    return (
      <div className="flex flex-col items-start overflow-hidden">
        <span className="text-[10px] text-muted-foreground/40 truncate w-full uppercase tracking-tighter">{path}</span>
        <span className="font-semibold truncate w-full leading-tight">{leaf}</span>
      </div>
    );
  };

  const displayOptions = useMemo(() => {
    if (search.length > 0) {
      const s = search.toLowerCase();
      return options.filter(o => o.label.toLowerCase().includes(s));
    }
    return options;
  }, [options, search]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleOption = (val: string) => {
    if (values.includes(val)) {
      onChange(values.filter(v => v !== val));
    } else {
      onChange([...values, val]);
    }
  };

  const toggleAll = () => {
    if (values.length === options.length) {
      onChange([]);
    } else {
      onChange(options.map(o => o.value));
    }
  };

  return (
    <div ref={containerRef} className={cn("relative", isOpen ? "z-[70]" : "z-auto", className)}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/10 text-[13px] font-medium transition-all backdrop-blur-md",
          "hover:bg-white/[0.08] focus:outline-none",
          isOpen && "ring-1 ring-white/20 bg-white/[0.08]"
        )}
      >
        {Icon && <Icon className="w-3.5 h-3.5 text-white/50 shrink-0" />}
        <span className="flex-1 text-left truncate text-white/80">
          {values.length === 0 ? placeholder : 
           values.length === options.length ? "All Accounts" :
           `${values.length} Selected`}
        </span>
        <ChevronDown className={cn("w-3.5 h-3.5 text-white/30 transition-transform duration-200 shrink-0", isOpen && "rotate-180")} />
      </button>

      {isOpen && (
        <div className="absolute z-[100] top-full mt-2 w-full min-w-[300px] bg-[#0A0A0A] border border-white/10 rounded-2xl shadow-2xl backdrop-blur-3xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
          <div className="p-3 border-b border-white/5 bg-white/[0.02] flex items-center gap-2">
            <Search className="w-4 h-4 text-white/30" />
            <input
              ref={inputRef}
              autoFocus
              className="bg-transparent border-none p-0 focus:ring-0 text-[13px] w-full text-white placeholder:text-white/20"
              placeholder="Search accounts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          
          <div className="p-2 border-b border-white/5 flex gap-2">
             <button 
                onClick={toggleAll}
                className="flex-1 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider bg-white/5 hover:bg-white/10 transition-colors"
             >
                {values.length === options.length ? "Deselect All" : "Select All"}
             </button>
             {values.length > 0 && (
                <button 
                    onClick={() => onChange([])}
                    className="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider text-destructive/60 hover:text-destructive hover:bg-destructive/5 transition-colors"
                >
                    Clear
                </button>
             )}
          </div>

          <div className="max-h-[320px] overflow-y-auto p-1.5 custom-scrollbar">
            {displayOptions.length > 0 ? (
              displayOptions.map((opt) => {
                const isSelected = values.includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-[13px] transition-all mb-0.5 group",
                      isSelected 
                        ? "bg-white/10 text-white" 
                        : "hover:bg-white/[0.05] text-white/50 hover:text-white/80"
                    )}
                    onClick={() => toggleOption(opt.value)}
                  >
                    <div className={cn(
                        "w-4 h-4 rounded border transition-all flex items-center justify-center",
                        isSelected ? "bg-white border-white" : "border-white/20 group-hover:border-white/40"
                    )}>
                        {isSelected && <Check className="w-3 h-3 text-black stroke-[3px]" />}
                    </div>
                    <div className="flex-1 text-left min-w-0">
                        {formatLabel(opt.label)}
                    </div>
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-8 text-center text-[12px] text-white/20">No accounts found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
