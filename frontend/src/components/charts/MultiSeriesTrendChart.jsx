import { useMemo } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { CartesianGrid, ComposedChart, Line, XAxis, YAxis, Area, Bar } from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartLegend,
  ChartLegendContent,
} from '@/components/ui/line-charts-9';
import ChartEmpty from './ChartEmpty';
import { currency, num } from '@/utils/format';
import { compactCurrency, normalizeTrendRows } from './chartTheme';

/**
 * Multi-series recon trend — coloured lines for Sales / Bank / Returns / Orders.
 * Better than stacked pillars when comparing trajectories over time.
 */
const SERIES = {
  revenue: { key: 'revenue', label: 'Gross Sales', color: '#4F46E5', format: 'money' },
  bank: { key: 'myShare', label: 'Bank Received', color: '#3B82F6', format: 'money' },
  returns: { key: 'returns', label: 'Returns', color: '#EF4444', format: 'count', yAxis: 'right' },
  orders: { key: 'orders', label: 'Orders', color: '#10B981', format: 'count', yAxis: 'right' },
  customerReturns: { key: 'customerReturns', label: 'Customer Returns', color: '#F59E0B', format: 'count' },
  courierReturns: { key: 'courierReturns', label: 'Courier / RTO', color: '#64748B', format: 'count' },
  returnRate: { key: 'returnRate', label: 'Return Rate %', color: '#EF4444', format: 'pct', yAxis: 'right' },
};

function buildConfig(seriesKeys) {
  const config = {};
  for (const k of seriesKeys) {
    const s = SERIES[k];
    if (s) config[s.key] = { label: s.label, color: s.color };
  }
  return config;
}

function ReconTooltip({ active, payload, label, seriesKeys }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover border border-border rounded-lg p-3 shadow-lg min-w-[10rem]">
      <div className="text-sm font-semibold text-foreground mb-2">{label}</div>
      <div className="space-y-1.5">
        {payload.map((item) => {
          const meta = Object.values(SERIES).find((s) => s.key === item.dataKey);
          const raw = item.value;
          let display = num(raw);
          if (meta?.format === 'money') display = currency(raw);
          if (meta?.format === 'pct') display = `${(+raw || 0).toFixed(1)}%`;
          return (
            <div key={item.dataKey} className="flex items-center justify-between gap-6 text-xs">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: item.color || meta?.color }} />
                {meta?.label || item.name}
              </span>
              <span className="font-semibold tabular-nums text-foreground">{display}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {array} props.data - trend rows from API
 * @param {string[]} props.series - keys from SERIES (default sales set)
 * @param {string} props.title
 * @param {string} props.subtitle
 * @param {boolean} props.showHeaderStats
 */
export default function MultiSeriesTrendChart({
  data = [],
  series = ['revenue', 'bank', 'orders'],
  title = 'Performance Trend',
  subtitle,
  showHeaderStats = true,
  heightClass = 'h-80',
  variant = 'line',
}) {
  const rows = useMemo(() => {
    const normalized = normalizeTrendRows(data);
    return normalized.map((d) => ({
      ...d,
      returns: +(d.returns ?? 0) || ((d.customerReturns || 0) + (d.courierReturns || 0)),
    }));
  }, [data]);

  const seriesKeys = series.filter((k) => SERIES[k]);
  const chartConfig = useMemo(() => buildConfig(seriesKeys), [seriesKeys.join(',')]);

  const primaryKey = SERIES[seriesKeys[0]]?.key;
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const lastVal = last?.[primaryKey] || 0;
  const prevVal = prev?.[primaryKey] || 0;
  const deltaPct = prevVal > 0 ? ((lastVal - prevVal) / prevVal) * 100 : 0;
  const up = deltaPct >= 0;

  const hasRight = seriesKeys.some((k) => SERIES[k]?.yAxis === 'right');

  if (!rows.length) {
    return (
      <Card className="w-full">
        <CardContent className="p-5">
          <h3 className="text-sm font-semibold text-foreground mb-1">{title}</h3>
          {subtitle && <p className="text-xs text-muted-foreground mb-4">{subtitle}</p>}
          <ChartEmpty />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full overflow-hidden">
      <CardContent className="flex flex-col gap-4 p-5">
        {showHeaderStats && (
          <div>
            <h3 className="text-sm text-muted-foreground font-medium mb-1">{title}</h3>
            <div className="flex flex-wrap items-baseline gap-2 sm:gap-3">
              <span className="text-2xl sm:text-3xl font-bold text-foreground tabular-nums">
                {SERIES[seriesKeys[0]]?.format === 'money' ? currency(lastVal) : num(lastVal)}
              </span>
              {rows.length >= 2 && (
                <div className={`flex items-center gap-1 text-sm ${up ? 'text-emerald-600' : 'text-rose-600'}`}>
                  {up ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                  <span className="font-medium">{up ? '+' : ''}{deltaPct.toFixed(1)}%</span>
                  <span className="text-muted-foreground font-normal">vs prior period</span>
                </div>
              )}
            </div>
            {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
          </div>
        )}

        {!showHeaderStats && (
          <div>
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
        )}

        <ChartContainer config={chartConfig} className={`${heightClass} w-full aspect-auto`}>
          <ComposedChart data={rows} margin={{ top: 12, right: hasRight ? 16 : 8, left: 4, bottom: 8 }}>
            <defs>
              {seriesKeys.slice(0, 1).map((k) => {
                const s = SERIES[k];
                return (
                  <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.18} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                  </linearGradient>
                );
              })}
            </defs>
            <CartesianGrid strokeDasharray="4 8" vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.9} />
            <XAxis
              dataKey="period"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
              tickMargin={10}
            />
            <YAxis
              yAxisId="left"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
              tickFormatter={(v) =>
                seriesKeys.some((k) => SERIES[k]?.format === 'money' && SERIES[k]?.yAxis !== 'right')
                  ? compactCurrency(v)
                  : num(v)
              }
              width={56}
            />
            {hasRight && (
              <YAxis
                yAxisId="right"
                orientation="right"
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                tickFormatter={(v) =>
                  seriesKeys.some((k) => SERIES[k]?.format === 'pct') ? `${v}%` : num(v)
                }
                width={44}
              />
            )}
            <ChartTooltip content={<ReconTooltip seriesKeys={seriesKeys} />} />
            <ChartLegend content={<ChartLegendContent />} />
            
            {variant === 'bar' ? (
              seriesKeys.map((k) => {
                const s = SERIES[k];
                return (
                  <Bar
                    key={s.key}
                    yAxisId={s.yAxis === 'right' ? 'right' : 'left'}
                    dataKey={s.key}
                    name={s.label}
                    fill={s.color}
                    radius={[2, 2, 0, 0]}
                    maxBarSize={40}
                  />
                );
              })
            ) : (
              <>
                {seriesKeys.slice(0, 1).map((k) => {
                  const s = SERIES[k];
                  return (
                    <Area
                      key={`area-${s.key}`}
                      yAxisId={s.yAxis === 'right' ? 'right' : 'left'}
                      type="linear"
                      dataKey={s.key}
                      name={s.label}
                      fill={`url(#fill-${s.key})`}
                      stroke={s.color}
                      strokeWidth={2.5}
                      dot={{ r: rows.length <= 3 ? 5 : 3, fill: s.color, strokeWidth: 2, stroke: '#fff' }}
                      activeDot={{ r: 6, strokeWidth: 0 }}
                    />
                  );
                })}
                {seriesKeys.slice(1).map((k) => {
                  const s = SERIES[k];
                  return (
                    <Line
                      key={s.key}
                      yAxisId={s.yAxis === 'right' ? 'right' : 'left'}
                      type="linear"
                      dataKey={s.key}
                      name={s.label}
                      stroke={s.color}
                      strokeWidth={2.5}
                      dot={{ r: rows.length <= 3 ? 5 : 3, fill: s.color, strokeWidth: 2, stroke: '#fff' }}
                      activeDot={{ r: 6, strokeWidth: 0 }}
                    />
                  );
                })}
              </>
            )}
          </ComposedChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

export { SERIES };
