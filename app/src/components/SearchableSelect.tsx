import React, { useState, useEffect, useRef, useMemo } from 'react';
import { cn, formatHierarchicalName } from '@/lib/utils';
import { ChevronDown, Search } from 'lucide-react';
import { AccountIcon } from './AccountIcon';

export interface Option {
  label: string;
  value: string;
  icon?: string | null;
  color?: string | null;
}

export function SearchableSelect({ 
  options, 
  topOptions = [],
  value, 
  onChange, 
  placeholder, 
  icon: Icon,
  className 
}: { 
  options: Option[]; 
  topOptions?: Option[];
  value: string; 
  onChange: (value: string) => void; 
  placeholder: string;
  icon?: any;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const formatLabel = (opt: Option, isSelected: boolean) => {
    return (
      <span className="flex items-center gap-1.5 min-w-0">
        {(opt.icon || opt.color) && (
          <AccountIcon
            accountName={opt.label}
            icon={opt.icon}
            color={opt.color}
            size="xs"
          />
        )}
        <span className={cn(
          "text-[13px] font-bold truncate leading-tight",
          isSelected ? "text-primary-foreground" : "text-foreground/90"
        )}>
          {formatHierarchicalName(opt.label)}
        </span>
      </span>
    );
  };

  const getButtonLabel = (val: string) => {
    const opt = options.find(o => o.value === val);
    if (!opt) return <span className="text-muted-foreground/50">{placeholder}</span>;
    return (
      <span className="flex items-center gap-1.5 min-w-0">
        {(opt.icon || opt.color) && (
          <AccountIcon
            accountName={opt.label}
            icon={opt.icon}
            color={opt.color}
            size="xs"
          />
        )}
        <span className="truncate">{formatHierarchicalName(opt.label)}</span>
      </span>
    );
  };

  const displayOptions = useMemo(() => {
    if (search.length > 0) {
      const s = search.toLowerCase();
      return options.filter(o => o.label.toLowerCase().includes(s));
    }
    return topOptions.length > 0 ? topOptions : options.slice(0, 20);
  }, [options, topOptions, search]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setIsOpen(false);
    if (e.key === 'Enter' && displayOptions.length > 0 && isOpen) {
      e.preventDefault();
      onChange(displayOptions[0].value);
      setIsOpen(false);
      setSearch('');
    }
    if (e.key === 'ArrowDown' && !isOpen) setIsOpen(true);
  };

  return (
    <div ref={containerRef} className={cn("relative", isOpen ? "z-50" : "z-auto", className)}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        className={cn(
          "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-background/50 border border-border/50 text-[13px] font-medium transition-all backdrop-blur-sm",
          "hover:bg-accent/50 focus:outline-none focus:ring-1 focus:ring-primary/30",
          isOpen && "ring-1 ring-primary/30 bg-accent/30"
        )}
      >
        {Icon && <Icon className="w-3.5 h-3.5 text-muted-foreground/70 shrink-0" />}
        <span className="flex-1 text-left truncate flex items-center">
          {getButtonLabel(value)}
        </span>
        <ChevronDown className={cn("w-3 h-3 text-muted-foreground/50 transition-transform duration-200 shrink-0", isOpen && "rotate-180")} />
      </button>

      {isOpen && (
        <div className="absolute z-[100] top-full mt-1.5 w-full min-w-[240px] bg-popover/95 border border-border/50 rounded-xl shadow-[0_10px_40px_-10px_rgba(0,0,0,0.3)] backdrop-blur-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
          <div className="p-2 border-b border-border/40 bg-muted/20 flex items-center gap-2">
            <Search className="w-3.5 h-3.5 text-muted-foreground/50" />
            <input
              ref={inputRef}
              autoFocus
              className="bg-transparent border-none p-0 focus:ring-0 text-[13px] w-full placeholder:text-muted-foreground/40"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div className="max-h-[280px] overflow-y-auto p-1 custom-scrollbar">
            {search.length === 0 && topOptions.length > 0 && (
              <div className="px-2 py-1.5 text-[10px] font-bold text-muted-foreground/40 uppercase tracking-widest">Suggested</div>
            )}
            {displayOptions.length > 0 ? (
              displayOptions.map((opt) => (
                <button
                  key={opt.value}
                  className={cn(
                    "w-full text-left px-2.5 py-1.5 rounded-md text-[13px] transition-all",
                    opt.value === value
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "hover:bg-accent hover:text-accent-foreground"
                  )}
                  onClick={() => {
                    onChange(opt.value);
                    setIsOpen(false);
                    setSearch('');
                  }}
                >
                  {formatLabel(opt, opt.value === value)}
                </button>
              ))
            ) : (
              <div className="px-3 py-6 text-center text-[12px] text-muted-foreground/50">No results found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
