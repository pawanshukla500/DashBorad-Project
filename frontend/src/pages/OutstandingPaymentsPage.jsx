import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  fetchOutstandingSummary,
  fetchOutstandingOrders,
  fetchOutstandingInvoices,
  fetchOutstandingConfig,
  updateOutstandingConfig,
} from '../api/client';
import OrderDetailDrawer, { OrderIdCell } from '../components/OrderDetailDrawer';
import EmptyState from '../components/EmptyState';
import MarketplaceLogo from '../components/MarketplaceLogo';
import { num } from '../utils/format';
import { exportXlsx } from '../utils/exportXlsx';

// Currency formatter for standard Indian Rupees (audit precision without lossy rounding)
const formatCurrency = (val) => {
  const numVal = Number(val || 0);
  const formatted = Math.abs(numVal).toLocaleString('en-IN', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  });
  return numVal < 0 ? `-₹${formatted}` : `₹${formatted}`;
};

export default function OutstandingPaymentsPage() {
  const [searchParams] = useSearchParams();
  const urlChannel = searchParams.get('channel') || null;
  const urlAccount = searchParams.get('account') || null;

  // Summary Data State
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [summaryError, setSummaryError] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [expandedChannels, setExpandedChannels] = useState({
    myntra: true,
    ...(urlChannel ? { [urlChannel]: true } : {}),
  });

  // Config Modal State
  const [configOpen, setConfigOpen] = useState(false);
  const [configs, setConfigs] = useState([]);
  const [configLoading, setConfigLoading] = useState(false);
  const [savingConfigKey, setSavingConfigKey] = useState(null);

  // Drilldown selection state
  const [selectedChannel, setSelectedChannel] = useState(urlChannel); // e.g. 'myntra', 'flipkart'
  const [selectedAccount, setSelectedAccount] = useState(urlAccount); // e.g. 'myntra_ej', 'myntra_vb'
  const [activeDrilldownTab, setActiveDrilldownTab] = useState('orders'); // 'orders' | 'returns' | 'invoices'

  // Orders Table State
  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersPagination, setOrdersPagination] = useState({ page: 1, limit: 50, total: 0, pages: 1 });
  const [orderSearch, setOrderSearch] = useState('');
  const [agingFilter, setAgingFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // Invoices Table State
  const [invoices, setInvoices] = useState([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoicesPagination, setInvoicesPagination] = useState({ page: 1, limit: 50, total: 0, pages: 1 });
  const [invoiceSearch, setInvoiceSearch] = useState('');

  // Drawer
  const [selectedOrderItemId, setSelectedOrderItemId] = useState(null);

  // 1. Fetch Outstanding Summary
  const loadSummary = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) setIsRefreshing(true);
    else setLoading(true);
    setSummaryError(null);
    try {
      const res = await fetchOutstandingSummary();
      if (res) {
        setData(res);
      }
    } catch (err) {
      console.error('Failed to load outstanding summary', err);
      setSummaryError(err?.response?.data?.error || err?.message || 'Could not load outstanding payments.');
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  // Sync URL search params when they change and auto-scroll to drilldown
  useEffect(() => {
    if (urlChannel) {
      setSelectedChannel(urlChannel);
      setExpandedChannels(prev => ({ ...prev, [urlChannel]: true }));
    }
    if (urlAccount) {
      setSelectedAccount(urlAccount);
    }
    if (urlChannel || urlAccount) {
      const timer = setTimeout(() => {
        const el = document.getElementById('outstanding-drilldown-section');
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [urlChannel, urlAccount]);

  // 2. Load Configs when modal opens
  const openConfigModal = async () => {
    setConfigOpen(true);
    setConfigLoading(true);
    try {
      const res = await fetchOutstandingConfig();
      if (res?.success) {
        setConfigs(res.data || []);
      }
    } catch (e) {
      console.error('Failed to fetch config', e);
    } finally {
      setConfigLoading(false);
    }
  };

  const handleUpdateConfig = async (channelKey, field, val) => {
    setSavingConfigKey(channelKey);
    try {
      const payload = { [field]: Number(val) };
      await updateOutstandingConfig(channelKey, payload);
      setConfigs(prev => prev.map(c => (c.channel_key === channelKey ? { ...c, ...payload } : c)));
      await loadSummary();
    } catch (e) {
      console.error('Failed to update config', e);
    } finally {
      setSavingConfigKey(null);
    }
  };

  // 3. Fetch Orders / Returns Drilldown
  const loadOrders = useCallback(async (page = 1) => {
    if (activeDrilldownTab === 'invoices') return;
    setOrdersLoading(true);
    try {
      const res = await fetchOutstandingOrders({
        marketplace: selectedChannel || undefined,
        seller_account: selectedAccount || undefined,
        aging_bucket: agingFilter || undefined,
        status: statusFilter || undefined,
        search: orderSearch ? orderSearch.trim() : undefined,
        type: activeDrilldownTab === 'returns' ? 'returns' : 'unsettled',
        page,
        pageSize: ordersPagination.limit,
      });
      if (res) {
        setOrders(res.data || []);
        const total = Number(res.total || 0);
        const limit = Number(res.pageSize || ordersPagination.limit);
        const curPage = Number(res.page || page);
        setOrdersPagination({ page: curPage, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });
      }
    } catch (e) {
      console.error('Failed to load orders', e);
    } finally {
      setOrdersLoading(false);
    }
  }, [selectedChannel, selectedAccount, agingFilter, statusFilter, orderSearch, activeDrilldownTab, ordersPagination.limit]);

  useEffect(() => {
    if (activeDrilldownTab === 'orders' || activeDrilldownTab === 'returns') {
      loadOrders(1);
    }
  }, [selectedChannel, selectedAccount, agingFilter, statusFilter, activeDrilldownTab]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      loadOrders(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [orderSearch]);

  // 4. Fetch Invoices Drilldown
  const loadInvoices = useCallback(async (page = 1) => {
    setInvoicesLoading(true);
    try {
      const res = await fetchOutstandingInvoices({
        marketplace: selectedChannel || undefined,
        search: invoiceSearch ? invoiceSearch.trim() : undefined,
        page,
        pageSize: invoicesPagination.limit,
      });
      if (res) {
        setInvoices(res.data || []);
        const total = Number(res.total || 0);
        const limit = Number(res.pageSize || invoicesPagination.limit);
        const curPage = Number(res.page || page);
        setInvoicesPagination({ page: curPage, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });
      }
    } catch (e) {
      console.error('Failed to load invoices', e);
    } finally {
      setInvoicesLoading(false);
    }
  }, [selectedChannel, invoiceSearch, invoicesPagination.limit]);

  useEffect(() => {
    if (activeDrilldownTab === 'invoices') {
      loadInvoices(1);
    }
  }, [activeDrilldownTab, selectedChannel, invoiceSearch]);

  // Toggle account expansion for a channel
  const toggleExpand = (channelKey) => {
    setExpandedChannels(prev => ({
      ...prev,
      [channelKey]: !prev[channelKey],
    }));
  };

  const toggleAllAccounts = () => {
    const allExpanded = b2cChannels.every(c => !c.has_accounts || expandedChannels[c.channel_key]);
    const nextState = {};
    b2cChannels.forEach(c => {
      if (c.has_accounts) {
        nextState[c.channel_key] = !allExpanded;
      }
    });
    setExpandedChannels(prev => ({ ...prev, ...nextState }));
  };

  // Export D2C Excel
  const handleExportD2C = async () => {
    if (!data?.d2c?.vendors) return;
    const today = new Date().toISOString().slice(0, 10);
    const headers = ['Vendors', 'Settled Not Paid (Rs)', 'Settled Adjusted (Rs)', 'Total (Rs)', 'OverDue (Rs)', 'Due (In Grace) (Rs)', 'Upcoming (Rs)'];
    const rows = data.d2c.vendors.map(v => [
      v.vendor_name,
      v.settled_not_paid,
      v.settled_adjusted,
      v.total,
      v.overdue,
      v.due_in_grace,
      v.upcoming,
    ]);
    rows.push([
      'Total',
      data.d2c.total.settled_not_paid,
      data.d2c.total.settled_adjusted,
      data.d2c.total.total,
      data.d2c.total.overdue,
      data.d2c.total.due_in_grace,
      data.d2c.total.upcoming,
    ]);

    await exportXlsx(
      [{ sheetName: 'D2C Outstanding', headers, rows, colWidths: [20, 20, 20, 20, 18, 18, 18] }],
      `D2C_Outstanding_Payments_${today}`
    );
  };

  // Export All Workbook
  const handleExportFull = async () => {
    if (!data) return;
    const today = new Date().toISOString().slice(0, 10);
    const b2cHeaders = [
      'Channels',
      'Total Orders (Rs)',
      'Orders Count',
      'Returns (Rs)',
      'Returns Count',
      'Marketplace Fees (Rs)',
      'Payment Received (Rs)',
      'Net Outstanding (Rs)',
      'OverDue (>60d) (Rs)',
      'Due In Grace (Rs)',
      'Upcoming (Rs)',
    ];
    const b2cRows = [];
    for (const c of data.b2c?.channels || []) {
      b2cRows.push([
        c.channel_name,
        c.total_orders_amount || 0,
        c.total_orders_count || 0,
        c.returns_amount || 0,
        c.returns_orders_count || 0,
        c.marketplace_fees || 0,
        c.payment_received || 0,
        c.total || 0,
        c.overdue || 0,
        c.due_in_grace || 0,
        c.upcoming || 0,
      ]);
      if (c.accounts && c.accounts.length > 0) {
        for (const a of c.accounts) {
          b2cRows.push([
            `  - ${a.account_name}${a.seller_id ? ` (ID: ${a.seller_id})` : ''}`,
            a.total_orders_amount || 0,
            a.total_orders_count || 0,
            a.returns_amount || 0,
            a.returns_orders_count || 0,
            a.marketplace_fees || 0,
            a.payment_received || 0,
            a.total || 0,
            a.overdue || 0,
            a.due_in_grace || 0,
            a.upcoming || 0,
          ]);
        }
      }
    }
    if (data.b2c?.total) {
      const t = data.b2c.total;
      b2cRows.push([
        'Total Consolidated',
        t.total_orders_amount || 0,
        t.total_orders_count || 0,
        t.returns_amount || 0,
        t.returns_orders_count || 0,
        t.marketplace_fees || 0,
        t.payment_received || 0,
        t.total || 0,
        t.overdue || 0,
        t.due_in_grace || 0,
        t.upcoming || 0,
      ]);
    }

    const d2cHeaders = ['Vendors', 'Settled Not Paid (Rs)', 'Settled Adjusted (Rs)', 'Total (Rs)', 'OverDue (Rs)', 'Due (In Grace) (Rs)', 'Upcoming (Rs)'];
    const d2cRows = (data.d2c?.vendors || []).map(v => [
      v.vendor_name,
      v.settled_not_paid,
      v.settled_adjusted,
      v.total,
      v.overdue,
      v.due_in_grace,
      v.upcoming,
    ]);
    if (data.d2c?.total) {
      const t = data.d2c.total;
      d2cRows.push(['Total', t.settled_not_paid, t.settled_adjusted, t.total, t.overdue, t.due_in_grace, t.upcoming]);
    }

    await exportXlsx(
      [
        { sheetName: 'B2C Outstanding', headers: b2cHeaders, rows: b2cRows, colWidths: [28, 20, 14, 18, 14, 20, 22, 20, 18, 18, 18] },
        { sheetName: 'D2C Outstanding', headers: d2cHeaders, rows: d2cRows, colWidths: [20, 20, 20, 20, 18, 18, 18] },
      ],
      `Outstanding_Payments_Consolidated_${today}`
    );
  };

  const kpis = data?.kpis || {};
  const b2cChannels = data?.b2c?.channels || [];
  const b2cTotal = data?.b2c?.total || {};
  const d2cVendors = data?.d2c?.vendors || [];
  const d2cTotal = data?.d2c?.total || {};

  // Aging totals across all channels
  const totalAging0to30 = useMemo(() => {
    return b2cChannels.reduce((sum, c) => sum + (c.due_in_grace || 0) + (c.upcoming || 0), 0);
  }, [b2cChannels]);

  const totalAging31to60 = useMemo(() => {
    return b2cChannels.reduce((sum, c) => sum + (c.overdue_31_60 || 0), 0);
  }, [b2cChannels]);

  const totalAging60Plus = useMemo(() => {
    return b2cChannels.reduce((sum, c) => sum + (c.overdue_60_plus || c.overdue || 0), 0);
  }, [b2cChannels]);

  return (
    <div className="space-y-6 pb-20">
      {/* 1. Header with Breadcrumb Badge, Title, Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pt-1">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-container px-2.5 py-0.5 text-[11px] font-semibold text-on-primary-container border border-primary/20">
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
              Live AR / AP Ledger
            </span>
            <span className="text-xs text-outline font-mono">
              Pure Live Database Mode • {b2cChannels.length} Channels Integrated
            </span>
          </div>
          <h1 className="text-2xl font-display font-bold text-ink tracking-tight">Outstanding Payments</h1>
          <p className="text-body-sm text-secondary mt-0.5">
            Audit-grade marketplace receivables, fee reconciliation & aging settlement matrix
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          <button
            type="button"
            onClick={openConfigModal}
            className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary-container px-3.5 py-2 text-xs font-semibold text-on-primary-container hover:bg-primary-container/80 transition-colors shadow-2xs focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <span className="material-symbols-outlined text-[16px]">settings</span>
            Config Cycles
          </button>

          <button
            type="button"
            onClick={handleExportFull}
            disabled={!data || loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3.5 py-2 text-xs font-semibold text-secondary hover:text-ink hover:bg-surface-container-low transition-colors shadow-2xs disabled:opacity-50"
            title="Download Consolidated Excel Report"
          >
            <span className="material-symbols-outlined text-[16px] text-emerald-600">table_view</span>
            Export Excel
          </button>

          <button
            type="button"
            onClick={() => loadSummary(true)}
            disabled={loading || isRefreshing}
            className="inline-flex items-center justify-center h-8 w-8 rounded-lg border border-border bg-surface text-secondary hover:text-ink hover:bg-surface-container-low transition-colors shadow-2xs disabled:opacity-50"
            title="Refresh Ledger"
          >
            <span className={`material-symbols-outlined text-[16px] ${isRefreshing ? 'animate-spin text-primary' : ''}`}>
              refresh
            </span>
          </button>
        </div>
      </div>

      {summaryError && (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50/80 p-4 text-body-sm text-rose-800 flex items-start gap-3">
          <span className="material-symbols-outlined text-rose-600 shrink-0">error</span>
          <div className="flex-1">
            <p className="font-semibold">Unable to load outstanding payments ledger</p>
            <p className="mt-0.5 text-xs text-rose-700">{summaryError}</p>
          </div>
          <button
            type="button"
            onClick={() => loadSummary()}
            className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* 2. Top 5 Accounts Payable & Receivable KPI Cards */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-5">
        {/* TOTAL ORDERS (Gross GMV) */}
        <div className="rounded-xl border border-sky-200/80 bg-surface p-4 flex flex-col justify-between shadow-xs hover:border-sky-300 transition-all">
          <div className="flex items-center justify-between">
            <span className="text-label-md font-semibold uppercase text-secondary tracking-wider">
              TOTAL ORDERS
            </span>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-50 text-sky-600 border border-sky-100">
              <span className="material-symbols-outlined text-[18px]">shopping_bag</span>
            </div>
          </div>
          <div className="mt-3">
            <span className="text-financial-lg font-bold text-ink tabular-nums tracking-tight">
              {data?.kpis ? formatCurrency(kpis.total_orders || kpis.unsettled) : '—'}
            </span>
            <div className="flex items-center justify-between text-body-sm text-outline mt-1 font-mono text-[11px]">
              <span>Gross Order Value</span>
              {b2cTotal.total_orders_count > 0 && (
                <span className="text-secondary font-medium">{num(b2cTotal.total_orders_count)} orders</span>
              )}
            </div>
          </div>
        </div>

        {/* RETURNS & REFUNDS */}
        <div className="rounded-xl border border-rose-200/80 bg-surface p-4 flex flex-col justify-between shadow-xs hover:border-rose-300 transition-all">
          <div className="flex items-center justify-between">
            <span className="text-label-md font-semibold uppercase text-secondary tracking-wider">
              RETURNS
            </span>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-50 text-rose-600 border border-rose-100">
              <span className="material-symbols-outlined text-[18px]">assignment_return</span>
            </div>
          </div>
          <div className="mt-3">
            <span className="text-financial-lg font-bold text-ink tabular-nums tracking-tight">
              {data?.kpis ? formatCurrency(kpis.returns) : '—'}
            </span>
            <div className="flex items-center justify-between text-body-sm text-outline mt-1 font-mono text-[11px]">
              <span>Customer & RTO Refunds</span>
              {b2cTotal.returns_orders_count > 0 && (
                <span className="text-rose-600 font-medium">{num(b2cTotal.returns_orders_count)} returns</span>
              )}
            </div>
          </div>
        </div>

        {/* MARKETPLACE FEES */}
        <div className="rounded-xl border border-purple-200/80 bg-surface p-4 flex flex-col justify-between shadow-xs hover:border-purple-300 transition-all">
          <div className="flex items-center justify-between">
            <span className="text-label-md font-semibold uppercase text-secondary tracking-wider">
              MARKETPLACE FEES
            </span>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-50 text-purple-600 border border-purple-100">
              <span className="material-symbols-outlined text-[18px]">receipt_long</span>
            </div>
          </div>
          <div className="mt-3">
            <span className="text-financial-lg font-bold text-ink tabular-nums tracking-tight">
              {data?.kpis ? formatCurrency(kpis.marketplace_fees) : '—'}
            </span>
            <div className="text-body-sm text-outline mt-1 font-mono text-[11px]">
              Commissions, shipping & taxes
            </div>
          </div>
        </div>

        {/* PAYMENT RECEIVED */}
        <div className="rounded-xl border border-emerald-200/80 bg-surface p-4 flex flex-col justify-between shadow-xs hover:border-emerald-300 transition-all">
          <div className="flex items-center justify-between">
            <span className="text-label-md font-semibold uppercase text-secondary tracking-wider">
              PAYMENT RECEIVED
            </span>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 border border-emerald-100">
              <span className="material-symbols-outlined text-[18px]">payments</span>
            </div>
          </div>
          <div className="mt-3">
            <span className="text-financial-lg font-bold text-ink tabular-nums tracking-tight">
              {data?.kpis ? formatCurrency(kpis.payment_received) : '—'}
            </span>
            <div className="text-body-sm text-outline mt-1 font-mono text-[11px]">
              Direct bank payouts settled
            </div>
          </div>
        </div>

        {/* NET OUTSTANDING (Brand Burgundy Hero Card) */}
        <div className="rounded-xl bg-primary text-on-primary p-4 flex flex-col justify-between shadow-md hover:shadow-lg transition-all border border-primary/20 relative overflow-hidden">
          <div className="absolute -right-4 -bottom-4 w-24 h-24 bg-white/5 rounded-full pointer-events-none" />
          <div className="flex items-center justify-between">
            <span className="text-label-md font-bold uppercase text-white/80 tracking-wider">
              TOTAL OUTSTANDING
            </span>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 text-white backdrop-blur-xs">
              <span className="material-symbols-outlined text-[18px]">account_balance_wallet</span>
            </div>
          </div>
          <div className="mt-3">
            <span className="text-financial-lg font-extrabold text-white tabular-nums tracking-tight">
              {data?.kpis ? formatCurrency(kpis.total_outstanding) : '—'}
            </span>
            <div className="flex items-center justify-between text-body-sm text-white/80 mt-1 font-mono text-[11px]">
              <span>Net Receivable Balance</span>
              {totalAging60Plus > 0 && (
                <span className="bg-white/20 text-white px-1.5 py-0.2 rounded text-[10px] font-semibold">
                  {formatCurrency(totalAging60Plus)} overdue
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 3. Reconciliation Equation & Aging Ribbon */}
      <div className="rounded-xl border border-border bg-surface p-3.5 shadow-xs flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        {/* Accounting Equation */}
        <div className="flex items-center gap-1.5 flex-wrap text-xs text-secondary font-medium">
          <span className="font-semibold text-ink uppercase tracking-wider text-[11px] mr-1">Formula:</span>
          <span className="bg-sky-50 text-sky-800 border border-sky-200 px-2.5 py-1 rounded-md font-mono font-medium shadow-2xs">
            Total Orders
          </span>
          <span className="text-outline font-bold">−</span>
          <span className="bg-rose-50 text-rose-800 border border-rose-200 px-2.5 py-1 rounded-md font-mono font-medium shadow-2xs">
            Returns
          </span>
          <span className="text-outline font-bold">−</span>
          <span className="bg-purple-50 text-purple-800 border border-purple-200 px-2.5 py-1 rounded-md font-mono font-medium shadow-2xs">
            Marketplace Fees
          </span>
          <span className="text-outline font-bold">−</span>
          <span className="bg-emerald-50 text-emerald-800 border border-emerald-200 px-2.5 py-1 rounded-md font-mono font-medium shadow-2xs">
            Payment Received
          </span>
          <span className="text-outline font-bold">=</span>
          <span className="bg-primary text-on-primary px-3 py-1 rounded-md font-mono font-bold shadow-xs">
            Outstanding
          </span>
        </div>

        {/* Aging Buckets Mini Pills */}
        <div className="flex items-center gap-2 flex-wrap text-xs font-mono">
          <span className="text-outline text-[11px]">Aging Tiers:</span>
          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            &lt;30d: {formatCurrency(totalAging0to30)}
          </span>
          <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 border border-amber-200 px-2 py-0.5 text-amber-700">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            31-60d: {formatCurrency(totalAging31to60)}
          </span>
          <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 border border-rose-200 px-2 py-0.5 text-rose-700 font-bold">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
            &gt;60d: {formatCurrency(totalAging60Plus)}
          </span>
        </div>
      </div>

      {/* 4. Section 1: B2C Marketplaces Table */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden shadow-xs">
        {/* Table Header Controls */}
        <div className="px-5 py-3 border-b border-border flex items-center justify-between bg-surface-container-low flex-wrap gap-2">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary-container text-on-primary-container">
              <span className="material-symbols-outlined text-[18px]">storefront</span>
            </div>
            <div>
              <h2 className="text-sm font-bold text-ink">B2C Marketplaces</h2>
              <p className="text-[11px] text-outline">
                Click any row or account to filter unsettled orders and audit aging
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={toggleAllAccounts}
              className="text-xs font-medium text-primary hover:text-indigo-dark transition-colors inline-flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-[14px]">unfold_more</span>
              Toggle Sub-Accounts
            </button>
            <span className="text-xs text-outline font-medium">
              {b2cChannels.length} Channels Integrated
            </span>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-border bg-surface-container-low text-secondary text-label-md uppercase font-semibold">
                <th className="py-3 px-4 min-w-[220px]">Channels & Accounts</th>
                <th className="py-3 px-4 text-right">Total Orders</th>
                <th className="py-3 px-4 text-right">Returns</th>
                <th className="py-3 px-4 text-right">Marketplace Fees</th>
                <th className="py-3 px-4 text-right">Payment Received</th>
                <th className="py-3 px-4 text-right font-bold text-ink">Net Outstanding</th>
                <th className="py-3 px-4 text-right">Overdue (&gt;60d)</th>
                <th className="py-3 px-4 text-center">Status</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border text-ink">
              {b2cChannels.map(channel => {
                const isExpanded = expandedChannels[channel.channel_key];
                const isChannelSelected = selectedChannel === channel.channel_key && !selectedAccount;

                // Status calculation
                let statusBadge = null;
                if ((channel.total_orders_amount || 0) === 0) {
                  statusBadge = (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-surface-container text-outline border border-border">
                      No Orders
                    </span>
                  );
                } else if ((channel.total || 0) === 0) {
                  statusBadge = (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      Settled
                    </span>
                  );
                } else if ((channel.overdue || 0) > 0) {
                  statusBadge = (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">
                      <span className="h-1.5 w-1.5 rounded-full bg-rose-600 animate-pulse" />
                      Overdue
                    </span>
                  );
                } else {
                  statusBadge = (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      Current
                    </span>
                  );
                }

                return (
                  <Fragment key={channel.channel_key}>
                    {/* Main Channel Row */}
                    <tr
                      className={`group transition-colors ${
                        isChannelSelected
                          ? 'bg-primary-container/70 font-medium'
                          : 'hover:bg-surface-container-low'
                      }`}
                    >
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2.5">
                          {channel.has_accounts ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleExpand(channel.channel_key);
                              }}
                              className="flex h-6 w-6 items-center justify-center rounded-md text-outline hover:text-ink hover:bg-surface-container transition-colors"
                              title={isExpanded ? 'Collapse Accounts' : 'Expand Accounts'}
                            >
                              <span className="material-symbols-outlined text-[16px]">
                                {isExpanded ? 'expand_more' : 'chevron_right'}
                              </span>
                            </button>
                          ) : (
                            <span className="w-6" />
                          )}

                          <button
                            type="button"
                            onClick={() => {
                              setSelectedChannel(selectedChannel === channel.channel_key ? null : channel.channel_key);
                              setSelectedAccount(null);
                            }}
                            className="flex items-center gap-2.5 text-left font-semibold text-ink hover:text-primary transition-colors"
                          >
                            <MarketplaceLogo
                              marketplace={channel.channel_key}
                              size="sm"
                              className="shadow-2xs"
                            />
                            <span className="text-sm">{channel.channel_name}</span>
                          </button>
                        </div>
                      </td>

                      {/* Total Orders */}
                      <td className="py-3 px-4 text-right tabular-nums text-ink">
                        <div className="font-medium">{formatCurrency(channel.total_orders_amount || 0)}</div>
                        {(channel.total_orders_count || 0) > 0 && (
                          <div className="text-[11px] text-outline font-mono">
                            {channel.total_orders_count.toLocaleString('en-IN')} orders
                          </div>
                        )}
                      </td>

                      {/* Returns */}
                      <td className="py-3 px-4 text-right tabular-nums text-ink">
                        <div className="font-medium">{formatCurrency(channel.returns_amount || 0)}</div>
                        {(channel.returns_orders_count || 0) > 0 && (
                          <div className="text-[11px] text-outline font-mono">
                            {channel.returns_orders_count.toLocaleString('en-IN')} returns
                          </div>
                        )}
                      </td>

                      {/* Marketplace Fees */}
                      <td className="py-3 px-4 text-right tabular-nums text-secondary font-medium">
                        {formatCurrency(channel.marketplace_fees || 0)}
                      </td>

                      {/* Payment Received */}
                      <td className="py-3 px-4 text-right tabular-nums text-ink font-medium">
                        {formatCurrency(channel.payment_received || 0)}
                      </td>

                      {/* Net Outstanding */}
                      <td className="py-3 px-4 text-right tabular-nums font-bold text-ink">
                        <span className={Number(channel.total || 0) > 0 ? 'text-ink' : 'text-outline'}>
                          {formatCurrency(channel.total || 0)}
                        </span>
                      </td>

                      {/* Overdue (>60d) */}
                      <td className="py-3 px-4 text-right tabular-nums">
                        {Number(channel.overdue || 0) > 0 ? (
                          <span className="font-bold text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200">
                            {formatCurrency(channel.overdue || 0)}
                          </span>
                        ) : (
                          <span className="text-outline">₹0</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="py-3 px-4 text-center">
                        {statusBadge}
                      </td>

                      {/* Action */}
                      <td className="py-3 px-4 text-center">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedChannel(channel.channel_key);
                            setSelectedAccount(null);
                            const el = document.getElementById('outstanding-drilldown-section');
                            if (el) el.scrollIntoView({ behavior: 'smooth' });
                          }}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-primary hover:bg-primary-container transition-colors"
                          title="Drilldown to orders"
                        >
                          <span>Audit</span>
                          <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                        </button>
                      </td>
                    </tr>

                    {/* Sub-account rows (e.g. Myntra EJ and Myntra VB) */}
                    {channel.has_accounts && isExpanded && channel.accounts.map(acc => {
                      const isAccSelected = selectedAccount === acc.account_key;

                      return (
                        <tr
                          key={acc.account_key}
                          className={`transition-colors border-l-4 ${
                            isAccSelected
                              ? 'border-primary bg-primary-container/60 font-medium'
                              : 'border-primary/30 bg-surface-container-low hover:bg-surface-container'
                          }`}
                        >
                          <td className="py-2.5 px-4 pl-12">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedChannel(channel.channel_key);
                                setSelectedAccount(selectedAccount === acc.account_key ? null : acc.account_key);
                              }}
                              className="flex items-center gap-2 text-left text-sm text-secondary hover:text-primary font-medium transition-colors"
                            >
                              <span className="material-symbols-outlined text-[14px] text-outline">subdirectory_arrow_right</span>
                              <MarketplaceLogo
                                marketplace={channel.channel_key}
                                account={acc.account_key}
                                size="xs"
                                showAccountBadge={true}
                              />
                              <span>{acc.account_name}</span>
                              <span className="rounded bg-surface px-1.5 py-0.2 text-[10px] font-mono text-outline border border-border">
                                ID: {acc.seller_id}
                              </span>
                            </button>
                          </td>

                          <td className="py-2.5 px-4 text-right tabular-nums text-secondary text-sm">
                            <div>{formatCurrency(acc.total_orders_amount || 0)}</div>
                            {(acc.total_orders_count || 0) > 0 && (
                              <div className="text-[10px] text-outline font-mono">
                                {acc.total_orders_count.toLocaleString('en-IN')} orders
                              </div>
                            )}
                          </td>

                          <td className="py-2.5 px-4 text-right tabular-nums text-secondary text-sm">
                            <div>{formatCurrency(acc.returns_amount || 0)}</div>
                            {(acc.returns_orders_count || 0) > 0 && (
                              <div className="text-[10px] text-outline font-mono">
                                {acc.returns_orders_count.toLocaleString('en-IN')} returns
                              </div>
                            )}
                          </td>

                          <td className="py-2.5 px-4 text-right tabular-nums text-secondary text-sm">
                            {formatCurrency(acc.marketplace_fees || 0)}
                          </td>

                          <td className="py-2.5 px-4 text-right tabular-nums text-ink text-sm">
                            {formatCurrency(acc.payment_received || 0)}
                          </td>

                          <td className="py-2.5 px-4 text-right tabular-nums font-bold text-ink text-sm">
                            {formatCurrency(acc.total || 0)}
                          </td>

                          <td className="py-2.5 px-4 text-right tabular-nums text-sm">
                            {Number(acc.overdue || 0) > 0 ? (
                              <span className="font-bold text-rose-700 bg-rose-50 px-1.5 py-0.2 rounded border border-rose-200">
                                {formatCurrency(acc.overdue || 0)}
                              </span>
                            ) : (
                              <span className="text-outline">₹0</span>
                            )}
                          </td>

                          <td className="py-2.5 px-4 text-center">
                            {(acc.overdue || 0) > 0 ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">
                                Overdue
                              </span>
                            ) : (acc.total || 0) > 0 ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                                Pending
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                                Settled
                              </span>
                            )}
                          </td>

                          <td className="py-2.5 px-4 text-center">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedChannel(channel.channel_key);
                                setSelectedAccount(acc.account_key);
                                const el = document.getElementById('outstanding-drilldown-section');
                                if (el) el.scrollIntoView({ behavior: 'smooth' });
                              }}
                              className="text-outline hover:text-primary text-xs font-medium"
                            >
                              Filter
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}

              {/* B2C Consolidated Summary Row */}
              <tr className="border-t-2 border-border bg-surface-container font-bold text-ink">
                <td className="py-3 px-4 font-bold text-ink">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary text-[18px]">functions</span>
                    <span>Total Consolidated</span>
                  </div>
                </td>
                <td className="py-3 px-4 text-right tabular-nums">
                  <div>{formatCurrency(b2cTotal.total_orders_amount || 0)}</div>
                  {(b2cTotal.total_orders_count || 0) > 0 && (
                    <div className="text-[10px] text-outline font-mono">
                      {b2cTotal.total_orders_count.toLocaleString('en-IN')} orders
                    </div>
                  )}
                </td>
                <td className="py-3 px-4 text-right tabular-nums">
                  <div>{formatCurrency(b2cTotal.returns_amount || 0)}</div>
                  {(b2cTotal.returns_orders_count || 0) > 0 && (
                    <div className="text-[10px] text-outline font-mono">
                      {b2cTotal.returns_orders_count.toLocaleString('en-IN')} returns
                    </div>
                  )}
                </td>
                <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(b2cTotal.marketplace_fees || 0)}</td>
                <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(b2cTotal.payment_received || 0)}</td>
                <td className="py-3 px-4 text-right tabular-nums font-extrabold text-primary text-base">
                  {formatCurrency(b2cTotal.total || 0)}
                </td>
                <td className="py-3 px-4 text-right tabular-nums font-bold text-rose-700">
                  {formatCurrency(b2cTotal.overdue || 0)}
                </td>
                <td className="py-3 px-4 text-center">
                  <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-primary-container text-on-primary-container border border-primary/20">
                    Consolidated
                  </span>
                </td>
                <td className="py-3 px-4 text-center text-xs text-outline font-mono">
                  All
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Table Footer with Filter Badge */}
        <div className="px-5 py-2.5 border-t border-border bg-surface-container-low flex items-center justify-between text-xs text-outline flex-wrap gap-2">
          <div>
            {selectedChannel ? (
              <span className="inline-flex items-center gap-1.5 font-semibold text-primary">
                <span className="material-symbols-outlined text-[15px]">filter_alt</span>
                Filtering by: {selectedChannel} {selectedAccount ? `(${selectedAccount})` : ''}
                <button
                  type="button"
                  onClick={() => {
                    setSelectedChannel(null);
                    setSelectedAccount(null);
                  }}
                  className="ml-1 text-secondary hover:text-ink underline text-[11px]"
                >
                  Clear Selection
                </button>
              </span>
            ) : (
              <span>Showing all {b2cChannels.length} integrated marketplace channels</span>
            )}
          </div>
          <div className="text-[11px] text-secondary font-mono">
            {b2cChannels.length} Marketplaces • 100% Real-Time Live Settlement Join
          </div>
        </div>
      </div>

      {/* 5. Section 2: D2C Vendors Table (Payment Gateways & Logistics) */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden shadow-xs">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between bg-surface-container-low">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-100 text-purple-700">
              <span className="material-symbols-outlined text-[18px]">public</span>
            </div>
            <div>
              <h2 className="text-sm font-bold text-ink">D2C Payment Gateways & Logistics</h2>
              <p className="text-[11px] text-outline">
                Direct-to-consumer gateways (PhonePe, Gokwik) & COD courier remittance (Ekart, Bluedart)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleExportD2C}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-semibold text-secondary hover:text-ink hover:bg-surface-container-low transition-colors shadow-2xs"
            title="Download D2C Report"
          >
            <span className="material-symbols-outlined text-[15px]">download</span>
            Export D2C
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-border bg-surface-container-low text-secondary text-label-md uppercase font-semibold">
                <th className="py-2.5 px-4 min-w-[200px]">Vendor / Gateway</th>
                <th className="py-2.5 px-4 text-right">Settled Not Paid</th>
                <th className="py-2.5 px-4 text-right">Settled Adjusted</th>
                <th className="py-2.5 px-4 text-right font-bold text-ink">Total Receivable</th>
                <th className="py-2.5 px-4 text-right">Overdue</th>
                <th className="py-2.5 px-4 text-right">Due (In Grace)</th>
                <th className="py-2.5 px-4 text-right">Upcoming</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border text-ink">
              {d2cVendors.map(vendor => (
                <tr key={vendor.vendor_key} className="hover:bg-surface-container-low transition-colors">
                  <td className="py-2.5 px-4 font-semibold text-ink flex items-center gap-2">
                    <span className="material-symbols-outlined text-[16px] text-outline">account_balance</span>
                    <span>{vendor.vendor_name}</span>
                  </td>
                  <td className="py-2.5 px-4 text-right tabular-nums text-ink">
                    {formatCurrency(vendor.settled_not_paid)}
                  </td>
                  <td className="py-2.5 px-4 text-right tabular-nums text-secondary">
                    {formatCurrency(vendor.settled_adjusted)}
                  </td>
                  <td className="py-2.5 px-4 text-right tabular-nums font-bold text-ink">
                    {formatCurrency(vendor.total)}
                  </td>
                  <td className="py-2.5 px-4 text-right tabular-nums text-ink">
                    {formatCurrency(vendor.overdue)}
                  </td>
                  <td className="py-2.5 px-4 text-right tabular-nums text-ink">
                    {formatCurrency(vendor.due_in_grace)}
                  </td>
                  <td className="py-2.5 px-4 text-right tabular-nums text-ink">
                    {formatCurrency(vendor.upcoming)}
                  </td>
                </tr>
              ))}

              {/* D2C Total Row */}
              <tr className="border-t-2 border-border bg-surface-container font-bold text-ink">
                <td className="py-2.5 px-4 font-bold">Total D2C</td>
                <td className="py-2.5 px-4 text-right tabular-nums">{formatCurrency(d2cTotal.settled_not_paid)}</td>
                <td className="py-2.5 px-4 text-right tabular-nums">{formatCurrency(d2cTotal.settled_adjusted)}</td>
                <td className="py-2.5 px-4 text-right tabular-nums font-extrabold">{formatCurrency(d2cTotal.total)}</td>
                <td className="py-2.5 px-4 text-right tabular-nums">{formatCurrency(d2cTotal.overdue)}</td>
                <td className="py-2.5 px-4 text-right tabular-nums">{formatCurrency(d2cTotal.due_in_grace)}</td>
                <td className="py-2.5 px-4 text-right tabular-nums">{formatCurrency(d2cTotal.upcoming)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* 6. Detailed Order & Invoice Drilldown Section */}
      <div id="outstanding-drilldown-section" className="rounded-xl border border-border bg-surface overflow-hidden shadow-xs">
        {/* Tab Selection */}
        <div className="px-5 py-3 border-b border-border bg-surface-container-low flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setActiveDrilldownTab('orders');
                setStatusFilter('');
                setAgingFilter('');
                setOrdersPagination(p => ({ ...p, page: 1 }));
              }}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                activeDrilldownTab === 'orders'
                  ? 'bg-primary text-on-primary shadow-xs'
                  : 'text-secondary hover:text-ink hover:bg-surface-container'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">receipt</span>
              Unsettled Delivered Orders {activeDrilldownTab === 'orders' ? `(${num(ordersPagination.total)})` : ''}
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveDrilldownTab('returns');
                setStatusFilter('');
                setAgingFilter('');
                setOrdersPagination(p => ({ ...p, page: 1 }));
              }}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                activeDrilldownTab === 'returns'
                  ? 'bg-rose-600 text-white shadow-xs'
                  : 'text-secondary hover:text-rose-700 hover:bg-rose-50'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">assignment_return</span>
              Returns & Cancellations {activeDrilldownTab === 'returns' ? `(${num(ordersPagination.total)})` : ''}
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveDrilldownTab('invoices');
                setStatusFilter('');
                setAgingFilter('');
              }}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                activeDrilldownTab === 'invoices'
                  ? 'bg-primary text-on-primary shadow-xs'
                  : 'text-secondary hover:text-ink hover:bg-surface-container'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">description</span>
              Pending Invoices ({num(invoicesPagination.total)})
            </button>
          </div>

          <div className="flex items-center gap-2 text-xs">
            {selectedChannel && (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-primary-container border border-primary/30 px-2.5 py-1 text-primary font-semibold capitalize shadow-2xs">
                <MarketplaceLogo marketplace={selectedChannel} size="xs" />
                <span>
                  {selectedChannel} {selectedAccount ? `· ${selectedAccount}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedChannel(null);
                    setSelectedAccount(null);
                  }}
                  className="hover:text-indigo-dark rounded p-0.5 transition-colors"
                  title="Clear channel filter"
                >
                  <span className="material-symbols-outlined text-[14px] block">close</span>
                </button>
              </span>
            )}
            {agingFilter && (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-50 border border-amber-200 px-2.5 py-1 text-amber-700 font-semibold shadow-2xs">
                <span>Tier: {agingFilter}</span>
                <button
                  type="button"
                  onClick={() => setAgingFilter('')}
                  className="hover:text-amber-900 rounded p-0.5 transition-colors"
                  title="Clear aging filter"
                >
                  <span className="material-symbols-outlined text-[14px] block">close</span>
                </button>
              </span>
            )}
          </div>
        </div>

        {/* Filter controls row */}
        <div className="p-4 border-b border-border bg-surface flex items-center justify-between flex-wrap gap-3">
          {activeDrilldownTab !== 'invoices' ? (
            <>
              <div className="relative flex-1 min-w-[240px] max-w-md">
                <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-outline text-[18px]">
                  search
                </span>
                <input
                  type="text"
                  value={orderSearch}
                  onChange={e => setOrderSearch(e.target.value)}
                  placeholder="Search Order ID, Item ID, or SKU..."
                  className="w-full pl-8 pr-8 py-1.5 text-xs rounded-lg border border-border bg-surface text-ink placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                {orderSearch && (
                  <button
                    type="button"
                    onClick={() => setOrderSearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-outline hover:text-secondary"
                  >
                    <span className="material-symbols-outlined text-[14px]">close</span>
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {/* Aging Bucket Dropdown (Unsettled Orders only) */}
                {activeDrilldownTab === 'orders' && (
                  <select
                    value={agingFilter}
                    onChange={e => setAgingFilter(e.target.value)}
                    className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-secondary focus:outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    <option value="">All Aging Tiers</option>
                    <option value="0-15">0-15 Days (Upcoming)</option>
                    <option value="16-30">16-30 Days (In Grace)</option>
                    <option value="31-60">31-60 Days (Aging Due)</option>
                    <option value="60+">60+ Days (High Overdue)</option>
                  </select>
                )}

                {/* Status Dropdown */}
                {activeDrilldownTab === 'returns' ? (
                  <select
                    value={statusFilter}
                    onChange={e => setStatusFilter(e.target.value)}
                    className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-secondary focus:outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    <option value="">All Return Statuses</option>
                    <option value="Cancelled">Cancelled</option>
                    <option value="RTO">RTO</option>
                    <option value="Return Initiated">Return Initiated</option>
                    <option value="Return Orders">Return Orders</option>
                  </select>
                ) : (
                  <select
                    value={statusFilter}
                    onChange={e => setStatusFilter(e.target.value)}
                    className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-secondary focus:outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    <option value="">All Active Statuses</option>
                    <option value="Delivered">Delivered</option>
                    <option value="SH">Shipped (SH)</option>
                    <option value="PK">Packed (PK)</option>
                  </select>
                )}

                {/* Page Size */}
                <select
                  value={ordersPagination.limit}
                  onChange={e => {
                    const limit = Number(e.target.value);
                    setOrdersPagination(p => ({ ...p, limit, page: 1 }));
                  }}
                  className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-secondary focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value={25}>25 / page</option>
                  <option value={50}>50 / page</option>
                  <option value={100}>100 / page</option>
                </select>
              </div>
            </>
          ) : (
            <div className="relative flex-1 min-w-[240px] max-w-md">
              <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-outline text-[18px]">
                search
              </span>
              <input
                type="text"
                value={invoiceSearch}
                onChange={e => setInvoiceSearch(e.target.value)}
                placeholder="Search invoice number, SKU, or notes..."
                className="w-full pl-8 pr-8 py-1.5 text-xs rounded-lg border border-border bg-surface text-ink placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              {invoiceSearch && (
                <button
                  type="button"
                  onClick={() => setInvoiceSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-outline hover:text-secondary"
                >
                  <span className="material-symbols-outlined text-[14px]">close</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Tab 1 & 2: Orders / Returns Drilldown Table */}
        {(activeDrilldownTab === 'orders' || activeDrilldownTab === 'returns') && (
          <div>
            {/* Informational Callout regarding Accounting Treatment */}
            <div
              className={`mx-4 mt-3 p-3 rounded-xl border flex items-center gap-2.5 text-xs shadow-2xs ${
                activeDrilldownTab === 'returns'
                  ? 'bg-rose-50/80 border-rose-200 text-rose-800'
                  : 'bg-sky-50/80 border-sky-200 text-sky-800'
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">
                {activeDrilldownTab === 'returns' ? 'assignment_return' : 'info'}
              </span>
              <div className="leading-relaxed">
                {activeDrilldownTab === 'returns' ? (
                  <>
                    <strong>Returns & Cancellations Accounting Treatment:</strong> These orders were cancelled or returned by customer/courier. <strong>No payment will be received</strong> for these orders. They are accounted for under Returns and deducted from gross revenue (Net Due = ₹0).
                  </>
                ) : (
                  <>
                    <strong>Unsettled Delivered Orders:</strong> Active orders dispatched and delivered to customers that are awaiting bank settlement from marketplaces. All cancelled orders and returns are strictly excluded from this receivable ledger.
                  </>
                )}
              </div>
            </div>

            {ordersLoading ? (
              <div className="flex min-h-[220px] items-center justify-center">
                <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-container-low px-5 py-3 text-xs font-semibold text-secondary shadow-xs">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-outline-variant border-t-primary" />
                  Loading {activeDrilldownTab === 'returns' ? 'returns' : 'orders'}...
                </div>
              </div>
            ) : orders.length === 0 ? (
              <EmptyState
                icon="check_circle"
                title={activeDrilldownTab === 'returns' ? 'No Returns or Cancellations' : 'No Outstanding Orders'}
                description={
                  orderSearch || agingFilter || statusFilter
                    ? 'No orders match your filter criteria.'
                    : activeDrilldownTab === 'returns'
                    ? 'No return records found for this selection.'
                    : 'All delivered orders for this selection are settled.'
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-border bg-surface-container-low text-secondary text-label-md uppercase font-semibold">
                      <th className="py-2.5 px-4">Order Item ID</th>
                      <th className="py-2.5 px-4">Order ID</th>
                      <th className="py-2.5 px-4">Order Date</th>
                      <th className="py-2.5 px-4">Channel</th>
                      <th className="py-2.5 px-4">Account</th>
                      <th className="py-2.5 px-4">SKU / Category</th>
                      <th className="py-2.5 px-4">Status</th>
                      {activeDrilldownTab === 'returns' && (
                        <>
                          <th className="py-2.5 px-4">Return Type</th>
                          <th className="py-2.5 px-4">Return Reason</th>
                        </>
                      )}
                      <th className="py-2.5 px-4 text-right">Invoice Amount</th>
                      <th className="py-2.5 px-4 text-center">
                        {activeDrilldownTab === 'returns' ? 'Payment Expected' : 'Aging Tier'}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border text-ink">
                    {orders.map(o => (
                      <tr key={o.order_item_id} className="hover:bg-surface-container-low transition-colors">
                        <td className="py-2.5 px-4 font-mono font-medium text-primary">
                          <OrderIdCell id={o.order_item_id} onOpen={setSelectedOrderItemId} />
                        </td>
                        <td className="py-2.5 px-4 font-mono text-outline select-all">
                          {o.order_id}
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <p className="font-medium text-ink">{o.order_date ? String(o.order_date).slice(0, 10) : '—'}</p>
                          <p className="text-[10px] text-outline font-mono">{o.days_outstanding}d ago</p>
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <MarketplaceLogo marketplace={o.marketplace} size="xs" />
                            <span className="capitalize font-medium">{o.marketplace}</span>
                          </div>
                        </td>
                        <td className="py-2.5 px-4 text-secondary font-mono text-[11px]">
                          {o.seller_account || 'default'}
                        </td>
                        <td className="py-2.5 px-4 max-w-[200px] truncate" title={`${o.sku} · ${o.category}`}>
                          <p className="font-semibold text-ink truncate">{o.sku || '—'}</p>
                          <p className="text-[10px] text-outline truncate">{o.category || '—'}</p>
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <span
                            className={`inline-flex rounded px-2 py-0.5 text-[10px] font-semibold border capitalize ${
                              o.orders_status === 'Cancelled'
                                ? 'bg-rose-50 border-rose-200 text-rose-700'
                                : o.orders_status === 'RTO'
                                ? 'bg-amber-50 border-amber-200 text-amber-700'
                                : 'bg-surface-container-low border-border text-secondary'
                            }`}
                          >
                            {o.orders_status || 'Unknown'}
                          </span>
                        </td>
                        {activeDrilldownTab === 'returns' && (
                          <>
                            <td className="py-2.5 px-4 whitespace-nowrap">
                              <span className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium bg-surface-container text-ink">
                                {o.ret_type || '—'}
                              </span>
                            </td>
                            <td className="py-2.5 px-4 max-w-[220px] truncate text-secondary" title={o.return_reason || ''}>
                              {o.return_reason || '—'}
                            </td>
                          </>
                        )}
                        <td className="py-2.5 px-4 text-right tabular-nums font-bold text-ink">
                          {formatCurrency(o.final_invoice_amount)}
                        </td>
                        <td className="py-2.5 px-4 text-center whitespace-nowrap tabular-nums text-[11px]">
                          {activeDrilldownTab === 'returns' ? (
                            <span className="inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold border bg-emerald-50 border-emerald-200 text-emerald-700">
                              ₹0 Due (Returned)
                            </span>
                          ) : (
                            <span
                              className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium border ${
                                o.aging_bucket === '60+'
                                  ? 'bg-rose-50 border-rose-200 text-rose-700 font-bold'
                                  : o.aging_bucket === '31-60'
                                  ? 'bg-amber-50 border-amber-200 text-amber-700'
                                  : 'bg-surface-container-low border-border text-secondary'
                              }`}
                            >
                              {o.aging_bucket}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination Controls */}
            {ordersPagination.pages > 1 && (
              <div className="flex items-center justify-between border-t border-border px-4 py-2.5 bg-surface-container-low text-xs text-secondary flex-wrap gap-2">
                <span>
                  Page {ordersPagination.page} of {ordersPagination.pages} ({num(ordersPagination.total)} total orders)
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={ordersPagination.page <= 1 || ordersLoading}
                    onClick={() => loadOrders(ordersPagination.page - 1)}
                    className="rounded px-2.5 py-1 text-secondary hover:bg-surface-container disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="px-2 font-semibold text-ink font-mono">
                    {ordersPagination.page} / {ordersPagination.pages}
                  </span>
                  <button
                    type="button"
                    disabled={ordersPagination.page >= ordersPagination.pages || ordersLoading}
                    onClick={() => loadOrders(ordersPagination.page + 1)}
                    className="rounded px-2.5 py-1 text-secondary hover:bg-surface-container disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Pending Invoices Table */}
        {activeDrilldownTab === 'invoices' && (
          <div>
            {invoicesLoading ? (
              <div className="flex min-h-[220px] items-center justify-center">
                <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-container-low px-5 py-3 text-xs font-semibold text-secondary shadow-xs">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-outline-variant border-t-primary" />
                  Loading invoices...
                </div>
              </div>
            ) : invoices.length === 0 ? (
              <EmptyState
                icon="receipt_long"
                title="No Pending Invoices"
                description="All uploaded marketplace invoices are settled and paid."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-border bg-surface-container-low text-secondary text-label-md uppercase font-semibold">
                      <th className="py-2.5 px-4">Invoice #</th>
                      <th className="py-2.5 px-4">Date</th>
                      <th className="py-2.5 px-4">Channel</th>
                      <th className="py-2.5 px-4">Account</th>
                      <th className="py-2.5 px-4">SKU</th>
                      <th className="py-2.5 px-4 text-right">Invoice Amt</th>
                      <th className="py-2.5 px-4 text-right">Net Payable</th>
                      <th className="py-2.5 px-4 text-right">Received</th>
                      <th className="py-2.5 px-4 text-right">Balance Due</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border text-ink">
                    {invoices.map(inv => (
                      <tr key={inv.id || inv.invoice_number} className="hover:bg-surface-container-low transition-colors">
                        <td className="py-2.5 px-4 font-mono font-semibold text-ink select-all">
                          {inv.invoice_number}
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap text-secondary">
                          {inv.invoice_date || '—'}
                        </td>
                        <td className="py-2.5 px-4 capitalize">
                          <div className="flex items-center gap-1.5">
                            <MarketplaceLogo marketplace={inv.marketplace} size="xs" />
                            <span>{inv.marketplace}</span>
                          </div>
                        </td>
                        <td className="py-2.5 px-4 font-mono text-secondary">
                          {inv.seller_account || 'default'}
                        </td>
                        <td className="py-2.5 px-4 font-mono">
                          {inv.sku}
                        </td>
                        <td className="py-2.5 px-4 text-right tabular-nums">
                          {formatCurrency(inv.invoice_amount)}
                        </td>
                        <td className="py-2.5 px-4 text-right tabular-nums">
                          {formatCurrency(inv.net_payable)}
                        </td>
                        <td className="py-2.5 px-4 text-right tabular-nums text-emerald-700">
                          {formatCurrency(inv.amount_received)}
                        </td>
                        <td className="py-2.5 px-4 text-right tabular-nums font-bold text-rose-700">
                          {formatCurrency(Number(inv.net_payable || 0) - Number(inv.amount_received || 0))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 7. Config Outstanding Modal */}
      {configOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 modal-backdrop bg-black/40 backdrop-blur-xs">
          <div className="w-full max-w-2xl rounded-xl border border-border bg-surface shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-border bg-surface-container-low px-6 py-4">
              <div>
                <h3 className="font-display font-semibold text-ink text-base">Configure Settlement Cycles & Grace Periods</h3>
                <p className="text-xs text-outline mt-0.5">
                  Set settlement cycle days and grace thresholds for overdue risk classification
                </p>
              </div>
              <button
                type="button"
                onClick={() => setConfigOpen(false)}
                className="rounded-lg p-1.5 text-outline hover:text-ink hover:bg-surface-container transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="p-6 max-h-[60vh] overflow-y-auto space-y-4">
              {configLoading ? (
                <div className="py-8 text-center text-xs text-outline">Loading configuration...</div>
              ) : (
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-border text-secondary text-label-md uppercase font-semibold">
                      <th className="py-2 px-3">Type</th>
                      <th className="py-2 px-3">Channel / Gateway</th>
                      <th className="py-2 px-3 text-center">Grace Period (Days)</th>
                      <th className="py-2 px-3 text-center">Payment Cycle (Days)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {configs.map(c => (
                      <tr key={c.channel_key} className="hover:bg-surface-container-low">
                        <td className="py-2.5 px-3">
                          <span
                            className={`inline-flex rounded px-2 py-0.5 text-[10px] font-bold ${
                              c.channel_type === 'B2C'
                                ? 'bg-primary-container text-on-primary-container border border-primary/20'
                                : 'bg-purple-50 text-purple-700 border border-purple-200'
                            }`}
                          >
                            {c.channel_type}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 font-semibold text-ink">
                          <div className="flex items-center gap-2">
                            {c.channel_type === 'B2C' ? (
                              <MarketplaceLogo marketplace={c.channel_key} size="xs" />
                            ) : (
                              <span className="material-symbols-outlined text-[15px] text-outline">account_balance</span>
                            )}
                            <span>{c.channel_name}</span>
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <input
                            type="number"
                            defaultValue={c.grace_period_days}
                            disabled={savingConfigKey === c.channel_key}
                            onBlur={e => handleUpdateConfig(c.channel_key, 'grace_period_days', e.target.value)}
                            className="w-16 text-center border border-border rounded-md px-1.5 py-1 text-xs font-mono focus:ring-2 focus:ring-primary/40 focus:border-primary"
                          />
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <input
                            type="number"
                            defaultValue={c.payment_cycle_days}
                            disabled={savingConfigKey === c.channel_key}
                            onBlur={e => handleUpdateConfig(c.channel_key, 'payment_cycle_days', e.target.value)}
                            className="w-16 text-center border border-border rounded-md px-1.5 py-1 text-xs font-mono focus:ring-2 focus:ring-primary/40 focus:border-primary"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-container-low px-6 py-3">
              <button
                type="button"
                onClick={() => setConfigOpen(false)}
                className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-on-primary shadow-xs hover:bg-indigo-dark transition-colors focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Save & Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 8. Order Detail Drawer */}
      {selectedOrderItemId && (
        <OrderDetailDrawer
          orderItemId={selectedOrderItemId}
          onClose={() => setSelectedOrderItemId(null)}
        />
      )}
    </div>
  );
}
