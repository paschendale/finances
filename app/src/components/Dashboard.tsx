import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { type Account, fetchAccounts, fetchDashboardData, fetchDailyBalances } from '@/lib/api';
import { 
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, 
  AreaChart, Area, XAxis, YAxis, CartesianGrid 
} from 'recharts';
import { format, startOfMonth, endOfMonth, subMonths, startOfYear, endOfYear, subYears, parseISO, isWithinInterval, differenceInDays, startOfWeek } from 'date-fns';
import { Calendar } from 'lucide-react';
import { cn, formatHierarchicalName } from '@/lib/utils';
import { type LedgerFilters } from './LedgerFilterBar';

// Rich, darker muted colors for dark mode comfort
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

interface DashboardProps {
  filters: LedgerFilters;
  onFilterChange: (filters: LedgerFilters) => void;
}

export function Dashboard({ filters, onFilterChange }: DashboardProps) {
  const [showCustom, setShowCustom] = useState(false);

  // Derived date range from filters
  const dateRange = useMemo<DateRange>(() => {
    const start = parseISO(filters.startDate);
    const end = parseISO(filters.endDate);
    
    // Try to find matching preset
    const preset = DATE_PRESETS.find(p => 
        format(p.start, 'yyyy-MM-dd') === filters.startDate && 
        format(p.end, 'yyyy-MM-dd') === filters.endDate
    );
    
    return {
        start,
        end,
        label: preset?.label || 'Custom'
    };
  }, [filters.startDate, filters.endDate]);

  const handlePresetClick = (preset: DateRange) => {
    onFilterChange({
        ...filters,
        startDate: format(preset.start, 'yyyy-MM-dd'),
        endDate: format(preset.end, 'yyyy-MM-dd')
    });
    setShowCustom(preset.label === 'Custom');
  };

  const handleCustomDateChange = (type: 'start' | 'end', val: string) => {
    onFilterChange({
        ...filters,
        [type === 'start' ? 'startDate' : 'endDate']: val
    });
  };

  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const startDateStr = filters.startDate;
  const endDateStr = filters.endDate;

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  });

  const { data: entries = [] } = useQuery({
    queryKey: ['dashboardData', startDateStr, endDateStr],
    queryFn: () => fetchDashboardData(startDateStr, endDateStr),
  });

  const { data: dailyBalances = [] } = useQuery({
    queryKey: ['dailyBalances'],
    queryFn: fetchDailyBalances,
  });

  // Filter and Aggregate Data
  const filteredEntries = useMemo(() => {
    if (!categoryFilter) return entries;
    return entries.filter(e => e.account_name.startsWith(categoryFilter));
  }, [entries, categoryFilter]);

  const stats = useMemo(() => {
    const l1Map: Record<string, number> = {};
    const l2Map: Record<string, number> = {};
    const l3Map: Record<string, number> = {};
    const incomeMap: Record<string, number> = {};
    const monthlyData: Record<string, { month: string, income: number, expense: number }> = {};

    filteredEntries.forEach(entry => {
      const amount = Math.abs(entry.amount_base);
      const date = parseISO(entry.date);
      const monthKey = format(date, 'MMM yyyy');

      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { month: monthKey, income: 0, expense: 0 };
      }

      if (entry.account_type === 'expense') {
        const parts = entry.account_name.split(':');

        // L1: first segment (always present)
        const l1 = parts[0];
        l1Map[l1] = (l1Map[l1] || 0) + amount;

        // L2: first two segments (if depth >= 2)
        if (parts.length >= 2) {
          const l2 = parts.slice(0, 2).join(':');
          l2Map[l2] = (l2Map[l2] || 0) + amount;
        }

        // L3: first three segments (if depth >= 3)
        if (parts.length >= 3) {
          const l3 = parts.slice(0, 3).join(':');
          l3Map[l3] = (l3Map[l3] || 0) + amount;
        }

        monthlyData[monthKey].expense += amount;
      } else if (entry.account_type === 'income') {
        const parts = entry.account_name.split(':');
        const levelName = parts[0];
        incomeMap[levelName] = (incomeMap[levelName] || 0) + amount;
        monthlyData[monthKey].income += amount;
      }
    });

    const formatPie = (map: Record<string, number>) => 
      Object.entries(map)
        .map(([fullName, value]) => {
          const parts = fullName.split(':');
          const displayName = parts.length > 1 ? parts.slice(1).join(':') : fullName;
          return { 
            name: formatHierarchicalName(displayName), 
            fullName, 
            value 
          };
        })
        .sort((a, b) => b.value - a.value);

    const expensesL1 = formatPie(l1Map);
    const expensesL2 = formatPie(l2Map);
    const expensesL3 = formatPie(l3Map);
    const incomePie = formatPie(incomeMap);

    // Asset History with Dynamic Granularity
    const daysDiff = differenceInDays(dateRange.end, dateRange.start);
    const targetTypes = ['checking', 'emergency', 'investments', 'liabilities'];
    const filteredDaily = dailyBalances
      .filter(db => targetTypes.includes(db.account_type))
      .filter(db => {
        const d = parseISO(db.date);
        return isWithinInterval(d, { start: dateRange.start, end: dateRange.end });
      });

    let assetHistory: any[] = [];

    const aggregateByDate = (data: typeof filteredDaily) => {
      const map: Record<string, any> = {};
      data.forEach(db => {
        if (!map[db.date]) {
          map[db.date] = { date: db.date, label: format(parseISO(db.date), 'MMM d') };
          targetTypes.forEach(t => map[db.date][t] = 0);
        }
        map[db.date][db.account_type] = Number(db.balance);
      });
      return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
    };

    if (daysDiff > 35) {
      // Weekly aggregation (take the last balance of the week)
      const weeklyMap: Record<string, any> = {};
      filteredDaily.forEach(db => {
        const d = parseISO(db.date);
        const weekKey = format(startOfWeek(d), 'yyyy-MM-dd');
        if (!weeklyMap[weekKey]) {
            weeklyMap[weekKey] = { weekKey, date: d, label: format(d, 'MMM d') };
            targetTypes.forEach(t => weeklyMap[weekKey][t] = null);
        }
        // Update if this date is more recent for this type in this week
        if (!weeklyMap[weekKey][`${db.account_type}_date`] || d > weeklyMap[weekKey][`${db.account_type}_date`]) {
            weeklyMap[weekKey][`${db.account_type}_date`] = d;
            weeklyMap[weekKey][db.account_type] = Number(db.balance);
        }
      });
      assetHistory = Object.values(weeklyMap)
        .sort((a, b) => a.weekKey.localeCompare(b.weekKey))
        .map(w => {
            const { weekKey, date, label, ...vals } = w;
            return { label, ...vals };
        });
    } else {
      assetHistory = aggregateByDate(filteredDaily);
    }

    return { expensesL1, expensesL2, expensesL3, incomePie, assetHistory };
  }, [filteredEntries, dailyBalances, dateRange]);
  const accountGroups = useMemo(() => {
    const checking = accounts.filter(a => a.subtype === 'checking');
    const emergency = accounts.filter(a => a.subtype === 'emergency');
    const investments = accounts.filter(a => a.subtype === 'investments');
    const liabilities = accounts.filter(a => a.subtype === 'liabilities');

    const sum = (accs: Account[]) => accs.reduce((s, a) => s + a.own_balance, 0);

    return {
      checking: { label: 'Checking Accounts', accounts: checking.sort((a, b) => b.own_balance - a.own_balance), total: sum(checking) },
      emergency: { label: 'Emergency Funds', accounts: emergency.sort((a, b) => b.own_balance - a.own_balance), total: sum(emergency) },
      investments: { label: 'Investments', accounts: investments.sort((a, b) => b.own_balance - a.own_balance), total: sum(investments) },
      liabilities: { label: 'Liabilities', accounts: liabilities.sort((a, b) => a.own_balance - b.own_balance), total: sum(liabilities) },
    };
  }, [accounts]);

  const netWorth = accountGroups.checking.total + accountGroups.emergency.total + accountGroups.investments.total + accountGroups.liabilities.total;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      {/* Date Filters */}
      <div className="flex flex-col gap-4 bg-white/[0.02] backdrop-blur-3xl p-4 rounded-3xl border border-white/10 sticky top-0 z-50 shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex gap-2">
            {DATE_PRESETS.map(preset => (
                <button
                key={preset.label}
                onClick={() => handlePresetClick(preset)}
                className={cn(
                    "px-4 py-1.5 rounded-full text-sm font-medium transition-all",
                    dateRange.label === preset.label && (!showCustom || preset.label !== 'Custom')
                    ? "bg-white text-black shadow-lg" 
                    : "bg-white/5 hover:bg-white/10 text-muted-foreground"
                )}
                >
                {preset.label}
                </button>
            ))}
            </div>

            <button 
                onClick={() => setShowCustom(!showCustom)}
                className={cn(
                    "flex items-center gap-2 text-sm font-medium px-4 py-1.5 rounded-full transition-all border",
                    showCustom || dateRange.label === 'Custom'
                        ? "bg-white/10 border-white/20 text-white" 
                        : "bg-white/5 border-white/10 text-white/60 hover:text-white"
                )}
            >
                <Calendar className="w-4 h-4" />
                <span>{format(dateRange.start, 'MMM d')} - {format(dateRange.end, 'MMM d, yyyy')}</span>
            </button>
        </div>

        {showCustom && (
            <div className="flex gap-4 items-center animate-in fade-in slide-in-from-top-2 duration-300 bg-white/5 p-3 rounded-2xl border border-white/5">
                <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold px-1">From</label>
                    <input 
                        type="date" 
                        value={filters.startDate}
                        onChange={(e) => handleCustomDateChange('start', e.target.value)}
                        className="bg-white/5 border border-white/10 rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                    />
                </div>
                <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold px-1">To</label>
                    <input 
                        type="date" 
                        value={filters.endDate}
                        onChange={(e) => handleCustomDateChange('end', e.target.value)}
                        className="bg-white/5 border border-white/10 rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                    />
                </div>
            </div>
        )}
      </div>

      {/* Balances Panel */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <BalanceCard title="Checking" amount={accountGroups.checking.total} accounts={accountGroups.checking.accounts} color="text-white" />
        <BalanceCard title="Emergency" amount={accountGroups.emergency.total} accounts={accountGroups.emergency.accounts} color="text-[#3B82F6]" />
        <BalanceCard title="Investments" amount={accountGroups.investments.total} accounts={accountGroups.investments.accounts} color="text-[#10B981]" />
        <BalanceCard title="Liabilities" amount={accountGroups.liabilities.total} accounts={accountGroups.liabilities.accounts} color="text-[#EF4444]" />
      </div>

      <div className="flex justify-center">
        <div className="bg-white/5 px-6 py-2 rounded-full border border-white/10">
           <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mr-3">Net Worth</span>
           <span className="text-xl font-bold tracking-tight">R$ {netWorth.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        </div>
      </div>

      {/* Main Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Expenses Nested Pie - Bigger */}
        <ChartCard title="Expense Breakdown" className="lg:col-span-2 min-h-[500px]">
          <ExpenseBreakdownChart
            expensesL1={stats.expensesL1}
            expensesL2={stats.expensesL2}
            expensesL3={stats.expensesL3}
            categoryFilter={categoryFilter}
            setCategoryFilter={setCategoryFilter}
          />
        </ChartCard>

        {/* Income Pie */}
        <ChartCard title="Income Sources">
          <div className="flex flex-col h-full gap-4">
            <div className="flex-1 min-h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                    <Pie
                    data={stats.incomePie}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={90}
                    paddingAngle={5}
                    dataKey="value"
                    stroke="none"
                    >
                    {stats.incomePie.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                    </Pie>
                    <Tooltip 
                    contentStyle={{ backgroundColor: 'rgba(0,0,0,0.9)', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(20px)' }}
                    formatter={(value: any) => `R$ ${Number(value).toLocaleString()}`}
                    />
                </PieChart>
                </ResponsiveContainer>
            </div>
            <div className="space-y-1">
                {stats.incomePie.slice(0, 5).map((entry, index) => (
                    <div key={entry.fullName} className="flex items-center justify-between text-[10px]">
                        <div className="flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                            <span className="text-muted-foreground">{entry.name}</span>
                        </div>
                        <span className="font-mono">R$ {entry.value.toLocaleString()}</span>
                    </div>
                ))}
            </div>
          </div>
        </ChartCard>

        {/* Monthly Area Chart */}
        <ChartCard title="Asset Breakdown History" className="lg:col-span-3">
          <div className="h-[450px]">
            <ResponsiveContainer width="100%" height="100%" key={`${dateRange.start.getTime()}-${dateRange.end.getTime()}`}>
              <AreaChart data={stats.assetHistory} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                <defs>
                  <linearGradient id="colorInvest" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10B981" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#10B981" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorEmergency" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#3B82F6" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorChecking" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#FFFFFF" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#FFFFFF" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorCredit" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#EF4444" stopOpacity={0.1}/>
                    <stop offset="95%" stopColor="#EF4444" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.03)" />
                <XAxis 
                  dataKey="label" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 11 }} 
                />
                <YAxis 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 11 }}
                  tickFormatter={(val) => `R$ ${val / 1000}k`}
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'rgba(0,0,0,0.9)', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(20px)' }}
                  formatter={(value: any, name: any) => [`R$ ${Number(value).toLocaleString()}`, String(name || '').replace('-', ' ')]}
                />
                {/* Credit Card - Usually negative, shown separately (not stacked with assets) */}
                <Area 
                  type="monotone" 
                  dataKey="credit-card" 
                  stroke="#EF4444" 
                  strokeWidth={2} 
                  fillOpacity={1} 
                  fill="url(#colorCredit)" 
                  strokeDasharray="5 5"
                />
                {/* Stacked Assets */}
                <Area 
                  stackId="1"
                  type="monotone" 
                  dataKey="investments" 
                  stroke="#10B981" 
                  strokeWidth={3} 
                  fillOpacity={1} 
                  fill="url(#colorInvest)" 
                />
                <Area 
                  stackId="1"
                  type="monotone" 
                  dataKey="emergency" 
                  stroke="#3B82F6" 
                  strokeWidth={3} 
                  fillOpacity={1} 
                  fill="url(#colorEmergency)" 
                />
                <Area 
                  stackId="1"
                  type="monotone" 
                  dataKey="checking" 
                  stroke="#FFFFFF" 
                  strokeWidth={3} 
                  fillOpacity={1} 
                  fill="url(#colorChecking)" 
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </div>

      {categoryFilter && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[100] animate-in slide-in-from-bottom-8 duration-500">
            <button 
                onClick={() => setCategoryFilter(null)}
                className="px-6 py-3 bg-white text-black rounded-full text-sm font-bold shadow-2xl hover:scale-105 active:scale-95 transition-all flex items-center gap-2 border border-white/20"
            >
                Viewing: {formatHierarchicalName(categoryFilter)}
                <span className="opacity-40 font-normal">| Clear</span>
            </button>
        </div>
      )}
    </div>
  );
}

interface PieEntry { name: string; fullName: string; value: number; }

function ExpenseBreakdownChart({
  expensesL1, expensesL2, expensesL3, categoryFilter, setCategoryFilter
}: {
  expensesL1: PieEntry[];
  expensesL2: PieEntry[];
  expensesL3: PieEntry[];
  categoryFilter: string | null;
  setCategoryFilter: (v: string | null) => void;
}) {
  const hasL2 = expensesL2.length > 0;
  const hasL3 = expensesL3.length > 0;
  const levels = hasL3 ? 3 : hasL2 ? 2 : 1;

  // Adaptive radii based on how many levels exist
  const radii = {
    1: [{ inner: 0, outer: 100 }],
    2: [{ inner: 0, outer: 60 }, { inner: 70, outer: 110 }],
    3: [{ inner: 0, outer: 60 }, { inner: 70, outer: 110 }, { inner: 120, outer: 150 }],
  }[levels]!;

  const getL1Index = (fullName: string) =>
    expensesL1.findIndex(x => x.fullName === fullName.split(':')[0]);

  return (
    <div className="flex flex-col lg:flex-row h-full gap-8">
      <div className="flex-1 min-h-[400px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={expensesL1}
              cx="50%" cy="50%"
              innerRadius={radii[0].inner} outerRadius={radii[0].outer}
              dataKey="value"
              stroke="rgba(0,0,0,0.5)" strokeWidth={2}
            >
              {expensesL1.map((entry, index) => (
                <Cell
                  key={`l1-${index}`}
                  fill={COLORS[index % COLORS.length]}
                  className="hover:opacity-80 transition-opacity cursor-pointer"
                  onClick={() => setCategoryFilter(categoryFilter === entry.fullName ? null : entry.fullName)}
                />
              ))}
            </Pie>
            {levels >= 2 && (
              <Pie
                data={expensesL2}
                cx="50%" cy="50%"
                innerRadius={radii[1].inner} outerRadius={radii[1].outer}
                dataKey="value"
                stroke="rgba(0,0,0,0.5)" strokeWidth={2}
              >
                {expensesL2.map((entry, index) => {
                  const l1Idx = getL1Index(entry.fullName);
                  return (
                    <Cell
                      key={`l2-${index}`}
                      fill={COLORS[l1Idx >= 0 ? l1Idx % COLORS.length : index % COLORS.length]}
                      opacity={0.7}
                      className="hover:opacity-100 transition-opacity cursor-pointer"
                      onClick={() => setCategoryFilter(categoryFilter === entry.fullName ? null : entry.fullName)}
                    />
                  );
                })}
              </Pie>
            )}
            {levels >= 3 && (
              <Pie
                data={expensesL3}
                cx="50%" cy="50%"
                innerRadius={radii[2].inner} outerRadius={radii[2].outer}
                dataKey="value"
                stroke="rgba(0,0,0,0.5)" strokeWidth={2}
              >
                {expensesL3.map((entry, index) => {
                  const l1Idx = getL1Index(entry.fullName);
                  return (
                    <Cell
                      key={`l3-${index}`}
                      fill={COLORS[l1Idx >= 0 ? l1Idx % COLORS.length : index % COLORS.length]}
                      opacity={0.4}
                      className="hover:opacity-100 transition-opacity cursor-pointer"
                      onClick={() => setCategoryFilter(categoryFilter === entry.fullName ? null : entry.fullName)}
                    />
                  );
                })}
              </Pie>
            )}
            <Tooltip
              contentStyle={{ backgroundColor: 'rgba(0,0,0,0.9)', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(20px)' }}
              formatter={(value: any) => `R$ ${Number(value).toLocaleString()}`}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="w-full lg:w-64 overflow-y-auto max-h-[400px] pr-4 space-y-2 custom-scrollbar">
        <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mb-4">Top Categories</h4>
        {expensesL1.map((entry, index) => (
          <div
            key={entry.fullName}
            className={cn(
              "flex items-center justify-between group cursor-pointer p-2 rounded-xl transition-all",
              categoryFilter === entry.fullName ? "bg-white/10" : "hover:bg-white/5"
            )}
            onClick={() => setCategoryFilter(categoryFilter === entry.fullName ? null : entry.fullName)}
          >
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
              <span className="text-xs font-medium truncate w-24 text-white/80">{entry.name}</span>
            </div>
            <span className="text-[10px] font-mono text-muted-foreground group-hover:text-white transition-colors">
              R$ {entry.value.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BalanceCard({ title, amount, color, accounts = [] }: { title: string, amount: number, color: string, accounts?: Account[] }) {
  return (
    <div className="relative group">
      <div className="bg-white/[0.03] backdrop-blur-3xl p-6 rounded-[2rem] border border-white/5 group-hover:border-white/20 transition-all shadow-sm">
        <h3 className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-bold mb-3">{title}</h3>
        <p className={cn("text-2xl font-bold tracking-tighter truncate", color)}>
          {amount < 0 ? '-' : ''} R$ {Math.abs(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </p>
      </div>
      
      {/* Hover Detail Card */}
      {accounts.length > 0 && (
        <div className="absolute top-full left-0 w-full mt-2 p-4 bg-black/90 backdrop-blur-2xl border border-white/10 rounded-2xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-[60] shadow-2xl scale-95 group-hover:scale-100 origin-top">
          <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
            {accounts.map(acc => (
              <div key={acc.account_id} className="flex justify-between items-center text-[10px]">
                <span className="text-white/60 truncate mr-2">{formatHierarchicalName(acc.account_name)}</span>
                <span className="font-mono font-bold text-white">R$ {acc.own_balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ChartCard({ title, children, className }: { title: string, children: React.ReactNode, className?: string }) {
  return (
    <div className={cn("bg-white/[0.03] backdrop-blur-3xl p-10 rounded-[3rem] border border-white/5 flex flex-col shadow-sm", className)}>
      <h3 className="text-xs uppercase tracking-[0.2em] text-muted-foreground font-bold mb-8">{title}</h3>
      {children}
    </div>
  );
}
