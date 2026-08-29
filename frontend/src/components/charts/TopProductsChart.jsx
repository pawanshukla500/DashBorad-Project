import { useMemo } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { currency, normalizeRows } from '../../utils/format';
import ChartCard from './ChartCard';
import ChartEmpty from './ChartEmpty';
import { TOOLTIP_STYLE, GRID_PROPS, LEGEND_STYLE } from './chartTheme';

export default function TopProductsChart({ data = [] }) {
  const display = useMemo(
    () => normalizeRows(data, ['revenue', 'myShare'])
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8)
      .map(p => ({
        ...p,
        label: (p.sku || p.fsn || 'Unknown').slice(0, 18),
      })),
    [data],
  );

  return (
    <ChartCard title="Top Products" subtitle="By gross revenue · top 8 SKUs">
      {display.length === 0 ? <ChartEmpty message="No product data" icon="pie" /> : (
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={display} layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: 4 }}>
            <defs>
              <linearGradient id="prodRevenue" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#4f46e5" stopOpacity={0.45} />
                <stop offset="100%" stopColor="#6366f1" stopOpacity={0.95} />
              </linearGradient>
              <linearGradient id="prodMyShare" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#059669" stopOpacity={0.45} />
                <stop offset="100%" stopColor="#10b981" stopOpacity={0.95} />
              </linearGradient>
            </defs>
            <CartesianGrid {...GRID_PROPS} horizontal={false} vertical />
            <XAxis
              type="number"
              tick={{ fontSize: 10, fill: '#64748b' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={v => currency(v)}
            />
            <YAxis
              type="category"
              dataKey="label"
              tick={{ fontSize: 10, fill: '#475569', fontWeight: 600 }}
              axisLine={false}
              tickLine={false}
              width={112}
            />
            <Tooltip
              formatter={(v, name) => [currency(v), name === 'revenue' ? 'Gross Revenue' : 'My Share']}
              contentStyle={TOOLTIP_STYLE}
              labelStyle={{ color: '#fff', fontWeight: 600, marginBottom: 6 }}
              itemStyle={{ color: '#94a3b8' }}
              cursor={{ fill: 'rgba(241, 245, 249, 0.4)' }}
            />
            <Legend wrapperStyle={LEGEND_STYLE} formatter={v => (v === 'revenue' ? 'Gross Revenue' : 'My Share')} />
            <Bar dataKey="revenue" name="revenue" fill="url(#prodRevenue)" radius={[0, 5, 5, 0]} maxBarSize={14} />
            <Bar dataKey="myShare" name="myShare" fill="url(#prodMyShare)" radius={[0, 5, 5, 0]} maxBarSize={14} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
