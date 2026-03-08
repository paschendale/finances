import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchDashboardData, fetchBalancesAt, fetchNetWorthHistory } from '@/lib/api';
import { 
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, 
  XAxis, YAxis, CartesianGrid, AreaChart, Area
} from 'recharts';
import { 
    format, startOfMonth, endOfMonth, subMonths, startOfYear, 
    endOfYear, subYears, parseISO
} from 'date-fns';
import { Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';

const COLORS = [
  '#3B82F6', // Blue
  '#10B981', // Emerald
  '#F59E0B', // Amber
  '#EF4444', // Red
  '#8B5CF6', // Violet
  '#EC4899', // Pink
  '#06B6D4', // Cyan
  '#F97316', // Orange
];

const NET_WORTH_COLOR = '#3B82F6';

interface DateRange {
  start: Date;
  end: Date;
  label: string;
}

const DATE_PRESETS: DateRange[] = [
  { label: 'This Month', start: startOfMonth(new Date()), end: endOfMonth(new Date()) },
  { label: 'Prev Month', start: startOfMonth(subMonths(new Date(), 1)), end: endOfMonth(subMonths(new Date(), 1)) },
  { label: 'This Year', start: startOfYear(new Date()), end: endOfYear(new Date()) },
  { label: 'Prev Year', start: startOfYear(subYears(new Date(), 1)), end: endOfYear(subYears(new Date(), 1)) },
  { label: 'Custom', start: startOfMonth(new Date()), end: endOfMonth(new Date()) },
];

export function Dashboard() {
  const [dateRange, setDateRange] = useState<DateRange>(DATE_PRESETS[0]);
  const [isCustom, setIsCustom] = useState(false);

  const handlePresetClick = (preset: DateRange) => {
    setDateRange(preset);
    setIsCustom(preset.label === 'Custom');
  };

  const handleCustomDateChange = (type: 'start' | 'end', val: string) => {
    const newDate = new Date(val);
    if (isNaN(newDate.getTime())) return;
    setDateRange(prev => ({
        ...prev,
        [type]: newDate,
        label: 'Custom'
    }));
  };

  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const startDateStr = format(dateRange.start, 'yyyy-MM-dd');
  const endDateStr = format(dateRange.end, 'yyyy-MM-dd');

  const { data: accountsAtDate = [] } = useQuery({
    queryKey: ['balancesAt', endDateStr],
    queryFn: () => fetchBalancesAt(endDateStr),
  });

  const { data: entries = [] } = useQuery({
    queryKey: ['dashboardData', startDateStr, endDateStr],
    queryFn: () => fetchDashboardData(startDateStr, endDateStr),
  });

  const { data: netWorthHistory = [] } = useQuery({
    queryKey: ['netWorthHistory', startDateStr, endDateStr],
    queryFn: () => fetchNetWorthHistory(startDateStr, endDateStr),
  });

  const filteredEntries = useMemo(() => {
    if (!categoryFilter) return entries;
    return entries.filter(e => e.account_name.startsWith(categoryFilter));
  }, [entries, categoryFilter]);

  const stats = useMemo(() => {
    const l1Map: Record<string, number> = {};
    const l2Map: Record<string, number> = {};
    const l3Map: Record<string, number> = {};
    const incomeL1Map: Record<string, number> = {};
    const incomeL2Map: Record<string, number> = {};

    filteredEntries.forEach(entry => {
      const amount = Math.abs(entry.amount_base);
      const parts = entry.account_name.split(':');

      if (entry.account_type === 'expense') {
        const l1 = parts.slice(0, 2).join(':');
        if (parts.length >= 2) l1Map[l1] = (l1Map[l1] || 0) + amount;
        
        const l2 = parts.slice(0, 3).join(':');
        if (parts.length >= 3) l2Map[l2] = (l2Map[l2] || 0) + amount;
        
        const l3 = parts.slice(0, 4).join(':');
        if (parts.length >= 4) l3Map[l3] = (l3Map[l3] || 0) + amount;

      } else if (entry.account_type === 'income') {
        const l1 = parts.slice(0, 2).join(':');
        if (parts.length >= 2) incomeL1Map[l1] = (incomeL1Map[l1] || 0) + amount;

        const l2 = parts.slice(0, 3).join(':');
        if (parts.length >= 3) incomeL2Map[l2] = (incomeL2Map[l2] || 0) + amount;
      }
    });

    const formatPie = (map: Record<string, number>) => 
      Object.entries(map)
        .map(([fullName, value]) => ({ 
          name: fullName.split(':').pop() || fullName, 
          fullName, 
          value 
        }))
        .sort((a, b) => b.value - a.value);

    return { 
        expensesL1: formatPie(l1Map), 
        expensesL2: formatPie(l2Map), 
        expensesL3: formatPie(l3Map), 
        incomeL1: formatPie(incomeL1Map), 
        incomeL2: formatPie(incomeL2Map) 
    };
  }, [filteredEntries]);

  const totalAssets = accountsAtDate
    .filter(a => a.account_type === 'asset')
    .reduce((sum, a) => sum + Number(a.balance), 0);

  const totalLiabilities = accountsAtDate
    .filter(a => a.account_type === 'liability')
    .reduce((sum, a) => sum + Number(a.balance), 0);

  const netWorth = totalAssets + totalLiabilities;

  const lineData = useMemo(() => {
    return netWorthHistory.map(d => ({
        ...d,
        label: format(parseISO(d.date), 'MMM d'),
        net_worth: Number(d.net_worth),
        assets: Number(d.assets),
        liabilities: Math.abs(Number(d.liabilities))
    }));
  }, [netWorthHistory]);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 pb-20">
      {/* Date Filters */}
      <div className="flex flex-col gap-4 bg-black/40 backdrop-blur-2xl p-4 rounded-[2rem] border border-white/5 sticky top-4 z-50 shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex gap-1 p-1 bg-white/5 rounded-full border border-white/5">
            {DATE_PRESETS.map(preset => (
                <button
                key={preset.label}
                onClick={() => handlePresetClick(preset)}
                className={cn(
                    "px-4 py-1.5 rounded-full text-[11px] font-bold tracking-tight transition-all",
                    dateRange.label === preset.label && (preset.label !== 'Custom' || isCustom)
                    ? "bg-white text-black shadow-lg" 
                    : "hover:bg-white/10 text-white/30 hover:text-white"
                )}
                >
                {preset.label}
                </button>
            ))}
            </div>
            <div className="flex items-center gap-3 text-xs font-semibold px-5 py-2 rounded-full bg-white/5 border border-white/10">
            <Calendar className="w-3.5 h-3.5 text-white/20" />
            <span className="text-white/60 tabular-nums">
                {format(dateRange.start, 'MMM d')} — {format(dateRange.end, 'MMM d, yyyy')}
            </span>
            </div>
        </div>

        {isCustom && (
            <div className="flex gap-4 items-center animate-in fade-in slide-in-from-top-2 duration-300 px-2">
                <div className="flex flex-col gap-1">
                    <label className="text-[9px] uppercase tracking-widest text-white/20 font-bold px-1">From</label>
                    <input 
                        type="date" 
                        value={format(dateRange.start, 'yyyy-MM-dd')}
                        onChange={(e) => handleCustomDateChange('start', e.target.value)}
                        className="bg-white/5 border border-white/10 rounded-xl px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-white/20 text-white w-40"
                    />
                </div>
                <div className="flex flex-col gap-1">
                    <label className="text-[9px] uppercase tracking-widest text-white/20 font-bold px-1">To</label>
                    <input 
                        type="date" 
                        value={format(dateRange.end, 'yyyy-MM-dd')}
                        onChange={(e) => handleCustomDateChange('end', e.target.value)}
                        className="bg-white/5 border border-white/10 rounded-xl px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-white/20 text-white w-40"
                    />
                </div>
            </div>
        )}
      </div>

      {/* Hero Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <BalanceCard title="Total Assets" amount={totalAssets} color="text-white" />
        <BalanceCard title="Credit & Debt" amount={totalLiabilities} color="text-red-400/60" />
        <BalanceCard title="Net Worth" amount={netWorth} color="text-emerald-400" />
      </div>

      {/* Distribution Pies (50/50 each) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Expenses Distribution */}
        <ChartCard title="Expense Distribution">
          <div className="flex flex-col gap-8 h-full">
             <div className="h-[350px] w-full relative">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={stats.expensesL1} cx="50%" cy="50%" innerRadius={0} outerRadius="40%" dataKey="value" stroke="rgba(0,0,0,0.5)" strokeWidth={2}>
                      {stats.expensesL1.map((entry, index) => (
                        <Cell key={`l1-${index}`} fill={COLORS[index % COLORS.length]} className="hover:opacity-80 transition-opacity cursor-pointer outline-none" onClick={() => setCategoryFilter(categoryFilter === entry.fullName ? null : entry.fullName)} />
                      ))}
                    </Pie>
                    <Pie data={stats.expensesL2} cx="50%" cy="50%" innerRadius="45%" outerRadius="70%" dataKey="value" stroke="rgba(0,0,0,0.5)" strokeWidth={2}>
                      {stats.expensesL2.map((entry, index) => {
                        const l1Name = entry.fullName.split(':').slice(0, 2).join(':');
                        const l1Index = stats.expensesL1.findIndex(x => x.fullName === l1Name);
                        return <Cell key={`l2-${index}`} fill={COLORS[l1Index % COLORS.length]} opacity={0.7} className="hover:opacity-100 transition-opacity cursor-pointer outline-none" onClick={() => setCategoryFilter(categoryFilter === entry.fullName ? null : entry.fullName)} />
                      })}
                    </Pie>
                    <Pie data={stats.expensesL3} cx="50%" cy="50%" innerRadius="75%" outerRadius="95%" dataKey="value" stroke="rgba(0,0,0,0.5)" strokeWidth={2}>
                      {stats.expensesL3.map((entry, index) => {
                        const l1Name = entry.fullName.split(':').slice(0, 2).join(':');
                        const l1Index = stats.expensesL1.findIndex(x => x.fullName === l1Name);
                        return <Cell key={`l3-${index}`} fill={COLORS[l1Index % COLORS.length]} opacity={0.4} className="hover:opacity-100 transition-opacity cursor-pointer outline-none" />
                      })}
                    </Pie>
                    <Tooltip contentStyle={{ backgroundColor: 'rgba(0,0,0,0.95)', borderRadius: '20px', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(20px)', padding: '12px 16px' }} itemStyle={{ fontSize: '12px', fontWeight: 'bold' }} formatter={(value: any) => `R$ ${Number(value).toLocaleString()}`} />
                  </PieChart>
                </ResponsiveContainer>
             </div>
             
             <div className="grid grid-cols-2 gap-x-6 gap-y-2 max-h-[160px] overflow-y-auto custom-scrollbar px-2 mt-auto">
                {stats.expensesL1.map((entry, index) => (
                  <div key={entry.fullName} className={cn("flex items-center justify-between group cursor-pointer p-2 rounded-xl transition-all", categoryFilter === entry.fullName ? "bg-white/10" : "hover:bg-white/5")} onClick={() => setCategoryFilter(categoryFilter === entry.fullName ? null : entry.fullName)}>
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                      <span className="text-[11px] font-semibold truncate text-white/50 group-hover:text-white transition-colors">{entry.name}</span>
                    </div>
                    <span className="text-[10px] font-mono font-bold text-white/20 group-hover:text-white/40 tabular-nums flex-shrink-0">R$ {entry.value.toLocaleString()}</span>
                  </div>
                ))}
             </div>
          </div>
        </ChartCard>

        {/* Income Sources */}
        <ChartCard title="Income Sources">
          <div className="flex flex-col gap-8 h-full">
            <div className="h-[350px] w-full relative">
                {stats.incomeL1.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={stats.incomeL1} cx="50%" cy="50%" innerRadius={0} outerRadius="50%" dataKey="value" stroke="rgba(0,0,0,0.5)" strokeWidth={2}>
                        {stats.incomeL1.map((entry, index) => (
                            <Cell key={`l1-${index}`} fill={COLORS[index % COLORS.length]} className="hover:opacity-80 transition-opacity cursor-pointer outline-none" onClick={() => setCategoryFilter(categoryFilter === entry.fullName ? null : entry.fullName)} />
                        ))}
                    </Pie>
                    <Pie data={stats.incomeL2} cx="50%" cy="50%" innerRadius="55%" outerRadius="85%" dataKey="value" stroke="rgba(0,0,0,0.5)" strokeWidth={2}>
                        {stats.incomeL2.map((entry, index) => {
                            const l1Name = entry.fullName.split(':').slice(0, 2).join(':');
                            const l1Index = stats.incomeL1.findIndex(x => x.fullName === l1Name);
                            return <Cell key={`l2-${index}`} fill={COLORS[l1Index % COLORS.length]} opacity={0.6} className="hover:opacity-100 transition-opacity cursor-pointer outline-none" onClick={() => setCategoryFilter(categoryFilter === entry.fullName ? null : entry.fullName)} />
                        })}
                    </Pie>
                    <Tooltip contentStyle={{ backgroundColor: 'rgba(0,0,0,0.95)', borderRadius: '20px', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(20px)', padding: '12px 16px' }} itemStyle={{ fontSize: '12px', fontWeight: 'bold' }} formatter={(value: any) => `R$ ${Number(value).toLocaleString()}`} />
                  </PieChart>
                </ResponsiveContainer>
                ) : (
                    <div className="flex items-center justify-center h-full text-white/20 text-xs italic">No income data for this period</div>
                )}
            </div>
            
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 max-h-[160px] overflow-y-auto custom-scrollbar px-2 mt-auto">
                {stats.incomeL1.map((entry, index) => (
                    <div key={entry.fullName} className={cn("flex items-center justify-between group cursor-pointer p-2 rounded-xl transition-all", categoryFilter === entry.fullName ? "bg-white/10" : "hover:bg-white/5")} onClick={() => setCategoryFilter(categoryFilter === entry.fullName ? null : entry.fullName)}>
                        <div className="flex items-center gap-3 min-w-0">
                            <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                            <span className="text-[11px] font-semibold truncate text-white/50 group-hover:text-white transition-colors">{entry.name}</span>
                        </div>
                        <span className="text-[10px] font-mono font-bold text-white/20 group-hover:text-white/40 tabular-nums flex-shrink-0">R$ {entry.value.toLocaleString()}</span>
                    </div>
                ))}
            </div>
          </div>
        </ChartCard>
      </div>

      {/* Assets Timeline */}
      <ChartCard title="Assets Timeline" className="w-full">
        <div className="h-[350px] w-full mt-4">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={lineData} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
              <defs>
                <linearGradient id="colorNetWorth" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={NET_WORTH_COLOR} stopOpacity={0.2}/>
                  <stop offset="95%" stopColor={NET_WORTH_COLOR} stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.02)" />
              <XAxis 
                dataKey="label" 
                axisLine={false} 
                tickLine={false} 
                tick={{ fill: 'rgba(255,255,255,0.2)', fontSize: 10, fontWeight: 600 }} 
                minTickGap={40}
              />
              <YAxis 
                axisLine={false} 
                tickLine={false} 
                tick={{ fill: 'rgba(255,255,255,0.2)', fontSize: 10, fontWeight: 600 }}
                tickFormatter={(val) => `R$ ${(val / 1000).toFixed(0)}k`}
                domain={['auto', 'auto']}
              />
              <Tooltip 
                contentStyle={{ backgroundColor: 'rgba(0,0,0,0.95)', borderRadius: '20px', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(20px)', padding: '12px 16px' }}
                itemStyle={{ fontSize: '12px', fontWeight: 'bold' }}
                labelStyle={{ marginBottom: '8px', color: 'rgba(255,255,255,0.4)', fontSize: '10px' }}
                formatter={(value: any) => `R$ ${Number(value).toLocaleString()}`}
              />
              <Area 
                type="monotone" 
                dataKey="net_worth" 
                name="Net Worth"
                stroke={NET_WORTH_COLOR} 
                strokeWidth={3} 
                fillOpacity={1} 
                fill="url(#colorNetWorth)"
                animationDuration={1000}
              />
              <Area 
                type="monotone" 
                dataKey="assets" 
                name="Total Assets"
                stroke="#10B981" 
                strokeWidth={1} 
                strokeDasharray="4 4"
                fill="none"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      {categoryFilter && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[100] animate-in slide-in-from-bottom-8 duration-500">
            <button 
                onClick={() => setCategoryFilter(null)}
                className="px-6 py-3 bg-white text-black rounded-full text-xs font-bold shadow-2xl hover:scale-105 active:scale-95 transition-all flex items-center gap-3 border border-white/20"
            >
                <div className="w-2 h-2 rounded-full bg-black/20 animate-pulse" />
                Viewing: {categoryFilter.split(':').pop()}
                <span className="opacity-30 font-bold ml-2">✕</span>
            </button>
        </div>
      )}
    </div>
  );
}

function BalanceCard({ title, amount, color }: { title: string, amount: number, color: string }) {
  return (
    <div className="bg-white/[0.02] backdrop-blur-3xl p-8 rounded-[2rem] border border-white/5 hover:border-white/10 transition-all group shadow-sm">
      <h3 className="text-[9px] uppercase tracking-[0.3em] text-white/20 font-bold mb-4">{title}</h3>
      <p className={cn("text-4xl font-bold tracking-tighter tabular-nums", color)}>
        {amount < 0 ? '−' : ''} R$ {Math.abs(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </p>
    </div>
  );
}

function ChartCard({ title, children, className }: { title: string, children: React.ReactNode, className?: string }) {
  return (
    <div className={cn("bg-white/[0.02] backdrop-blur-3xl p-10 rounded-[3rem] border border-white/5 flex flex-col shadow-sm", className)}>
      <h3 className="text-[10px] uppercase tracking-[0.3em] text-white/20 font-bold mb-8">{title}</h3>
      <div className="flex-1">
        {children}
      </div>
    </div>
  );
}
