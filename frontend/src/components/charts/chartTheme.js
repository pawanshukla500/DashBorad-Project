export const CHART_COLORS = {
  primary: '#4F46E5',
  secondary: '#64748B',
  danger: '#EF4444',
  warning: '#F59E0B',
  success: '#10B981',
  info: '#3B82F6',
  slate: '#94A3B8',
};

export const CHART_PALETTE = [
  '#4F46E5', '#3B82F6', '#10B981', '#F59E0B', '#F43F5E',
  '#8B5CF6', '#EC4899', '#F97316', '#14B8A6', '#64748B',
];

export const TOOLTIP_STYLE = {
  borderRadius: 8,
  border: '1px solid #E2E8F0',
  backgroundColor: '#FFFFFF',
  fontSize: 12,
  fontFamily: 'Inter, sans-serif',
  boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05)',
  padding: '12px',
  color: '#0F172A',
  fontWeight: 500,
};

export const GRID_PROPS = {
  strokeDasharray: '3 3',
  stroke: '#F1F5F9',
  vertical: false,
};

export const AXIS_TICK = { fontSize: 11, fill: '#64748B', fontWeight: 500, fontFamily: 'Inter, sans-serif' };
export const AXIS_TICK_SM = { fontSize: 10, fill: '#94A3B8', fontFamily: 'Inter, sans-serif' };

export const LEGEND_STYLE = { fontSize: 11, paddingTop: 14, fontWeight: 500, color: '#334155', fontFamily: 'Inter, sans-serif' };

export function normalizeTrendRows(data, { minOrderShare = 0.02, minAbsoluteOrders = 10 } = {}) {
  const rows = (data || [])
    .map(d => ({
      ...d,
      revenue: +(d.revenue ?? 0) || 0,
      myShare: +(d.myShare ?? 0) || 0,
      orders: +(d.orders ?? 0) || 0,
      returns: +(d.returns ?? 0) || 0,
      net: +(d.net ?? 0) || 0,
      returnRate: +(d.returnRate ?? 0) || 0,
      customerReturns: +(d.customerReturns ?? 0) || 0,
      courierReturns: +(d.courierReturns ?? 0) || 0,
    }))
    .filter(d => d.revenue || d.myShare || d.orders || d.returns || d.customerReturns || d.courierReturns);

  // Drop near-empty stub periods that create cliff charts when one month dominates
  if (rows.length <= 1) return rows;
  const maxOrders = Math.max(...rows.map(r => r.orders), 0);
  if (maxOrders < 100) return rows;
  const threshold = Math.max(minAbsoluteOrders, Math.floor(maxOrders * minOrderShare));
  return rows.filter(d => {
    const retVol = d.customerReturns + d.courierReturns;
    return d.orders >= threshold || retVol >= threshold || (d.revenue > 0 && d.orders >= minAbsoluteOrders);
  });
}

export function compactCurrency(v) {
  const n = +v;
  if (!n) return '₹0';
  if (Math.abs(n) >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (Math.abs(n) >= 1000) return `₹${(n / 1000).toFixed(1)}K`;
  return `₹${n.toLocaleString('en-IN')}`;
}
