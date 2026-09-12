import { useState, useEffect, useCallback, useMemo } from 'react';
import PageHeader from '../components/PageHeader';
import ExportButton from '../components/ExportButton';
import KPICard from '../components/KPICard';
import OrderDetailDrawer, { OrderIdCell } from '../components/OrderDetailDrawer';
import EmptyState from '../components/EmptyState';
import {
  fetchOutstandingSummary,
  fetchOutstandingOrders,
  fetchOutstandingInvoices,
} from '../api/client';
import { currencyFull, currencyCompact, num } from '../utils/format';

const MARKETPLACES = [
  { key: 'all', label: 'All Marketplaces', short: 'Consolidated', color: 'indigo' },
  { key: 'flipkart', label: 'Flipkart', short: 'Flipkart', color: 'blue' },
  { key: 'amazon', label: 'Amazon', short: 'Amazon', color: 'amber' },
  { key: 'myntra_ej', label: 'Myntra (EJ - 45833)', short: 'Myntra EJ', color: 'rose' },
  { key: 'myntra_vb', label: 'Myntra (VB - 10708)', short: 'Myntra VB', color: 'pink' },
  { key: 'meesho', label: 'Meesho', short: 'Meesho', color: 'emerald' },
];

const AGING_BUCKETS = [
  {
    key: '0_15',
    apiValue: '0-15',
    altKey: '0-15 days',
    label: '0 – 15 Days',
    tag: 'Normal Cycle',
    color: 'emerald',
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dotClass: 'bg-emerald-500',
    desc: 'Within standard TAT',
  },
  {
    key: '16_30',
    apiValue: '16-30',
    altKey: '16-30 days',
    label: '16 – 30 Days',
    tag: 'Due Soon',
    color: 'blue',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
    dotClass: 'bg-blue-500',
    desc: 'Pending remittance',
  },
  {
    key: '31_60',
    apiValue: '31-60',
    altKey: '31-60 days',
    label: '31 – 60 Days',
    tag: 'Overdue',
    color: 'amber',
    badgeClass: 'bg-amber-50 text-amber-700 border-amber-200',
    dotClass: 'bg-amber-500',
    desc: 'Payment overdue',
  },
  {
    key: '60_plus',
    apiValue: '60+',
    altKey: '60+ days',
    label: '60+ Days',
    tag: 'High Risk',
    color: 'rose',
    badgeClass: 'bg-rose-50 text-rose-700 border-rose-200',
    dotClass: 'bg-rose-500',
    desc: 'Dispute candidate',
  },
];

function getAgingData(summary, bucket) {
  if (!summary?.aging) return { count: 0, amount: 0 };
  if (summary.aging[bucket.key]) return summary.aging[bucket.key];
  if (summary.aging[bucket.altKey]) return summary.aging[bucket.altKey];
  return { count: 0, amount: 0 };
}

function getMarketplaceBadge(mp) {
  const norm = String(mp || '').toLowerCase();
  if (norm.includes('flipkart')) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 border border-blue-200">Flipkart</span>;
  }
  if (norm.includes('amazon')) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 border border-amber-200">Amazon</span>;
  }
  if (norm === 'myntra_ej' || norm.includes('45833')) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700 border border-rose-200">Myntra EJ</span>;
  }
  if (norm === 'myntra_vb' || norm.includes('10708') || norm.includes('myntra')) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-pink-50 px-2 py-0.5 text-[11px] font-semibold text-pink-700 border border-pink-200">Myntra VB</span>;
  }
  if (norm.includes('meesho')) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 border border-emerald-200">Meesho</span>;
  }
  return <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700 border border-slate-200">{mp || '—'}</span>;
}

function getAgingBadge(bucketStr) {
  const norm = String(bucketStr || '').toLowerCase().replace(/[\s_-]+/g, '');
  let b = AGING_BUCKETS[0];
  if (norm.includes('16') || norm.includes('30') && !norm.includes('31')) b = AGING_BUCKETS[1];
  else if (norm.includes('31') || norm.includes('60') && !norm.includes('plus') && !norm.includes('+')) b = AGING_BUCKETS[2];
  else if (norm.includes('60') || norm.includes('plus') || norm.includes('+')) b = AGING_BUCKETS[3];

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium border ${b.badgeClass}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${b.dotClass}`} />
      {b.label}
    </span>
  );
}

function getStatusBadge(status) {
  const s = String(status || '').toLowerCase();
  let color = 'bg-slate-50 text-slate-700 border-slate-200';
  if (s.includes('deliver')) color = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  else if (s.includes('ship')) color = 'bg-blue-50 text-blue-700 border-blue-200';
  else if (s.includes('cancel')) color = 'bg-rose-50 text-rose-700 border-rose-200';
  else if (s.includes('return') || s.includes('rto')) color = 'bg-amber-50 text-amber-700 border-amber-200';
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium border capitalize ${color}`}>
      {status || 'Unknown'}
    </span>
  );
}

export default function OutstandingPaymentsPage() {
  const [selectedMp, setSelectedMp] = useState('all');
  const [selectedAging, setSelectedAging] = useState('');
  const [activeTab, setActiveTab] = useState('orders'); // 'orders' | 'invoices'

  // Orders Table State
  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersPagination, setOrdersPagination] = useState({ page: 1, limit: 50, total: 0, pages: 1 });
  const [orderSearch, setOrderSearch] = useState('');
  const [orderStatusFilter, setOrderStatusFilter] = useState('');

  // Invoices Table State
  const [invoices, setInvoices] = useState([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoicesPagination, setInvoicesPagination] = useState({ page: 1, limit: 50, total: 0, pages: 1 });
  const [invoiceSearch, setInvoiceSearch] = useState('');

  // Summary State
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [refreshCount, setRefreshCount] = useState(0);

  // Drawer
  const [selectedOrderItemId, setSelectedOrderItemId] = useState(null);

  // 1. Fetch Summary
  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const res = await fetchOutstandingSummary({
        marketplace: selectedMp !== 'all' ? selectedMp : undefined,
      });
      if (res) {
        setSummary(res);
      }
    } catch (err) {
      console.error('Failed to load outstanding summary', err);
    } finally {
      setSummaryLoading(false);
    }
  }, [selectedMp]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary, refreshCount]);

  // 2. Fetch Orders
  const loadOrders = useCallback(async (page = 1) => {
    setOrdersLoading(true);
    try {
      const res = await fetchOutstandingOrders({
        marketplace: selectedMp !== 'all' ? selectedMp : undefined,
        aging_bucket: selectedAging || undefined,
        status: orderStatusFilter || undefined,
        search: orderSearch ? orderSearch.trim() : undefined,
        page,
        pageSize: ordersPagination.limit,
      });
      if (res) {
        const list = res.data || [];
        const total = Number(res.total || 0);
        const limit = Number(res.pageSize || ordersPagination.limit);
        const currentPage = Number(res.page || page);
        const pages = Math.max(1, Math.ceil(total / limit));

        setOrders(list);
        setOrdersPagination({ page: currentPage, limit, total, pages });
      }
    } catch (err) {
      console.error('Failed to load outstanding orders', err);
    } finally {
      setOrdersLoading(false);
    }
  }, [selectedMp, selectedAging, orderStatusFilter, orderSearch, ordersPagination.limit]);

  useEffect(() => {
    if (activeTab === 'orders') {
      loadOrders(1);
    }
  }, [selectedMp, selectedAging, orderStatusFilter, activeTab, refreshCount]);

  // Debounced search for orders
  useEffect(() => {
    if (activeTab !== 'orders') return;
    const timer = setTimeout(() => {
      loadOrders(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [orderSearch]);

  // 3. Fetch Invoices
  const loadInvoices = useCallback(async (page = 1) => {
    setInvoicesLoading(true);
    try {
      const res = await fetchOutstandingInvoices({
        marketplace: selectedMp !== 'all' ? selectedMp : undefined,
        search: invoiceSearch ? invoiceSearch.trim() : undefined,
        page,
        pageSize: invoicesPagination.limit,
      });
      if (res) {
        const list = res.data || [];
        const total = Number(res.total || 0);
        const limit = Number(res.pageSize || invoicesPagination.limit);
        const currentPage = Number(res.page || page);
        const pages = Math.max(1, Math.ceil(total / limit));

        setInvoices(list);
        setInvoicesPagination({ page: currentPage, limit, total, pages });
      }
    } catch (err) {
      console.error('Failed to load pending invoices', err);
    } finally {
      setInvoicesLoading(false);
    }
  }, [selectedMp, invoiceSearch, invoicesPagination.limit]);

  useEffect(() => {
    if (activeTab === 'invoices') {
      loadInvoices(1);
    }
  }, [selectedMp, activeTab, refreshCount]);

  useEffect(() => {
    if (activeTab !== 'invoices') return;
    const timer = setTimeout(() => {
      loadInvoices(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [invoiceSearch]);

  const handleRefresh = () => {
    setRefreshCount(c => c + 1);
  };

  // Build Excel Export
  const buildExport = useCallback(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const mpName = selectedMp === 'all' ? 'Consolidated' : selectedMp.toUpperCase();
    const filename = `Outstanding_Payments_${mpName}_${today}`;

    // Summary Sheet
    const summaryRows = [
      ['Metric', 'Value'],
      ['Scope', mpName],
      ['Total Outstanding Amount (Rs)', summary?.total_outstanding_amount || 0],
      ['Total Unsettled Orders Count', summary?.total_unsettled_orders || 0],
      ['Total Unsettled Orders Amount (Rs)', summary?.total_unsettled_amount || 0],
      ['Total Pending Invoices Count', summary?.total_pending_invoices || 0],
      ['Total Pending Invoices Amount (Rs)', summary?.total_pending_invoice_amount || 0],
      ['Aging 0-15 Days Amount (Rs)', getAgingData(summary, AGING_BUCKETS[0]).amount],
      ['Aging 0-15 Days Orders Count', getAgingData(summary, AGING_BUCKETS[0]).count],
      ['Aging 16-30 Days Amount (Rs)', getAgingData(summary, AGING_BUCKETS[1]).amount],
      ['Aging 16-30 Days Orders Count', getAgingData(summary, AGING_BUCKETS[1]).count],
      ['Aging 31-60 Days Amount (Rs)', getAgingData(summary, AGING_BUCKETS[2]).amount],
      ['Aging 31-60 Days Orders Count', getAgingData(summary, AGING_BUCKETS[2]).count],
      ['Aging 60+ Days Amount (Rs)', getAgingData(summary, AGING_BUCKETS[3]).amount],
      ['Aging 60+ Days Orders Count', getAgingData(summary, AGING_BUCKETS[3]).count],
    ];

    // Marketplace Matrix Sheet
    const matrixHeaders = [
      'Marketplace',
      'Seller Account',
      'Unsettled Orders',
      'Orders Amount (Rs)',
      'Pending Invoices',
      'Invoices Amount (Rs)',
      'Total Outstanding (Rs)',
      '0-15 Days (Rs)',
      '16-30 Days (Rs)',
      '31-60 Days (Rs)',
      '60+ Days (Rs)',
    ];
    const matrixRows = (summary?.by_marketplace || []).map(m => [
      m.display_name,
      m.seller_account || 'default',
      m.unsettled_orders_count || 0,
      m.unsettled_amount || 0,
      m.pending_invoices_count || 0,
      m.pending_invoices_amount || 0,
      m.total_outstanding || 0,
      m.aging_0_15 || 0,
      m.aging_16_30 || 0,
      m.aging_31_60 || 0,
      m.aging_60_plus || 0,
    ]);

    // Current Orders Sample Sheet
    const orderHeaders = [
      'Order Item ID',
      'Order ID',
      'Order Date',
      'Days Outstanding',
      'Aging Bucket',
      'Marketplace',
      'Account Name',
      'SKU',
      'Category',
      'Status',
      'Return Type',
      'Invoice Amount (Rs)',
    ];
    const orderRows = orders.map(o => [
      o.order_item_id,
      o.order_id,
      o.order_date,
      o.days_outstanding,
      o.aging_bucket,
      o.marketplace,
      o.seller_account,
      o.sku,
      o.category,
      o.orders_status,
      o.ret_type || o.return_status || '',
      o.final_invoice_amount,
    ]);

    return {
      filename,
      sheets: [
        {
          sheetName: 'KPI Summary',
          headers: summaryRows[0],
          rows: summaryRows.slice(1),
          colWidths: [35, 25],
        },
        {
          sheetName: 'Marketplace Matrix',
          headers: matrixHeaders,
          rows: matrixRows,
          colWidths: [22, 16, 18, 20, 18, 20, 22, 16, 16, 16, 16],
        },
        {
          sheetName: 'Unsettled Orders',
          headers: orderHeaders,
          rows: orderRows,
          colWidths: [24, 22, 14, 16, 16, 16, 16, 20, 18, 14, 14, 20],
        },
      ],
    };
  }, [selectedMp, summary, orders]);

  // Derived KPI calculations
  const totalOutstanding = Number(summary?.total_outstanding_amount || 0);
  const totalOrdersCount = Number(summary?.total_unsettled_orders || 0);
  const totalOrdersAmount = Number(summary?.total_unsettled_amount || 0);
  const totalInvoicesCount = Number(summary?.total_pending_invoices || 0);
  const totalInvoicesAmount = Number(summary?.total_pending_invoice_amount || 0);

  const criticallyOverdueAmount = Number(summary?.overdue_amount_30d || 0);
  const criticallyOverdueCount = Number(summary?.overdue_orders_30d || 0);

  return (
    <div className="space-y-6 pb-12">
      {/* 1. Header with Title, Actions */}
      <PageHeader
        title="Outstanding Payments & Aging Analysis"
        subtitle="Consolidated and marketplace-wise tracking of unsettled orders, pending invoices, and aging receivables"
      >
        <button
          type="button"
          onClick={handleRefresh}
          disabled={summaryLoading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-semibold text-ink hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
          title="Refresh data"
        >
          <span className={`material-symbols-outlined text-[16px] ${summaryLoading ? 'animate-spin' : ''}`}>
            refresh
          </span>
          Refresh
        </button>
        <ExportButton
          label="Export Workbook"
          buildExport={buildExport}
          disabled={summaryLoading || !summary}
        />
      </PageHeader>

      {/* 2. Marketplace Selector Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 border-b border-border">
        {MARKETPLACES.map(m => {
          const isActive = selectedMp === m.key;
          let mpAmount = null;
          if (summary?.by_marketplace) {
            if (m.key === 'all') {
              mpAmount = summary.total_outstanding_amount;
            } else {
              const matchedItems = summary.by_marketplace.filter(x => {
                if (m.key === 'myntra_ej') return x.marketplace === 'myntra' && (x.seller_account === 'myntra_ej' || x.seller_account === '45833');
                if (m.key === 'myntra_vb') return x.marketplace === 'myntra' && (x.seller_account === 'myntra_vb' || x.seller_account === '10708' || !x.seller_account || x.seller_account === 'default');
                return x.marketplace === m.key;
              });
              if (matchedItems.length > 0) {
                mpAmount = matchedItems.reduce((sum, item) => sum + Number(item.total_outstanding || 0), 0);
              }
            }
          }

          return (
            <button
              key={m.key}
              type="button"
              onClick={() => {
                setSelectedMp(m.key);
                setSelectedAging('');
                setOrdersPagination(p => ({ ...p, page: 1 }));
              }}
              className={`inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3.5 py-2 text-xs font-semibold transition-all select-none ${
                isActive
                  ? 'bg-primary text-on-primary shadow-sm ring-1 ring-primary'
                  : 'bg-surface text-secondary hover:bg-surface-container-low hover:text-ink border border-border'
              }`}
            >
              <span>{m.label}</span>
              {mpAmount != null && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums ${
                    isActive ? 'bg-white/20 text-white' : 'bg-surface-container text-outline'
                  }`}
                >
                  {currencyCompact(mpAmount)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 3. Top KPI Metric Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          title="Total Outstanding"
          value={currencyFull(totalOutstanding)}
          sub={`${num(totalOrdersCount)} unsettled orders · ${num(totalInvoicesCount)} invoices`}
          color="primary"
          icon={<span className="material-symbols-outlined text-[20px]">account_balance_wallet</span>}
        />
        <KPICard
          title="Unsettled Orders Amount"
          value={currencyFull(totalOrdersAmount)}
          sub={`${num(totalOrdersCount)} orders awaiting remittance`}
          color="indigo"
          icon={<span className="material-symbols-outlined text-[20px]">shopping_cart</span>}
        />
        <KPICard
          title="Overdue (>30 Days)"
          value={currencyFull(criticallyOverdueAmount)}
          sub={`${num(criticallyOverdueCount)} orders · dispute candidate`}
          color="danger"
          icon={<span className="material-symbols-outlined text-[20px]">warning</span>}
        />
        <KPICard
          title="Pending Invoiced Amount"
          value={currencyFull(totalInvoicesAmount)}
          sub={`${num(totalInvoicesCount)} invoices awaiting payment`}
          color="warning"
          icon={<span className="material-symbols-outlined text-[20px]">receipt_long</span>}
        />
      </div>

      {/* 4. Interactive Aging Distribution Pipeline */}
      <div className="rounded-xl border border-border bg-surface p-5 space-y-4 shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="font-display text-sm font-bold text-ink uppercase tracking-wider flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-[18px]">schedule</span>
              Aging Receivables Pipeline
            </h3>
            <p className="text-xs text-outline mt-0.5">
              Click on any aging bucket to filter the order drilldown table below
            </p>
          </div>
          {selectedAging && (
            <button
              type="button"
              onClick={() => setSelectedAging('')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-container-low px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-container transition-colors"
            >
              <span className="material-symbols-outlined text-[14px]">close</span>
              Clear Aging Filter
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {AGING_BUCKETS.map(b => {
            const bucketData = getAgingData(summary, b);
            const amount = Number(bucketData.amount || 0);
            const count = Number(bucketData.count || 0);
            const share = totalOutstanding > 0 ? ((amount / totalOutstanding) * 100).toFixed(1) : 0;
            const isSelected = selectedAging === b.apiValue || selectedAging === b.key;

            return (
              <button
                key={b.key}
                type="button"
                onClick={() => {
                  setSelectedAging(isSelected ? '' : b.apiValue);
                  setOrdersPagination(p => ({ ...p, page: 1 }));
                }}
                className={`flex flex-col text-left rounded-xl p-4 transition-all border ${
                  isSelected
                    ? 'border-primary ring-2 ring-primary/30 bg-primary-fixed/20 shadow-md'
                    : 'border-border bg-surface-container-lowest hover:border-outline-variant hover:shadow-sm'
                }`}
              >
                <div className="flex items-center justify-between w-full mb-2">
                  <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold border ${b.badgeClass}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${b.dotClass}`} />
                    {b.label}
                  </span>
                  <span className="text-[11px] font-medium text-outline">{share}% share</span>
                </div>
                <div className="mt-1">
                  <p className="font-sans text-xl font-bold text-ink tabular-nums">
                    {currencyFull(amount)}
                  </p>
                  <p className="text-xs text-outline mt-0.5 font-medium">
                    {num(count)} orders · {b.desc}
                  </p>
                </div>
                {isSelected && (
                  <div className="mt-3 flex items-center gap-1 text-[11px] font-semibold text-primary">
                    <span className="material-symbols-outlined text-[14px]">filter_alt</span>
                    Active filter
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* 5. Consolidated Marketplace Matrix Overview */}
      {selectedMp === 'all' && (summary?.by_marketplace?.length || 0) > 0 && (
        <div className="rounded-xl border border-border bg-surface overflow-hidden shadow-sm">
          <div className="px-5 py-4 border-b border-border bg-surface-container-low flex items-center justify-between">
            <div>
              <h3 className="font-display text-sm font-bold text-ink uppercase tracking-wider flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[18px]">table_chart</span>
                Marketplace Receivables Matrix
              </h3>
              <p className="text-xs text-outline mt-0.5">
                Side-by-side comparison of outstanding dues across all integrated sales channels
              </p>
            </div>
            <span className="text-xs font-semibold text-outline">
              {summary.by_marketplace.length} Marketplaces Integrated
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-border bg-surface-container-lowest text-secondary font-semibold">
                  <th className="py-3 px-4">Marketplace</th>
                  <th className="py-3 px-4">Account</th>
                  <th className="py-3 px-4 text-right">Unsettled Orders</th>
                  <th className="py-3 px-4 text-right">Orders Value (₹)</th>
                  <th className="py-3 px-4 text-right">Pending Invoices</th>
                  <th className="py-3 px-4 text-right">Total Outstanding (₹)</th>
                  <th className="py-3 px-4 text-center">Portfolio Share</th>
                  <th className="py-3 px-4 text-right">0–15d (₹)</th>
                  <th className="py-3 px-4 text-right">16–30d (₹)</th>
                  <th className="py-3 px-4 text-right">31–60d (₹)</th>
                  <th className="py-3 px-4 text-right">60+d (₹)</th>
                  <th className="py-3 px-4 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border font-sans">
                {summary.by_marketplace.map((m, idx) => {
                  const share = m.percentage_of_total ?? (
                    totalOutstanding > 0
                      ? ((Number(m.total_outstanding || 0) / totalOutstanding) * 100).toFixed(1)
                      : 0
                  );

                  return (
                    <tr key={`${m.marketplace}_${m.seller_account || idx}`} className="hover:bg-surface-container-lowest/80 transition-colors">
                      <td className="py-3 px-4 font-semibold text-ink">
                        <div className="flex items-center gap-2">
                          {getMarketplaceBadge(m.seller_account || m.marketplace)}
                          <span>{m.display_name}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 font-mono text-outline">
                        {m.seller_account || 'default'}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-ink">
                        {num(m.unsettled_orders_count)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-medium text-ink">
                        {currencyFull(m.unsettled_amount)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-ink">
                        {num(m.pending_invoices_count)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-bold text-primary">
                        {currencyFull(m.total_outstanding)}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <div className="w-16 h-2 rounded-full bg-surface-container overflow-hidden">
                            <div
                              className="h-full bg-primary rounded-full"
                              style={{ width: `${Math.min(100, Math.max(0, share))}%` }}
                            />
                          </div>
                          <span className="text-[11px] font-semibold text-outline w-10 text-right">
                            {share}%
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-emerald-700">
                        {currencyCompact(m.aging_0_15)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-blue-700">
                        {currencyCompact(m.aging_16_30)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-amber-700">
                        {currencyCompact(m.aging_31_60)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-rose-700">
                        {currencyCompact(m.aging_60_plus)}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <button
                          type="button"
                          onClick={() => {
                            let targetMp = m.marketplace;
                            if (m.marketplace === 'myntra') {
                              if (m.seller_account === 'myntra_ej' || m.seller_account === '45833') targetMp = 'myntra_ej';
                              else targetMp = 'myntra_vb';
                            }
                            setSelectedMp(targetMp);
                            setSelectedAging('');
                            setOrdersPagination(p => ({ ...p, page: 1 }));
                          }}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-primary hover:bg-primary/10 transition-colors"
                        >
                          View Orders
                          <span className="material-symbols-outlined text-[14px]">chevron_right</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 6. Drilldown Tabs & Data Tables */}
      <div className="rounded-xl border border-border bg-surface shadow-sm">
        {/* Sub-tab Navigation */}
        <div className="border-b border-border px-5 py-3 flex items-center justify-between flex-wrap gap-3 bg-surface-container-low">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('orders')}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                activeTab === 'orders'
                  ? 'bg-primary text-on-primary shadow-sm'
                  : 'text-secondary hover:text-ink hover:bg-surface-container'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">receipt</span>
              Unsettled Orders ({num(ordersPagination.total)})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('invoices')}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                activeTab === 'invoices'
                  ? 'bg-primary text-on-primary shadow-sm'
                  : 'text-secondary hover:text-ink hover:bg-surface-container'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">description</span>
              Pending Invoices ({num(totalInvoicesCount)})
            </button>
          </div>

          {/* Context indicator */}
          <div className="flex items-center gap-2 text-xs text-outline">
            <span>Showing:</span>
            <span className="font-semibold text-ink">
              {MARKETPLACES.find(m => m.key === selectedMp)?.label}
            </span>
            {selectedAging && (
              <>
                <span>·</span>
                {getAgingBadge(selectedAging)}
              </>
            )}
          </div>
        </div>

        {/* Filter controls row */}
        <div className="p-4 border-b border-border bg-surface-container-lowest flex items-center justify-between flex-wrap gap-3">
          {activeTab === 'orders' ? (
            <>
              <div className="flex items-center gap-2.5 flex-1 min-w-[260px] max-w-md">
                <div className="relative w-full">
                  <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-outline text-[18px]">
                    search
                  </span>
                  <input
                    type="text"
                    value={orderSearch}
                    onChange={e => setOrderSearch(e.target.value)}
                    placeholder="Search by Order ID, Item ID, or SKU..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-border bg-surface text-ink placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  {orderSearch && (
                    <button
                      type="button"
                      onClick={() => setOrderSearch('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-outline hover:text-ink"
                    >
                      <span className="material-symbols-outlined text-[14px]">close</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {/* Aging Bucket Dropdown */}
                <select
                  value={selectedAging}
                  onChange={e => setSelectedAging(e.target.value)}
                  className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-ink focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="">All Aging Tiers</option>
                  {AGING_BUCKETS.map(b => (
                    <option key={b.key} value={b.apiValue}>
                      {b.label} ({b.tag})
                    </option>
                  ))}
                </select>

                {/* Status Dropdown */}
                <select
                  value={orderStatusFilter}
                  onChange={e => setOrderStatusFilter(e.target.value)}
                  className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-ink focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="">All Order Statuses</option>
                  <option value="Delivered">Delivered</option>
                  <option value="Shipped">Shipped</option>
                  <option value="Cancelled">Cancelled</option>
                  <option value="Returned">Returned</option>
                  <option value="RTO">RTO</option>
                </select>

                {/* Page Size */}
                <select
                  value={ordersPagination.limit}
                  onChange={e => {
                    const limit = Number(e.target.value);
                    setOrdersPagination(p => ({ ...p, limit, page: 1 }));
                  }}
                  className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-ink focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value={25}>25 / page</option>
                  <option value={50}>50 / page</option>
                  <option value={100}>100 / page</option>
                </select>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2.5 flex-1 min-w-[260px] max-w-md">
                <div className="relative w-full">
                  <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-outline text-[18px]">
                    search
                  </span>
                  <input
                    type="text"
                    value={invoiceSearch}
                    onChange={e => setInvoiceSearch(e.target.value)}
                    placeholder="Search invoice number, SKU, or notes..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-border bg-surface text-ink placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  {invoiceSearch && (
                    <button
                      type="button"
                      onClick={() => setInvoiceSearch('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-outline hover:text-ink"
                    >
                      <span className="material-symbols-outlined text-[14px]">close</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <select
                  value={invoicesPagination.limit}
                  onChange={e => {
                    const limit = Number(e.target.value);
                    setInvoicesPagination(p => ({ ...p, limit, page: 1 }));
                  }}
                  className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-ink focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value={25}>25 / page</option>
                  <option value={50}>50 / page</option>
                  <option value={100}>100 / page</option>
                </select>
              </div>
            </>
          )}
        </div>

        {/* Tab 1: Unsettled Orders Table */}
        {activeTab === 'orders' && (
          <div>
            {ordersLoading ? (
              <div className="flex min-h-[300px] items-center justify-center">
                <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-container-low px-4 py-3 text-xs font-semibold text-secondary">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-outline-variant border-t-primary" />
                  Loading unsettled orders...
                </div>
              </div>
            ) : orders.length === 0 ? (
              <EmptyState
                icon="check_circle"
                title="No Outstanding Orders Found"
                description={
                  selectedAging || orderStatusFilter || orderSearch
                    ? 'No orders match your filter criteria. Try clearing the filters.'
                    : 'All orders in this selection have been completely settled!'
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-border bg-surface-container-lowest text-secondary font-semibold">
                      <th className="py-3 px-4">Order Item ID</th>
                      <th className="py-3 px-4">Order ID</th>
                      <th className="py-3 px-4">Date &amp; Age</th>
                      <th className="py-3 px-4">Channel</th>
                      <th className="py-3 px-4">Account</th>
                      <th className="py-3 px-4">SKU / Category</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4 text-right">Invoice Amount</th>
                      <th className="py-3 px-4 text-center">Aging Tier</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border font-sans">
                    {orders.map(o => (
                      <tr
                        key={o.order_item_id}
                        className="hover:bg-surface-container-lowest/80 transition-colors"
                      >
                        <td className="py-3 px-4 font-mono font-medium">
                          <OrderIdCell
                            id={o.order_item_id}
                            onOpen={setSelectedOrderItemId}
                          />
                        </td>
                        <td className="py-3 px-4 font-mono text-outline select-all">
                          {o.order_id}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <p className="font-medium text-ink">{o.order_date || '—'}</p>
                          <p className="text-[11px] text-outline">{o.days_outstanding} days ago</p>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          {getMarketplaceBadge(o.seller_account || o.marketplace)}
                        </td>
                        <td className="py-3 px-4 text-outline font-medium">
                          {o.seller_account || 'default'}
                        </td>
                        <td className="py-3 px-4 max-w-[200px] truncate" title={`${o.sku} · ${o.category}`}>
                          <p className="font-semibold text-ink truncate">{o.sku || '—'}</p>
                          <p className="text-[11px] text-outline truncate">{o.category || '—'}</p>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          {getStatusBadge(o.orders_status)}
                          {(o.ret_type || o.return_status) && (
                            <span className="block text-[10px] text-amber-700 font-semibold mt-0.5">
                              {o.ret_type || o.return_status}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-primary">
                          {currencyFull(o.final_invoice_amount)}
                        </td>
                        <td className="py-3 px-4 text-center whitespace-nowrap">
                          {getAgingBadge(o.aging_bucket)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Orders Pagination */}
            {ordersPagination.pages > 1 && (
              <div className="flex items-center justify-between border-t border-border px-4 py-3 bg-surface-container-low text-xs">
                <span className="text-outline">
                  Showing page {ordersPagination.page} of {ordersPagination.pages} ({num(ordersPagination.total)} total orders)
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={ordersPagination.page <= 1 || ordersLoading}
                    onClick={() => loadOrders(1)}
                    className="rounded px-2 py-1 text-ink hover:bg-surface-container disabled:opacity-40"
                    title="First page"
                  >
                    «
                  </button>
                  <button
                    type="button"
                    disabled={ordersPagination.page <= 1 || ordersLoading}
                    onClick={() => loadOrders(ordersPagination.page - 1)}
                    className="rounded px-2.5 py-1 text-ink hover:bg-surface-container disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="px-2 font-semibold text-ink">
                    {ordersPagination.page} / {ordersPagination.pages}
                  </span>
                  <button
                    type="button"
                    disabled={ordersPagination.page >= ordersPagination.pages || ordersLoading}
                    onClick={() => loadOrders(ordersPagination.page + 1)}
                    className="rounded px-2.5 py-1 text-ink hover:bg-surface-container disabled:opacity-40"
                  >
                    Next
                  </button>
                  <button
                    type="button"
                    disabled={ordersPagination.page >= ordersPagination.pages || ordersLoading}
                    onClick={() => loadOrders(ordersPagination.pages)}
                    className="rounded px-2 py-1 text-ink hover:bg-surface-container disabled:opacity-40"
                    title="Last page"
                  >
                    »
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Pending Invoices Table */}
        {activeTab === 'invoices' && (
          <div>
            {invoicesLoading ? (
              <div className="flex min-h-[300px] items-center justify-center">
                <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-container-low px-4 py-3 text-xs font-semibold text-secondary">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-outline-variant border-t-primary" />
                  Loading pending invoices...
                </div>
              </div>
            ) : invoices.length === 0 ? (
              <EmptyState
                icon="receipt_long"
                title="No Pending Invoices"
                description="All uploaded marketplace invoices have been fully reconciled and paid."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-border bg-surface-container-lowest text-secondary font-semibold">
                      <th className="py-3 px-4">Invoice #</th>
                      <th className="py-3 px-4">Invoice Date</th>
                      <th className="py-3 px-4">Channel</th>
                      <th className="py-3 px-4">Account</th>
                      <th className="py-3 px-4">SKU / Qty</th>
                      <th className="py-3 px-4 text-right">Invoice Amt</th>
                      <th className="py-3 px-4 text-right">Net Payable</th>
                      <th className="py-3 px-4 text-right">Received</th>
                      <th className="py-3 px-4 text-right">Balance Due</th>
                      <th className="py-3 px-4 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border font-sans">
                    {invoices.map(inv => (
                      <tr
                        key={inv.id || inv.invoice_number}
                        className="hover:bg-surface-container-lowest/80 transition-colors"
                      >
                        <td className="py-3 px-4 font-mono font-semibold text-ink select-all">
                          {inv.invoice_number}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap text-ink">
                          {inv.invoice_date || '—'}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          {getMarketplaceBadge(inv.seller_account || inv.marketplace)}
                        </td>
                        <td className="py-3 px-4 text-outline font-medium">
                          {inv.seller_account || 'default'}
                        </td>
                        <td className="py-3 px-4 font-mono text-ink">
                          {inv.sku} (x{inv.quantity || 1})
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-ink">
                          {currencyFull(inv.invoice_amount)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-ink">
                          {currencyFull(inv.net_payable)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-emerald-700">
                          {currencyFull(inv.amount_received)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-rose-700">
                          {currencyFull(Number(inv.net_payable || 0) - Number(inv.amount_received || 0))}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <span
                            className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold border ${
                              inv.status === 'Partial'
                                ? 'bg-amber-50 text-amber-700 border-amber-200'
                                : 'bg-rose-50 text-rose-700 border-rose-200'
                            }`}
                          >
                            {inv.status || 'Pending'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Invoices Pagination */}
            {invoicesPagination.pages > 1 && (
              <div className="flex items-center justify-between border-t border-border px-4 py-3 bg-surface-container-low text-xs">
                <span className="text-outline">
                  Showing page {invoicesPagination.page} of {invoicesPagination.pages} ({num(invoicesPagination.total)} total invoices)
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={invoicesPagination.page <= 1 || invoicesLoading}
                    onClick={() => loadInvoices(1)}
                    className="rounded px-2 py-1 text-ink hover:bg-surface-container disabled:opacity-40"
                    title="First page"
                  >
                    «
                  </button>
                  <button
                    type="button"
                    disabled={invoicesPagination.page <= 1 || invoicesLoading}
                    onClick={() => loadInvoices(invoicesPagination.page - 1)}
                    className="rounded px-2.5 py-1 text-ink hover:bg-surface-container disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="px-2 font-semibold text-ink">
                    {invoicesPagination.page} / {invoicesPagination.pages}
                  </span>
                  <button
                    type="button"
                    disabled={invoicesPagination.page >= invoicesPagination.pages || invoicesLoading}
                    onClick={() => loadInvoices(invoicesPagination.page + 1)}
                    className="rounded px-2.5 py-1 text-ink hover:bg-surface-container disabled:opacity-40"
                  >
                    Next
                  </button>
                  <button
                    type="button"
                    disabled={invoicesPagination.page >= invoicesPagination.pages || invoicesLoading}
                    onClick={() => loadInvoices(invoicesPagination.pages)}
                    className="rounded px-2 py-1 text-ink hover:bg-surface-container disabled:opacity-40"
                    title="Last page"
                  >
                    »
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Order Detail Drawer */}
      {selectedOrderItemId && (
        <OrderDetailDrawer
          orderItemId={selectedOrderItemId}
          onClose={() => setSelectedOrderItemId(null)}
        />
      )}
    </div>
  );
}
