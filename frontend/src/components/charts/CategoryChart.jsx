import { useMemo } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { currency } from '../../utils/format';
import { normalizeRows } from '../../utils/format';
import ChartCard from './ChartCard';
import ChartEmpty from './ChartEmpty';
import { TOOLTIP_STYLE, GRID_PROPS, AXIS_TICK_SM, LEGEND_STYLE, compactCurrency } from './chartTheme';

export default function CategoryChart({ data = [] }) {
  const rows = useMemo(
    () => normalizeRows(data, ['revenue', 'myShare', 'net']).sort((a, b) => b.revenue - a.revenue),
    [data],
  );

  return (
    <ChartCard title="Category Breakdown" subtitle="Revenue vs your share vs net by category">
      {rows.length === 0 ? <ChartEmpty message="No category data" /> : (
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 28, left: 0 }}>
            <defs>
              <linearGradient id="catRevenue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366f1" stopOpacity={0.9} />
                <stop offset="100%" stopColor="#4f46e5" stopOpacity={0.5} />
              </linearGradient>
              <linearGradient id="catMyShare" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.9} />
                <stop offset="100%" stopColor="#0ea5e9" stopOpacity={0.5} />
              </linearGradient>
              <linearGradient id="catNet" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#34d399" stopOpacity={0.9} />
                <stop offset="100%" stopColor="#10b981" stopOpacity={0.5} />
              </linearGradient>
            </defs>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis
              dataKey="category"
              tick={{ fontSize: 10, fill: '#64748b', fontWeight: 500 }}
              axisLine={false}
              tickLine={false}
              angle={-28}
              textAnchor="end"
              interval={0}
              height={56}
            />
            <YAxis tickFormatter={compactCurrency} tick={AXIS_TICK_SM} axisLine={false} tickLine={false} width={58} />
            <Tooltip
              formatter={(v, name) => [currency(v), name]}
              contentStyle={TOOLTIP_STYLE}
              labelStyle={{ color: '#fff', fontWeight: 600, marginBottom: 6 }}
              itemStyle={{ color: '#94a3b8' }}
              cursor={{ fill: 'rgba(241, 245, 249, 0.4)' }}
            />
            <Legend wrapperStyle={LEGEND_STYLE} />
            <Bar dataKey="revenue" name="Gross Revenue" fill="url(#catRevenue)" radius={[5, 5, 0, 0]} maxBarSize={28} />
            <Bar dataKey="myShare" name="My Share" fill="url(#catMyShare)" radius={[5, 5, 0, 0]} maxBarSize={28} />
            <Bar dataKey="net" name="Net (after fees)" fill="url(#catNet)" radius={[5, 5, 0, 0]} maxBarSize={28} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
