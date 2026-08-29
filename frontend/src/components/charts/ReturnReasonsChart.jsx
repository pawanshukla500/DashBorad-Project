import { useMemo } from 'react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
} from 'recharts';
import ChartCard from './ChartCard';
import ChartEmpty from './ChartEmpty';
import { CHART_PALETTE, TOOLTIP_STYLE } from './chartTheme';
import { num, toNum } from '../../utils/format';

function formatLabel(reason) {
  return (reason || 'Unknown')
    .replace(/_/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export default function ReturnReasonsChart({ data = [] }) {
  const { chartData, total } = useMemo(() => {
    const normalized = (data || []).map(r => ({
      ...r,
      count: toNum(r.count),
      amount: toNum(r.amount),
    }));

    const sorted = [...normalized].sort((a, b) => b.count - a.count);
    const top = sorted.slice(0, 7);
    const rest = sorted.slice(7);
    const otherCount = rest.reduce((s, r) => s + r.count, 0);

    const rows = [
      ...top.map(r => ({ ...r, label: formatLabel(r.reason) })),
      ...(otherCount > 0 ? [{ reason: 'Other', count: otherCount, label: 'Other / Misc' }] : []),
    ];

    const sum = rows.reduce((s, r) => s + r.count, 0);
    return { chartData: rows, total: sum };
  }, [data]);

  if (!data?.length) {
    return (
      <ChartCard title="Return Reasons" subtitle="Top reasons customers return orders">
        <ChartEmpty message="No return data" icon="pie" />
      </ChartCard>
    );
  }

  return (
    <ChartCard
      title="Return Reasons"
      subtitle={`${num(total)} total returns across ${chartData.length} categories`}
      className="h-full"
    >
      <div className="flex flex-col gap-4">
        {/* Donut chart */}
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie
              data={chartData}
              dataKey="count"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius={52}
              outerRadius={78}
              paddingAngle={2}
              stroke="none"
            >
              {chartData.map((_, i) => (
                <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value, _, props) => {
                const pct = total > 0 ? ((value / total) * 100).toFixed(1) : '0';
                return [`${num(value)} (${pct}%)`, props.payload.label];
              }}
            />
            <text x="50%" y="48%" textAnchor="middle" className="fill-slate-800 text-lg font-bold">
              {total >= 1000 ? `${(total / 1000).toFixed(1)}k` : total}
            </text>
            <text x="50%" y="58%" textAnchor="middle" className="fill-slate-400 text-[10px]">
              returns
            </text>
          </PieChart>
        </ResponsiveContainer>

        {/* Ranked list */}
        <div className="space-y-1.5 max-h-[220px] overflow-y-auto pr-1">
          {chartData.map((r, i) => {
            const pct = total > 0 ? ((r.count / total) * 100) : 0;
            return (
              <div key={r.label} className="group">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: CHART_PALETTE[i % CHART_PALETTE.length] }}
                    />
                    <span className="text-[11px] font-medium text-ink truncate" title={r.label}>
                      {r.label}
                    </span>
                  </div>
                  <span className="text-[11px] font-bold text-secondary shrink-0 tabular-nums">
                    {pct.toFixed(1)}%
                  </span>
                </div>
                <div className="h-1.5 bg-surface-container rounded-full overflow-hidden ml-4">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.max(pct, 1)}%`,
                      background: CHART_PALETTE[i % CHART_PALETTE.length],
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </ChartCard>
  );
}
