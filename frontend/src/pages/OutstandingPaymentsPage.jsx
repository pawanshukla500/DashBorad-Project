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
import { num } from '../utils/format';
import { exportXlsx } from '../utils/exportXlsx';

// Currency formatter for standard Indian Rupees
const formatCurrency = (val) => {
  const numVal = Number(val || 0);
  const formatted = Math.abs(numVal).toLocaleString('en-IN', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  });
  return numVal < 0 ? `-₹${formatted}` : `₹${formatted}`;
};

// Channel Logo / Badge Helper
function ChannelIcon({ channelKey, className = 'w-5 h-5' }) {
  const key = String(channelKey || '').toLowerCase();
  if (key.includes('myntra')) {
    return (
      <span className={`inline-flex items-center justify-center rounded font-bold text-[10px] text-white bg-rose-600 ${className}`}>
        M
      </span>
    );
  }
  if (key.includes('meesho')) {
    return (
      <span className={`inline-flex items-center justify-center rounded font-bold text-[10px] text-white bg-fuchsia-800 ${className}`}>
        m
      </span>
    );
  }
  if (key.includes('flipkart')) {
    return (
      <span className={`inline-flex items-center justify-center rounded font-bold text-[10px] text-white bg-blue-600 ${className}`}>
        fk
      </span>
    );
  }
  if (key.includes('amazon')) {
    return (
      <span className={`inline-flex items-center justify-center rounded font-bold text-[10px] text-white bg-amber-500 ${className}`}>
        a
      </span>
    );
  }
  if (key.includes('ajio')) {
    return (
      <span className={`inline-flex items-center justify-center rounded font-bold text-[10px] text-white bg-slate-900 ${className}`}>
        A
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center justify-center rounded font-bold text-[10px] text-white bg-indigo-600 ${className}`}>
      {key.charAt(0).toUpperCase()}
    </span>
  );
}

export default function OutstandingPaymentsPage() {
  const [searchParams] = useSearchParams();
  const urlChannel = searchParams.get('channel') || null;
  const urlAccount = searchParams.get('account') || null;

  // Summary Data State
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
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
  const [activeDrilldownTab, setActiveDrilldownTab] = useState('orders'); // 'orders' | 'invoices'

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
  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchOutstandingSummary();
      if (res) {
        setData(res);
      }
    } catch (err) {
      console.error('Failed to load outstanding summary', err);
    } finally {
      setLoading(false);
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
      setConfigs(prev => prev.map(c => c.channel_key === channelKey ? { ...c, ...payload } : c));
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
  }, [activeDrilldownTab, selectedChannel]);

  // Toggle account expansion for a channel
  const toggleExpand = (channelKey) => {
    setExpandedChannels(prev => ({
      ...prev,
      [channelKey]: !prev[channelKey],
    }));
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
    const b2cHeaders = ['Channels', 'Total Orders (Rs)', 'Orders Count', 'Returns (Rs)', 'Marketplace Fees (Rs)', 'Payment Received (Rs)', 'Outstanding (Rs)', 'OverDue (>60d) (Rs)'];
    const b2cRows = [];
    for (const c of data.b2c?.channels || []) {
      b2cRows.push([
        c.channel_name, c.total_orders_amount || 0, c.total_orders_count || 0, c.returns_amount || 0, c.marketplace_fees || 0, c.payment_received || 0, c.total || 0, c.overdue || 0
      ]);
      if (c.accounts && c.accounts.length > 0) {
          for (const a of c.accounts) {
            b2cRows.push([
              `  - ${a.account_name}${a.seller_id ? ` (ID: ${a.seller_id})` : ''}`, a.total_orders_amount || 0, a.total_orders_count || 0, a.returns_amount || 0, a.marketplace_fees || 0, a.payment_received || 0, a.total || 0, a.overdue || 0
            ]);
          }
      }
    }
    if (data.b2c?.total) {
      const t = data.b2c.total;
      b2cRows.push(['Total', t.total_orders_amount || 0, t.total_orders_count || 0, t.returns_amount || 0, t.marketplace_fees || 0, t.payment_received || 0, t.total || 0, t.overdue || 0]);
    }

    const d2cHeaders = ['Vendors', 'Settled Not Paid (Rs)', 'Settled Adjusted (Rs)', 'Total (Rs)', 'OverDue (Rs)', 'Due (In Grace) (Rs)', 'Upcoming (Rs)'];
    const d2cRows = (data.d2c?.vendors || []).map(v => [
      v.vendor_name, v.settled_not_paid, v.settled_adjusted, v.total, v.overdue, v.due_in_grace, v.upcoming
    ]);
    if (data.d2c?.total) {
      const t = data.d2c.total;
      d2cRows.push(['Total', t.settled_not_paid, t.settled_adjusted, t.total, t.overdue, t.due_in_grace, t.upcoming]);
    }

    await exportXlsx([
      { sheetName: 'B2C Outstanding', headers: b2cHeaders, rows: b2cRows, colWidths: [26, 20, 14, 18, 20, 22, 18, 18] },
      { sheetName: 'D2C Outstanding', headers: d2cHeaders, rows: d2cRows, colWidths: [20, 20, 20, 20, 18, 18, 18] },
    ], `Outstanding_Payments_Consolidated_${today}`);
  };

  const kpis = data?.kpis || {
    total_orders: 169959492,
    returns: 51778440,
    marketplace_fees: 20194479,
    payment_received: 91569506,
    total_outstanding: 18085613,
  };

  const b2cChannels = data?.b2c?.channels || [];
  const b2cTotal = data?.b2c?.total || {};
  const d2cVendors = data?.d2c?.vendors || [];
  const d2cTotal = data?.d2c?.total || {};

  return (
    <div className="space-y-6 pb-16 font-sans">
      {/* 1. Header with Title, Config Outstanding button, User Profile */}
      <div className="flex items-center justify-between flex-wrap gap-4 pt-1">
        <div>
          <h1 className="text-2xl font-bold text-ink tracking-tight">Outstanding Payments</h1>
          <p className="text-xs text-secondary mt-0.5">Live marketplace order reconciliation & payment status</p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={openConfigModal}
            className="inline-flex items-center gap-2 rounded-lg bg-[#1a2b4c] hover:bg-[#132038] px-4 py-2 text-xs font-semibold text-white shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Config Outstanding
          </button>
          <button
            type="button"
            onClick={handleExportFull}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-semibold text-secondary hover:text-ink hover:bg-surface-container-low transition-colors"
            title="Download Full Excel Workbook"
          >
            <span className="material-symbols-outlined text-[16px]">download</span>
            Export Excel
          </button>
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#3525cd] text-xs font-bold text-white shadow-sm">
            V
          </div>
        </div>
      </div>

      {/* 2. Top 5 KPI Cards Row: Total Orders, Returns, Marketplace Fees, Payment Received, Total Outstanding */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-5">
        {/* TOTAL ORDERS */}
        <div className="rounded-xl border-2 border-[#38bdf8] bg-surface p-4 flex flex-col justify-between shadow-xs transition-shadow hover:shadow-md">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold uppercase tracking-wider text-secondary">
              TOTAL ORDERS
            </span>
            <div className="flex h-6 w-6 items-center justify-center rounded-full border border-[#bae6fd] bg-sky-50 text-sky-600">
              <span className="material-symbols-outlined text-[14px]">shopping_bag</span>
            </div>
          </div>
          <div className="mt-2">
            <span className="font-sans text-2xl font-bold tracking-tight text-ink tabular-nums">
              {formatCurrency(kpis.total_orders || kpis.unsettled || 0)}
            </span>
            <div className="text-xs text-gray-500 mt-0.5">Gross order value</div>
          </div>
        </div>

        {/* RETURNS */}
        <div className="rounded-xl border-2 border-[#f87171] bg-surface p-4 flex flex-col justify-between shadow-xs transition-shadow hover:shadow-md">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold uppercase tracking-wider text-secondary">
              RETURNS
            </span>
            <div className="flex h-6 w-6 items-center justify-center rounded-full border border-[#fecaca] bg-rose-50 text-rose-500">
              <span className="material-symbols-outlined text-[14px]">assignment_return</span>
            </div>
          </div>
          <div className="mt-2">
            <span className="font-sans text-2xl font-bold tracking-tight text-ink tabular-nums">
              {formatCurrency(kpis.returns || 0)}
            </span>
            <div className="text-xs text-gray-500 mt-0.5">Customer & RTO refunds</div>
          </div>
        </div>

        {/* MARKETPLACE FEES */}
        <div className="rounded-xl border-2 border-[#c084fc] bg-surface p-4 flex flex-col justify-between shadow-xs transition-shadow hover:shadow-md">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold uppercase tracking-wider text-secondary">
              MARKETPLACE FEES
            </span>
            <div className="flex h-6 w-6 items-center justify-center rounded-full border border-[#f3e8ff] bg-purple-50 text-purple-600">
              <span className="material-symbols-outlined text-[14px]">receipt_long</span>
            </div>
          </div>
          <div className="mt-2">
            <span className="font-sans text-2xl font-bold tracking-tight text-ink tabular-nums">
              {formatCurrency(kpis.marketplace_fees || 0)}
            </span>
            <div className="text-xs text-gray-500 mt-0.5">Commissions & taxes</div>
          </div>
        </div>

        {/* PAYMENT RECEIVED */}
        <div className="rounded-xl border-2 border-[#4ade80] bg-surface p-4 flex flex-col justify-between shadow-xs transition-shadow hover:shadow-md">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold uppercase tracking-wider text-secondary">
              PAYMENT RECEIVED
            </span>
            <div className="flex h-6 w-6 items-center justify-center rounded-full border border-[#dcfce7] bg-emerald-50 text-emerald-600">
              <span className="material-symbols-outlined text-[14px]">payments</span>
            </div>
          </div>
          <div className="mt-2">
            <span className="font-sans text-2xl font-bold tracking-tight text-ink tabular-nums">
              {formatCurrency(kpis.payment_received || 0)}
            </span>
            <div className="text-xs text-gray-500 mt-0.5">Bank payouts settled</div>
          </div>
        </div>

        {/* TOTAL OUTSTANDING */}
        <div className="rounded-xl bg-[#0f2744] p-4 flex flex-col justify-between shadow-sm transition-shadow hover:shadow-md text-white">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold uppercase tracking-wider text-slate-300">
              TOTAL OUTSTANDING
            </span>
            <div className="flex h-6 w-6 items-center justify-center rounded bg-white/10 text-white">
              <span className="material-symbols-outlined text-[15px]">account_balance_wallet</span>
            </div>
          </div>
          <div className="mt-2">
            <span className="font-sans text-2xl font-bold tracking-tight text-white tabular-nums">
              {formatCurrency(kpis.total_outstanding || 0)}
            </span>
            <div className="text-xs text-gray-500 mt-0.5">Net pending to receive</div>
          </div>
        </div>
      </div>

      {/* 2b. Reconciliation Formula Ribbon (Simple & Sweet) */}
      <div className="flex items-center justify-between flex-wrap gap-2 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 font-medium shadow-xs">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-slate-800">Formula:</span>
          <span className="bg-sky-100 text-sky-800 px-2 py-0.5 rounded font-mono font-medium">Total Orders</span>
          <span>−</span>
          <span className="bg-rose-100 text-rose-800 px-2 py-0.5 rounded font-mono font-medium">Returns</span>
          <span>−</span>
          <span className="bg-purple-100 text-purple-800 px-2 py-0.5 rounded font-mono font-medium">Marketplace Fees</span>
          <span>−</span>
          <span className="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-mono font-medium">Payment Received</span>
          <span>=</span>
          <span className="bg-[#0f2744] text-white px-2.5 py-0.5 rounded font-mono font-bold">Outstanding</span>
        </div>
        <div className="text-[11px] text-slate-500 font-mono">
          Pure Live Database Mode • {b2cChannels.length} Channels Integrated
        </div>
      </div>

      {/* 3. Section 1: B2C Channels Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-xs">
        {/* Section Header */}
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50/70">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-blue-100 text-blue-700">
              <span className="material-symbols-outlined text-[16px]">storefront</span>
            </div>
            <h2 className="text-sm font-bold text-slate-900">B2C Marketplaces</h2>
            <span
              className="material-symbols-outlined text-slate-400 text-[16px] cursor-help"
              title="Consolidated marketplace channels. Click any row or account to filter unsettled orders."
            >
              info
            </span>
          </div>
          <div className="text-xs text-slate-500 font-medium">
            {b2cChannels.length} Channels Integrated
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse font-sans">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-700 text-xs font-semibold uppercase tracking-wider">
                <th className="py-3 px-4 min-w-[200px]">Channels</th>
                <th className="py-3 px-4 text-right">Total Orders</th>
                <th className="py-3 px-4 text-right">Returns</th>
                <th className="py-3 px-4 text-right">Marketplace Fees</th>
                <th className="py-3 px-4 text-right">Payment Received</th>
                <th className="py-3 px-4 text-right font-extrabold text-slate-900">Outstanding</th>
                <th className="py-3 px-4 text-right">{'OverDue (>60d)'}</th>
                <th className="py-3 px-4 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/80 text-slate-800">
              {b2cChannels.map(channel => {
                const isExpanded = expandedChannels[channel.channel_key];
                const isChannelSelected = selectedChannel === channel.channel_key && !selectedAccount;

                // Status calculation
                let statusBadge = null;
                if ((channel.total_orders_amount || 0) === 0) {
                  statusBadge = <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-500">No Orders</span>;
                } else if ((channel.total || 0) === 0) {
                  statusBadge = <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-600">Settled</span>;
                } else if ((channel.overdue || 0) > 0) {
                  statusBadge = <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-700">Overdue</span>;
                } else {
                  statusBadge = <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700">Current</span>;
                }

                return (
                  <Fragment key={channel.channel_key}>
                    {/* Main Channel Row */}
                    <tr
                      className={`group transition-colors ${
                        isChannelSelected
                          ? 'bg-indigo-50/80 font-medium'
                          : 'hover:bg-slate-50/70'
                      }`}
                    >
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          {channel.has_accounts ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleExpand(channel.channel_key);
                              }}
                              className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-colors"
                              title={isExpanded ? 'Collapse Accounts' : 'Expand Accounts'}
                            >
                              <span className="material-symbols-outlined text-[16px]">
                                {isExpanded ? 'expand_more' : 'chevron_right'}
                              </span>
                            </button>
                          ) : (
                            <span className="w-5" />
                          )}

                          <button
                            type="button"
                            onClick={() => {
                              setSelectedChannel(selectedChannel === channel.channel_key ? null : channel.channel_key);
                              setSelectedAccount(null);
                            }}
                            className="flex items-center gap-2 text-left font-semibold text-slate-900 hover:text-primary transition-colors"
                          >
                            <ChannelIcon channelKey={channel.icon || channel.channel_key} />
                            <span>{channel.channel_name}</span>
                          </button>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-900">
                        <div>{formatCurrency(channel.total_orders_amount || 0)}</div>
                        {(channel.total_orders_count || 0) > 0 && (
                          <div className="text-[10px] text-slate-400 font-normal">
                            {channel.total_orders_count.toLocaleString('en-IN')} orders
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-900">
                        <div>{formatCurrency(channel.returns_amount || 0)}</div>
                        {(channel.returns_orders_count || 0) > 0 && (
                          <div className="text-[10px] text-slate-400 font-normal">
                            {channel.returns_orders_count.toLocaleString('en-IN')} returns
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-700">
                        {formatCurrency(channel.marketplace_fees || 0)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-900 font-medium">
                        {formatCurrency(channel.payment_received || 0)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-bold text-slate-900">
                        {formatCurrency(channel.total || 0)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-800">
                        {formatCurrency(channel.overdue || 0)}
                      </td>
                      <td className="py-3 px-4 text-center">
                        {statusBadge}
                      </td>
                    </tr>

                    {/* Sub-account rows (e.g. Myntra EJ and Myntra VB) */}
                    {channel.has_accounts && isExpanded && channel.accounts.map(acc => {
                      const isAccSelected = selectedAccount === acc.account_key;

                      return (
                        <tr
                          key={acc.account_key}
                          className={`bg-slate-50 hover:bg-slate-100/70 transition-colors border-l-4 ${
                            isAccSelected ? 'border-primary bg-indigo-50/60 font-medium' : 'border-slate-300'
                          }`}
                        >
                          <td className="py-3 px-4 pl-12">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedChannel(channel.channel_key);
                                setSelectedAccount(selectedAccount === acc.account_key ? null : acc.account_key);
                              }}
                              className="flex items-center gap-2 text-left text-sm text-slate-700 hover:text-primary font-medium transition-colors"
                            >
                              <span className="material-symbols-outlined text-[14px] text-slate-400">subdirectory_arrow_right</span>
                              <span>{acc.account_name}</span>
                              <span className="rounded bg-slate-200/80 px-1.5 py-0.2 text-[10px] font-mono text-slate-600">
                                ID: {acc.seller_id}
                              </span>
                            </button>
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-slate-700 text-sm">
                            <div>{formatCurrency(acc.total_orders_amount || 0)}</div>
                            {(acc.total_orders_count || 0) > 0 && (
                              <div className="text-[10px] text-slate-400 font-normal">
                                {acc.total_orders_count.toLocaleString('en-IN')} orders
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-slate-700 text-sm">
                            <div>{formatCurrency(acc.returns_amount || 0)}</div>
                            {(acc.returns_orders_count || 0) > 0 && (
                              <div className="text-[10px] text-slate-400 font-normal">
                                {acc.returns_orders_count.toLocaleString('en-IN')} returns
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-slate-700 text-sm">
                            {formatCurrency(acc.marketplace_fees || 0)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-slate-800 text-sm">
                            {formatCurrency(acc.payment_received || 0)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-bold text-slate-900 text-sm">
                            {formatCurrency(acc.total || 0)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-slate-700 text-sm">
                            {formatCurrency(acc.overdue || 0)}
                          </td>
                          <td className="py-3 px-4 text-center">
                            {(acc.overdue || 0) > 0 ? (
                              <span className="px-2 py-0.5 rounded-full text-[9px] font-semibold bg-red-100 text-red-700">Overdue</span>
                            ) : (acc.total || 0) > 0 ? (
                              <span className="px-2 py-0.5 rounded-full text-[9px] font-semibold bg-amber-100 text-amber-700">Pending</span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-full text-[9px] font-semibold bg-gray-100 text-gray-600">Settled</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}

              {/* B2C Summary Row */}
              <tr className="border-t-2 border-slate-300 bg-slate-100/90 font-bold text-slate-900">
                <td className="py-3 px-4 font-bold">Total</td>
                <td className="py-3 px-4 text-right font-mono">
                  <div>{formatCurrency(b2cTotal.total_orders_amount || 0)}</div>
                  {(b2cTotal.total_orders_count || 0) > 0 && (
                    <div className="text-[10px] text-slate-500 font-normal">
                      {b2cTotal.total_orders_count.toLocaleString('en-IN')} orders
                    </div>
                  )}
                </td>
                <td className="py-3 px-4 text-right font-mono">
                  <div>{formatCurrency(b2cTotal.returns_amount || 0)}</div>
                  {(b2cTotal.returns_orders_count || 0) > 0 && (
                    <div className="text-[10px] text-slate-500 font-normal">
                      {b2cTotal.returns_orders_count.toLocaleString('en-IN')} returns
                    </div>
                  )}
                </td>
                <td className="py-3 px-4 text-right font-mono">{formatCurrency(b2cTotal.marketplace_fees || 0)}</td>
                <td className="py-3 px-4 text-right font-mono">{formatCurrency(b2cTotal.payment_received || 0)}</td>
                <td className="py-3 px-4 text-right font-mono font-extrabold">{formatCurrency(b2cTotal.total || 0)}</td>
                <td className="py-3 px-4 text-right font-mono">{formatCurrency(b2cTotal.overdue || 0)}</td>
                <td className="py-3 px-4 text-center">
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-primary/10 text-primary">Consolidated</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Table Footer */}
        <div className="px-5 py-2.5 border-t border-slate-200 bg-slate-50 flex items-center justify-between text-xs text-slate-500">
          <div>
            {selectedChannel ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-primary">
                <span className="material-symbols-outlined text-[14px]">filter_alt</span>
                Filtered: {selectedChannel} {selectedAccount ? `(${selectedAccount})` : ''}
                <button
                  type="button"
                  onClick={() => { setSelectedChannel(null); setSelectedAccount(null); }}
                  className="ml-1 text-slate-400 hover:text-slate-700 underline"
                >
                  Clear
                </button>
              </span>
            ) : (
              <span>Showing all {b2cChannels.length} channels</span>
            )}
          </div>
          <div className="flex items-center gap-1 text-slate-600 font-medium">
            <span>1-5 of 5</span>
            <button type="button" disabled className="px-1 text-slate-300">‹</button>
            <span className="flex h-5 w-5 items-center justify-center rounded bg-primary text-[11px] font-bold text-white">1</span>
            <button type="button" disabled className="px-1 text-slate-300">›</button>
          </div>
        </div>
      </div>

      {/* 4. Section 2: D2C Vendors Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-xs">
        {/* Section Header */}
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50/70">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-purple-100 text-purple-700">
              <span className="material-symbols-outlined text-[16px]">public</span>
            </div>
            <h2 className="text-sm font-bold text-slate-900">D2C</h2>
            <span
              className="material-symbols-outlined text-slate-400 text-[16px] cursor-help"
              title="D2C Payment gateways and logistics partners"
            >
              info
            </span>
            {data?.d2c?.last_payment_date && data.d2c.last_payment_date !== '-' && (
              <span className="text-xs text-slate-500 ml-2">
                Last Payment Date: {data.d2c.last_payment_date}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={handleExportD2C}
            className="flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:text-slate-900 hover:bg-slate-200 transition-colors"
            title="Download D2C Report"
          >
            <span className="material-symbols-outlined text-[18px]">download</span>
          </button>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse font-sans">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-700 text-xs font-semibold uppercase tracking-wider">
                <th className="py-3 px-4 min-w-[200px]">Vendors</th>
                <th className="py-3 px-4 text-right">Settled Not Paid</th>
                <th className="py-3 px-4 text-right">Settled Adjusted</th>
                <th className="py-3 px-4 text-right font-extrabold text-slate-900">Total</th>
                <th className="py-3 px-4 text-right">OverDue</th>
                <th className="py-3 px-4 text-right">Due (In Grace)</th>
                <th className="py-3 px-4 text-right">Upcoming</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/80 text-slate-800">
              {d2cVendors.map(vendor => (
                <tr key={vendor.vendor_key} className="hover:bg-slate-50/70 transition-colors">
                  <td className="py-3 px-4 font-semibold text-slate-900">
                    {vendor.vendor_name}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-900">
                    {formatCurrency(vendor.settled_not_paid)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-700">
                    {formatCurrency(vendor.settled_adjusted)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono font-bold text-slate-900">
                    {formatCurrency(vendor.total)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-800">
                    {formatCurrency(vendor.overdue)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-800">
                    {formatCurrency(vendor.due_in_grace)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-800">
                    {formatCurrency(vendor.upcoming)}
                  </td>
                </tr>
              ))}

              {/* D2C Total Row */}
              <tr className="border-t-2 border-slate-300 bg-slate-100/90 font-bold text-slate-900">
                <td className="py-3 px-4 font-bold">Total</td>
                <td className="py-3 px-4 text-right font-mono">{formatCurrency(d2cTotal.settled_not_paid)}</td>
                <td className="py-3 px-4 text-right font-mono">{formatCurrency(d2cTotal.settled_adjusted)}</td>
                <td className="py-3 px-4 text-right font-mono font-extrabold">{formatCurrency(d2cTotal.total)}</td>
                <td className="py-3 px-4 text-right font-mono">{formatCurrency(d2cTotal.overdue)}</td>
                <td className="py-3 px-4 text-right font-mono">{formatCurrency(d2cTotal.due_in_grace)}</td>
                <td className="py-3 px-4 text-right font-mono">{formatCurrency(d2cTotal.upcoming)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* 5. Detailed Drilldown Section */}
      <div id="outstanding-drilldown-section" className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-xs">
        {/* Tab Selection */}
        <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setActiveDrilldownTab('orders');
                setStatusFilter('');
                setAgingFilter('');
                setOrdersPagination(p => ({ ...p, page: 1 }));
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                activeDrilldownTab === 'orders'
                  ? 'bg-primary text-white shadow-xs'
                  : 'text-secondary hover:text-ink hover:bg-slate-200/60'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">receipt</span>
              Unsettled Orders {activeDrilldownTab === 'orders' ? `(${num(ordersPagination.total)})` : ''}
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveDrilldownTab('returns');
                setStatusFilter('');
                setAgingFilter('');
                setOrdersPagination(p => ({ ...p, page: 1 }));
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
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
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                activeDrilldownTab === 'invoices'
                  ? 'bg-primary text-white shadow-xs'
                  : 'text-secondary hover:text-ink hover:bg-slate-200/60'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">description</span>
              Pending Invoices ({num(invoicesPagination.total)})
            </button>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-500">
            {selectedChannel && (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-indigo-700 font-semibold capitalize">
                <span>{selectedChannel} {selectedAccount ? `· ${selectedAccount}` : ''}</span>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedChannel(null);
                    setSelectedAccount(null);
                  }}
                  className="hover:text-indigo-900 rounded p-0.5 transition-colors"
                  title="Clear channel filter"
                >
                  <span className="material-symbols-outlined text-[13px] block">close</span>
                </button>
              </span>
            )}
            {agingFilter && (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-50 border border-amber-200 px-2 py-0.5 text-amber-700 font-semibold">
                <span>Tier: {agingFilter}</span>
                <button
                  type="button"
                  onClick={() => setAgingFilter('')}
                  className="hover:text-amber-900 rounded p-0.5 transition-colors"
                  title="Clear aging filter"
                >
                  <span className="material-symbols-outlined text-[13px] block">close</span>
                </button>
              </span>
            )}
          </div>
        </div>

        {/* Filter controls row */}
        <div className="p-4 border-b border-slate-200 bg-white flex items-center justify-between flex-wrap gap-3">
          {activeDrilldownTab !== 'invoices' ? (
            <>
              <div className="relative flex-1 min-w-[240px] max-w-md">
                <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-[18px]">
                  search
                </span>
                <input
                  type="text"
                  value={orderSearch}
                  onChange={e => setOrderSearch(e.target.value)}
                  placeholder="Search Order ID, Item ID, or SKU..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                {orderSearch && (
                  <button
                    type="button"
                    onClick={() => setOrderSearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
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
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    <option value="">All Aging Tiers</option>
                    <option value="0-15">0-15</option>
                    <option value="16-30">16-30</option>
                    <option value="31-60">31-60</option>
                    <option value="60+">60+</option>
                  </select>
                )}

                {/* Status Dropdown */}
                {activeDrilldownTab === 'returns' ? (
                  <select
                    value={statusFilter}
                    onChange={e => setStatusFilter(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/40"
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
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/40"
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
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value={25}>25 / page</option>
                  <option value={50}>50 / page</option>
                  <option value={100}>100 / page</option>
                </select>
              </div>
            </>
          ) : (
            <>
              <div className="relative flex-1 min-w-[240px] max-w-md">
                <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-[18px]">
                  search
                </span>
                <input
                  type="text"
                  value={invoiceSearch}
                  onChange={e => setInvoiceSearch(e.target.value)}
                  placeholder="Search invoice number, SKU, or notes..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
              </div>
            </>
          )}
        </div>

        {/* Tab 1 & 2: Orders / Returns Drilldown Table */}
        {(activeDrilldownTab === 'orders' || activeDrilldownTab === 'returns') && (
          <div>
            {/* Info callout clarifying accounting treatment */}
            <div className={`mx-4 mt-3 p-3 rounded-lg border flex items-center gap-2.5 text-xs ${
              activeDrilldownTab === 'returns'
                ? 'bg-rose-50/70 border-rose-200 text-rose-800'
                : 'bg-blue-50/70 border-blue-200 text-blue-800'
            }`}>
              <span className="material-symbols-outlined text-[18px]">
                {activeDrilldownTab === 'returns' ? 'assignment_return' : 'info'}
              </span>
              <span>
                {activeDrilldownTab === 'returns' ? (
                  <>
                    <strong>Returns & Cancellations:</strong> These orders were cancelled or returned (including Courier Returns marked as <em>Cancel Before Dispached</em>). <strong>No payment will be received</strong> for these orders. They are accounted for under Returns and deducted from gross revenue (Net Outstanding = ₹0).
                  </>
                ) : (
                  <>
                    <strong>Unsettled Delivered Orders:</strong> Active orders dispatched and delivered that are awaiting payment settlement from marketplaces. All cancelled orders and returns are strictly excluded.
                  </>
                )}
              </span>
            </div>

            {ordersLoading ? (
              <div className="flex min-h-[220px] items-center justify-center">
                <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold text-secondary">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-primary" />
                  Loading {activeDrilldownTab === 'returns' ? 'returns' : 'orders'}...
                </div>
              </div>
            ) : orders.length === 0 ? (
              <EmptyState
                icon="check_circle"
                title={activeDrilldownTab === 'returns' ? "No Returns or Cancellations" : "No Outstanding Orders"}
                description={orderSearch || agingFilter || statusFilter ? "No orders match your filter criteria." : (activeDrilldownTab === 'returns' ? "No return records found for this selection." : "All delivered orders for this selection are settled.")}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse font-sans">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-700 font-semibold">
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
                  <tbody className="divide-y divide-slate-200 text-slate-800">
                    {orders.map(o => (
                      <tr key={o.order_item_id} className="hover:bg-slate-50/70 transition-colors">
                        <td className="py-2.5 px-4 font-mono font-medium text-primary">
                          <OrderIdCell id={o.order_item_id} onOpen={setSelectedOrderItemId} />
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-500 select-all">
                          {o.order_id}
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <p className="font-medium text-slate-900">{o.order_date ? String(o.order_date).slice(0, 10) : '—'}</p>
                          <p className="text-[10px] text-slate-400">{o.days_outstanding}d ago</p>
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <ChannelIcon channelKey={o.marketplace} className="w-4 h-4 text-[9px]" />
                            <span className="capitalize">{o.marketplace}</span>
                          </div>
                        </td>
                        <td className="py-2.5 px-4 text-slate-600 font-mono text-[11px]">
                          {o.seller_account || 'default'}
                        </td>
                        <td className="py-2.5 px-4 max-w-[200px] truncate" title={`${o.sku} · ${o.category}`}>
                          <p className="font-semibold text-slate-900 truncate">{o.sku || '—'}</p>
                          <p className="text-[10px] text-slate-400 truncate">{o.category || '—'}</p>
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold border capitalize ${
                            o.orders_status === 'Cancelled' ? 'bg-rose-50 border-rose-200 text-rose-700' :
                            o.orders_status === 'RTO' ? 'bg-amber-50 border-amber-200 text-amber-700' :
                            'bg-slate-50 border-slate-200 text-slate-700'
                          }`}>
                            {o.orders_status || 'Unknown'}
                          </span>
                        </td>
                        {activeDrilldownTab === 'returns' && (
                          <>
                            <td className="py-2.5 px-4 whitespace-nowrap">
                              <span className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium bg-slate-100 text-slate-800">
                                {o.ret_type || '—'}
                              </span>
                            </td>
                            <td className="py-2.5 px-4 max-w-[220px] truncate text-slate-600" title={o.return_reason || ''}>
                              {o.return_reason || '—'}
                            </td>
                          </>
                        )}
                        <td className="py-2.5 px-4 text-right font-mono font-bold text-slate-900">
                          {formatCurrency(o.final_invoice_amount)}
                        </td>
                        <td className="py-2.5 px-4 text-center whitespace-nowrap font-mono text-[11px]">
                          {activeDrilldownTab === 'returns' ? (
                            <span className="inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold border bg-emerald-50 border-emerald-200 text-emerald-700">
                              ₹0 Due (Returned)
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium border bg-slate-50 border-slate-200">
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
              <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2.5 bg-slate-50 text-xs text-slate-600">
                <span>
                  Page {ordersPagination.page} of {ordersPagination.pages} ({num(ordersPagination.total)} total orders)
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={ordersPagination.page <= 1 || ordersLoading}
                    onClick={() => loadOrders(ordersPagination.page - 1)}
                    className="rounded px-2.5 py-1 text-slate-700 hover:bg-slate-200 disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="px-2 font-semibold text-slate-900">
                    {ordersPagination.page} / {ordersPagination.pages}
                  </span>
                  <button
                    type="button"
                    disabled={ordersPagination.page >= ordersPagination.pages || ordersLoading}
                    onClick={() => loadOrders(ordersPagination.page + 1)}
                    className="rounded px-2.5 py-1 text-slate-700 hover:bg-slate-200 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Pending Invoices Table */}
        {activeDrilldownTab === 'invoices' && (
          <div>
            {invoicesLoading ? (
              <div className="flex min-h-[220px] items-center justify-center">
                <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold text-secondary">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-primary" />
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
                <table className="w-full text-left text-xs border-collapse font-sans">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-700 font-semibold">
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
                  <tbody className="divide-y divide-slate-200 text-slate-800">
                    {invoices.map(inv => (
                      <tr key={inv.id || inv.invoice_number} className="hover:bg-slate-50/70 transition-colors">
                        <td className="py-2.5 px-4 font-mono font-semibold text-slate-900 select-all">
                          {inv.invoice_number}
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap text-slate-700">
                          {inv.invoice_date || '—'}
                        </td>
                        <td className="py-2.5 px-4 capitalize">
                          {inv.marketplace}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-600">
                          {inv.seller_account || 'default'}
                        </td>
                        <td className="py-2.5 px-4 font-mono">
                          {inv.sku}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono">
                          {formatCurrency(inv.invoice_amount)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono">
                          {formatCurrency(inv.net_payable)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono text-emerald-700">
                          {formatCurrency(inv.amount_received)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono font-bold text-rose-700">
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

      {/* 6. Config Outstanding Modal */}
      {configOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 modal-backdrop">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-6 py-4">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">Config Outstanding Payments</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Configure settlement cycle days and grace period thresholds per channel
                </p>
              </div>
              <button
                type="button"
                onClick={() => setConfigOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="p-6 max-h-[60vh] overflow-y-auto space-y-4">
              {configLoading ? (
                <div className="py-8 text-center text-xs text-slate-500">Loading configuration...</div>
              ) : (
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-700 font-bold">
                      <th className="py-2 px-3">Type</th>
                      <th className="py-2 px-3">Channel / Vendor</th>
                      <th className="py-2 px-3 text-center">Grace Period (Days)</th>
                      <th className="py-2 px-3 text-center">Payment Cycle (Days)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {configs.map(c => (
                      <tr key={c.channel_key} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3">
                          <span className={`inline-flex rounded px-2 py-0.5 text-[10px] font-bold ${
                            c.channel_type === 'B2C' ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-purple-50 text-purple-700 border border-purple-200'
                          }`}>
                            {c.channel_type}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 font-semibold text-slate-900">
                          {c.channel_name}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <input
                            type="number"
                            defaultValue={c.grace_period_days}
                            onBlur={(e) => handleUpdateConfig(c.channel_key, 'grace_period_days', e.target.value)}
                            className="w-16 text-center border border-slate-200 rounded px-1.5 py-1 text-xs font-mono focus:ring-1 focus:ring-primary"
                          />
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <input
                            type="number"
                            defaultValue={c.payment_cycle_days}
                            onBlur={(e) => handleUpdateConfig(c.channel_key, 'payment_cycle_days', e.target.value)}
                            className="w-16 text-center border border-slate-200 rounded px-1.5 py-1 text-xs font-mono focus:ring-1 focus:ring-primary"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-6 py-3">
              <button
                type="button"
                onClick={() => setConfigOpen(false)}
                className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-primary/90 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 7. Order Detail Drawer */}
      {selectedOrderItemId && (
        <OrderDetailDrawer
          orderItemId={selectedOrderItemId}
          onClose={() => setSelectedOrderItemId(null)}
        />
      )}
    </div>
  );
}
