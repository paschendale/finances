import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchAccounts } from '@/lib/api';
import { MultiSearchableSelect } from './MultiSearchableSelect';
import { Calendar, Filter, X } from 'lucide-react';

export interface LedgerFilters {
  startDate: string;
  endDate: string;
  accountIds: string[];
}

interface LedgerFilterBarProps {
  filters: LedgerFilters;
  onChange: (filters: LedgerFilters) => void;
}

export function LedgerFilterBar({ filters, onChange }: LedgerFilterBarProps) {
  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  });

  const accountOptions = useMemo(() =>
    accounts.map(a => ({ label: a.account_name, value: a.account_id, icon: a.icon, color: a.color })),
  [accounts]);

  const handleAccountChange = (ids: string[]) => {
    onChange({ ...filters, accountIds: ids });
  };

  const handleDateChange = (field: 'startDate' | 'endDate', value: string) => {
    onChange({ ...filters, [field]: value });
  };

  const clearFilters = () => {
    onChange({
        startDate: '',
        endDate: '',
        accountIds: []
    });
  };

  const hasActiveFilters = filters.startDate || filters.endDate || filters.accountIds.length > 0;

  return (
    <div className="w-full flex flex-col md:flex-row items-center gap-3 bg-white/[0.02] backdrop-blur-xl p-2 rounded-2xl border border-white/10 shadow-xl relative z-30">
      <div className="flex items-center gap-2 px-2 py-1 text-white/30 shrink-0">
         <Filter className="w-3.5 h-3.5" />
         <span className="text-[9px] uppercase tracking-widest font-bold">Filters</span>
      </div>

      <div className="flex-1 w-full flex flex-col md:flex-row gap-2">
        <div className="flex-1 min-w-[240px]">
            <MultiSearchableSelect 
                options={accountOptions}
                values={filters.accountIds}
                onChange={handleAccountChange}
                placeholder="Filter accounts..."
                className="[&>button]:py-1.5 [&>button]:rounded-xl"
            />
        </div>

        <div className="flex items-center gap-2 bg-white/[0.03] border border-white/10 rounded-xl px-2.5 py-1 backdrop-blur-md">
            <Calendar className="w-3 h-3 text-white/30" />
            <input 
                type="date"
                value={filters.startDate}
                onChange={(e) => handleDateChange('startDate', e.target.value)}
                className="bg-transparent border-none p-0 focus:ring-0 text-[11px] text-white/70 w-24 uppercase font-mono"
            />
            <span className="text-white/10 px-0.5 text-[10px]">→</span>
            <input 
                type="date"
                value={filters.endDate}
                onChange={(e) => handleDateChange('endDate', e.target.value)}
                className="bg-transparent border-none p-0 focus:ring-0 text-[11px] text-white/70 w-24 uppercase font-mono"
            />
        </div>
      </div>

      {hasActiveFilters && (
        <button 
            onClick={clearFilters}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider text-white/30 hover:text-white hover:bg-white/5 transition-all"
        >
            <X className="w-3 h-3" /> Reset
        </button>
      )}
    </div>
  );
}
