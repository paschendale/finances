import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { X } from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { fetchCategoryMonthlyHistory } from '@/lib/api';
import { AccountIcon } from './AccountIcon';

interface CategoryInsightsModalProps {
  accountId: string;
  accountName: string;
  accountFullName: string;
  icon: string | null;
  color: string | null;
  onClose: () => void;
}

function movingAverage(values: number[], window: number): (number | null)[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

function computeMode(values: number[]): number {
  if (values.length === 0) return 0;
  const bucketSize = values.some((v) => v > 500) ? 100 : 50;
  const buckets = new Map<number, number>();
  for (const v of values) {
    const key = Math.round(v / bucketSize) * bucketSize;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [key, count] of buckets) {
    if (count > bestCount) { bestCount = count; best = key; }
  }
  return best;
}

function fmtR(value: number): string {
  return `R$ ${Math.round(value).toLocaleString('pt-BR')}`;
}

const TOOLTIP_STYLE = {
  backgroundColor: 'rgba(0,0,0,0.92)',
  borderRadius: '12px',
  border: '1px solid rgba(255,255,255,0.1)',
  backdropFilter: 'blur(20px)',
  fontSize: 11,
  color: 'rgba(255,255,255,0.7)',
};

export function CategoryInsightsModal({
  accountId,
  accountName,
  accountFullName,
  icon,
  color,
  onClose,
}: CategoryInsightsModalProps) {
  const { data: raw = [], isLoading } = useQuery({
    queryKey: ['categoryInsights', accountId],
    queryFn: () => fetchCategoryMonthlyHistory(accountId, 13),
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Use the last 12 months for display; keep 13 points so the 12-month MA is
  // fully defined for the final point
  const display = raw.slice(-12);
  const full13 = raw;

  const spentValues = display.map((d) => Number(d.spent));
  const all13Values = full13.map((d) => Number(d.spent));

  const avg = spentValues.length > 0
    ? spentValues.reduce((s, v) => s + v, 0) / spentValues.length
    : 0;

  const sorted = [...spentValues].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length === 0
    ? 0
    : sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];

  const mode = computeMode(spentValues);

  const ma3 = movingAverage(all13Values, 3).slice(-12);
  const ma6 = movingAverage(all13Values, 6).slice(-12);
  const ma12 = movingAverage(all13Values, 12).slice(-12);
  const has12Months = full13.length >= 12;

  const chartData = useMemo(() => display.map((d, i) => ({
    label: format(parseISO(d.month), 'MMM yy'),
    actual: Number(d.spent),
    ma3: ma3[i],
    ma6: ma6[i],
    ma12: has12Months ? ma12[i] : undefined,
  })), [display, ma3, ma6, ma12, has12Months]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative bg-black/90 backdrop-blur-3xl border border-white/10 rounded-3xl p-6 max-w-xl w-full mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <AccountIcon
            accountName={accountFullName}
            icon={icon}
            color={color}
            size="md"
          />
          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-semibold text-foreground/90 truncate">{accountName}</p>
            <p className="text-[11px] font-mono text-white/30 truncate">{accountFullName}</p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-white/30 hover:text-white/70 hover:bg-white/[0.06] transition-all"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {isLoading ? (
          <div className="h-64 animate-pulse bg-white/[0.03] rounded-2xl" />
        ) : (
          <>
            {/* Stats row */}
            <div className="grid grid-cols-3 gap-px bg-white/[0.06] rounded-2xl overflow-hidden mb-5">
              {[
                { label: 'Average', value: avg },
                { label: 'Median', value: median },
                { label: 'Mode', value: mode },
              ].map(({ label, value }) => (
                <div key={label} className="bg-black/60 px-4 py-3.5 text-center">
                  <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-white/30 mb-1">{label}</p>
                  <p className="text-[18px] font-mono font-medium text-white/80 tabular-nums leading-none">
                    {fmtR(value)}
                  </p>
                </div>
              ))}
            </div>

            {/* Chart */}
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.04)" />
                  <XAxis
                    dataKey="label"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
                    tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(Math.round(v))}
                    width={40}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value, name) => {
                      const labels: Record<string, string> = {
                        actual: 'Actual',
                        ma3: '3-mo avg',
                        ma6: '6-mo avg',
                        ma12: '12-mo avg',
                      };
                      return [fmtR(Number(value)), labels[String(name)] ?? String(name)];
                    }}
                    labelStyle={{ color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}
                  />
                  <ReferenceLine
                    y={avg}
                    stroke="#3B82F6"
                    strokeDasharray="4 3"
                    strokeWidth={1}
                    label={{ value: 'avg', fill: '#3B82F6', fontSize: 9, position: 'insideTopRight' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="actual"
                    stroke="rgba(255,255,255,0.65)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3, fill: 'white' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="ma3"
                    stroke="#F59E0B"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="ma6"
                    stroke="#10B981"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    dot={false}
                  />
                  {has12Months && (
                    <Line
                      type="monotone"
                      dataKey="ma12"
                      stroke="#8B5CF6"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      dot={false}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Legend */}
            <div className="flex items-center flex-wrap gap-x-4 gap-y-1.5 mt-3 justify-center">
              {[
                { color: 'rgba(255,255,255,0.65)', label: 'Actual', dashed: false },
                { color: '#3B82F6', label: 'Average', dashed: true },
                { color: '#F59E0B', label: '3-mo MA', dashed: true },
                { color: '#10B981', label: '6-mo MA', dashed: true },
                ...(has12Months ? [{ color: '#8B5CF6', label: '12-mo MA', dashed: true }] : []),
              ].map(({ color: c, label, dashed }) => (
                <div key={label} className="flex items-center gap-1.5">
                  <svg width="16" height="8" className="shrink-0">
                    <line
                      x1="0" y1="4" x2="16" y2="4"
                      stroke={c}
                      strokeWidth={dashed ? 1.5 : 2}
                      strokeDasharray={dashed ? '4 3' : undefined}
                    />
                  </svg>
                  <span className="text-[10px] text-white/35">{label}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
