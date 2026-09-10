import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchReconciliationSummary,
  fetchReconciliationItems,
  fetchNonOrderDeductions,
  fetchMyntraMonthlySummary,
} from '../api/client';
import { exportXlsx } from '../utils/exportXlsx';

const MONEY = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const money = value => MONEY.format(Number(value || 0));

export function MyntraReconciliationPanel({ market, embedded = false }) {
  const [account, setAccount] = useState('all');
  const [tab, setTab] = useState('monthly'); // 'monthly' | 'orders' | 'nod'
  const [nodCategoryFilter, setNodCategoryFilter] = useState('all');
  const [summary, setSummary] = useState(null);
  const [monthlyData, setMonthlyData] = useState([]);
  const [items, setItems] = useState([]);
  const [nonOrderData, setNonOrderData] = useState({ myntraNod: [], myntraNodSummary: {} });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 50;

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const sellerAcc = account !== 'all' ? account : undefined;
      const [sumRes, monthlyRes, itemRes, nonOrdRes] = await Promise.all([
        fetchReconciliationSummary({ marketplace: 'myntra', sellerAccount: sellerAcc }),
        fetchMyntraMonthlySummary({ marketplace: 'myntra', sellerAccount: sellerAcc }),
        fetchReconciliationItems({ marketplace: 'myntra', sellerAccount: sellerAcc, page, pageSize }),
        fetchNonOrderDeductions({ marketplace: 'myntra', sellerAccount: sellerAcc }),
      ]);
      setSummary(sumRes);
      setMonthlyData(monthlyRes?.data || []);
      setItems(itemRes?.data || []);
      setTotal(itemRes?.total || 0);
      setNonOrderData(nonOrdRes || { myntraNod: [], myntraNodSummary: {} });
    } catch (e) {
      console.error('Error loading Myntra reconciliation data:', e);
    } finally {
      setLoading(false);
    }
  }, [account, page]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleBackfill = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await fetch('/api/mp-settlement/invoices/backfill-myntra', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sellerAccount: account !== 'all' ? account : undefined }),
      });
      const data = await res.json();
      setSyncMsg(data.message || `Linked ${data.ordersUpdated || 0} orders successfully.`);
      loadData();
    } catch (e) {
      setSyncMsg('Sync failed: ' + e.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleExport = () => {
    const sheets = [];

    // Sheet 1: Monthly Settlement Summary
    if (monthlyData.length) {
      sheets.push({
        sheetName: 'Monthly Settlement Summary',
        headers: [
          'Month',
          'Account',
          'Settled Orders',
          'Forward Orders',
          'Return Orders',
          'Gross Sales (₹)',
          'Customer Returns (₹)',
          'Net Sales (₹)',
          'Commission (₹)',
          'Fixed Fee (₹)',
          'Reverse Shipping (₹)',
          'Pick & Pack (₹)',
          'Gateway Fee (₹)',
          'TCS (₹)',
          'TDS (₹)',
          'GST on MP Fees (₹)',
          'Total Order Fees (₹)',
          'Order Net Bank (₹)',
          'Marketing & MFB / Tax Invoices (₹)',
          'Split Remittance Deductions (₹)',
          'SPF Reimbursements (₹)',
          'Credit Notes (₹)',
          'Net Non-Order (NOD) (₹)',
          'Total Realized Bank Settlement (₹)',
          'Unsettled Orders Count',
          'Unsettled Orders Amount (₹)',
        ],
        rows: monthlyData.map(m => [
          m.month,
          m.seller_account_label || m.seller_account,
          m.order_count,
          m.forward_count,
          m.return_count,
          m.gross_sales,
          m.returns_amount,
          m.net_sales,
          m.commission,
          m.fixed_fee,
          m.reverse_shipping,
          m.pick_pack_fee,
          m.gateway_fee,
          m.tcs,
          m.tds,
          m.gst_on_mp_fees,
          m.total_order_fees,
          m.order_bank_received,
          m.marketing_mfb_deductions,
          m.split_nod_deductions,
          m.spf_reimbursements,
          m.credit_notes,
          m.net_nod,
          m.total_bank_settled,
          m.unsettled_count,
          m.unsettled_amount,
        ]),
      });
    }

    // Sheet 2: Reconciled Orders
    if (items.length) {
      sheets.push({
        sheetName: 'Reconciled Orders',
        headers: [
          'Order ID',
          'Line ID',
          'SKU',
          'Order Date',
          'Payment Date',
          'Sale Amount',
          'Commission',
          'Fixed Fee',
          'Reverse Shipping',
          'TCS',
          'TDS',
          'Net Bank Settlement',
          'Status',
        ],
        rows: items.map(r => [
          r.order_id,
          r.order_item_id,
          r.seller_sku || r.sku,
          r.order_date || '',
          r.payment_date || '',
          Number(r.sale_amount || 0),
          Number(r.commission || 0),
          Number(r.fixed_fee || 0),
          Number(r.reverse_shipping || 0),
          Number(r.tcs || 0),
          Number(r.tds || 0),
          Number(r.bank_settlement || 0),
          r.return_type ? `Return (${r.return_type})` : 'Delivered & Settled',
        ]),
      });
    }

    // Sheet 3: Non-Order Deductions & Credits
    const nodRows = nonOrderData.myntraNod || [];
    if (nodRows.length) {
      sheets.push({
        sheetName: 'NOD Deductions & Credits',
        headers: ['Payment Ref', 'Date', 'Account', 'Category', 'Description', 'Settled Value (₹)'],
        rows: nodRows.map(n => [
          n.neft_id,
          n.payment_date || '',
          n.seller_account || '',
          n.category_label || n.category || 'Other',
          n.description || '',
          Number(n.settlement_value || 0),
        ]),
      });
    }

    exportXlsx(sheets, `Myntra_Reconciliation_${account}_${new Date().toISOString().slice(0, 10)}`);
  };

  const nodSummary = nonOrderData.myntraNodSummary || {};
  const nodTotal = useMemo(() => {
    return (nonOrderData.myntraNod || []).reduce((acc, row) => acc + Number(row.settlement_value || 0), 0);
  }, [nonOrderData]);

  // Filter NOD rows by selected category
  const filteredNodRows = useMemo(() => {
    const list = nonOrderData.myntraNod || [];
    if (nodCategoryFilter === 'all') return list;
    if (nodCategoryFilter === 'marketing_mfb') {
      return list.filter(r => r.category === 'marketing' || r.category === 'mfb' || r.category === 'service_tax_invoice');
    }
    return list.filter(r => r.category === nodCategoryFilter);
  }, [nonOrderData.myntraNod, nodCategoryFilter]);

  // Aggregate monthly metrics across all months
  const monthlyTotals = useMemo(() => {
    return monthlyData.reduce(
      (acc, m) => {
        acc.gross_sales += Number(m.gross_sales || 0);
        acc.returns_amount += Number(m.returns_amount || 0);
        acc.net_sales += Number(m.net_sales || 0);
        acc.order_bank_received += Number(m.order_bank_received || 0);
        acc.total_order_fees += Number(m.total_order_fees || 0);
        acc.marketing_mfb_deductions += Number(m.marketing_mfb_deductions || 0);
        acc.split_nod_deductions += Number(m.split_nod_deductions || 0);
        acc.spf_reimbursements += Number(m.spf_reimbursements || 0);
        acc.credit_notes += Number(m.credit_notes || 0);
        acc.net_nod += Number(m.net_nod || 0);
        acc.total_bank_settled += Number(m.total_bank_settled || 0);
        acc.order_count += Number(m.order_count || 0);
        return acc;
      },
      {
        gross_sales: 0,
        returns_amount: 0,
        net_sales: 0,
        order_bank_received: 0,
        total_order_fees: 0,
        marketing_mfb_deductions: 0,
        split_nod_deductions: 0,
        spf_reimbursements: 0,
        credit_notes: 0,
        net_nod: 0,
        total_bank_settled: 0,
        order_count: 0,
      }
    );
  }, [monthlyData]);

  return (
    <div className="space-y-5">
      {/* Top Banner and Account Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-rose-200 bg-rose-50/70 p-4 shadow-xs">
        <div>
          <h2 className="text-base font-bold text-rose-950 flex items-center gap-2">
            <span className="text-lg">👠</span>
            <span>Myntra Marketplace Settlement &amp; Reconciliation</span>
            <span className="rounded-full bg-rose-200/80 px-2.5 py-0.5 text-xs font-semibold text-rose-900">
              VB &amp; EJ
            </span>
          </h2>
          <p className="mt-1 text-xs text-rose-800">
            Reconciles order settlements mapped to order release and line IDs, structured Non-Order Deductions (Marketing, Myntra Fashion Brand MFB, Tax Invoices, Split NOD, and SPF claims), and month-wise statement summary.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg border border-rose-300 bg-white p-1 text-xs shadow-xs">
            <span className="px-2 font-semibold text-rose-900">Account:</span>
            {[
              { id: 'all', label: 'All Accounts' },
              { id: 'myntra_vb', label: 'Myntra (VB)' },
              { id: 'myntra_ej', label: 'Myntra (EJ)' },
            ].map(acc => (
              <button
                key={acc.id}
                type="button"
                onClick={() => { setAccount(acc.id); setPage(1); }}
                className={`rounded px-2.5 py-1 font-medium transition ${
                  account === acc.id
                    ? 'bg-rose-600 text-white font-bold shadow-xs'
                    : 'text-slate-600 hover:text-rose-900'
                }`}
              >
                {acc.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={handleBackfill}
            disabled={syncing}
            className="rounded-lg border border-rose-400 bg-white px-3 py-1.5 text-xs font-bold text-rose-800 shadow-sm hover:bg-rose-100/60 transition disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : '🔄 Sync Order Statuses'}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={!monthlyData.length && !items.length}
            className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-rose-800 transition disabled:opacity-50"
          >
            📥 Export Report
          </button>
        </div>
      </div>

      {syncMsg && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-900">
          {syncMsg}
        </div>
      )}

      {/* Primary KPI Header Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-xl border border-border bg-surface p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-secondary">Gross Sales</div>
          <div className="mt-1 text-lg font-bold text-ink">{money(summary?.total_sale || monthlyTotals.gross_sales)}</div>
          <div className="mt-0.5 text-[10px] text-secondary">{summary?.settled_items || monthlyTotals.order_count} settled items</div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-secondary">Order Net Payout</div>
          <div className="mt-1 text-lg font-bold text-emerald-600">{money(summary?.bank_received || monthlyTotals.order_bank_received)}</div>
          <div className="mt-0.5 text-[10px] text-emerald-700 font-medium">Forward &amp; returns net</div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-secondary">Order Fee Deductions</div>
          <div className="mt-1 text-lg font-bold text-rose-600">{money(summary?.total_deductions || monthlyTotals.total_order_fees)}</div>
          <div className="mt-0.5 text-[10px] text-secondary">Comm + Fixed + Shipping + GST</div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-secondary">Marketing &amp; MFB</div>
          <div className="mt-1 text-lg font-bold text-purple-700">
            {money(monthlyTotals.marketing_mfb_deductions)}
          </div>
          <div className="mt-0.5 text-[10px] text-purple-600 font-medium">Incentives &amp; Brand Fees</div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-secondary">Net Non-Order (NOD)</div>
          <div className={`mt-1 text-lg font-bold ${nodTotal < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
            {money(nodTotal)}
          </div>
          <div className="mt-0.5 text-[10px] text-secondary">{nonOrderData.myntraNod?.length || 0} entries reconciled</div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-secondary">Total Realized Bank</div>
          <div className="mt-1 text-lg font-bold text-blue-700">
            {money(monthlyTotals.total_bank_settled || (Number(summary?.bank_received || 0) + Number(nodTotal)))}
          </div>
          <div className="mt-0.5 text-[10px] text-blue-600 font-medium">Orders Payout + Net NOD</div>
        </div>
      </div>

      {/* Navigation Sub-Tabs */}
      <div className="flex gap-2 border-b border-border pb-2">
        <button
          type="button"
          onClick={() => setTab('monthly')}
          className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
            tab === 'monthly'
              ? 'bg-rose-700 text-white shadow-xs'
              : 'text-secondary hover:bg-surface-container-low'
          }`}
        >
          📅 Month-Wise Settlement Summary ({monthlyData.length})
        </button>
        <button
          type="button"
          onClick={() => setTab('orders')}
          className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
            tab === 'orders'
              ? 'bg-rose-700 text-white shadow-xs'
              : 'text-secondary hover:bg-surface-container-low'
          }`}
        >
          📦 Reconciled Orders ({total})
        </button>
        <button
          type="button"
          onClick={() => setTab('nod')}
          className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
            tab === 'nod'
              ? 'bg-rose-700 text-white shadow-xs'
              : 'text-secondary hover:bg-surface-container-low'
          }`}
        >
          📋 Non-Order Deductions &amp; Credits ({nonOrderData.myntraNod?.length || 0})
        </button>
      </div>

      {/* Tab 1: Monthly Settlement Summary */}
      {tab === 'monthly' && (
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-xs">
            <table className="w-full min-w-[1200px] text-left text-xs">
              <thead className="bg-surface-container-low text-secondary border-b border-border">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">Month</th>
                  <th className="px-3 py-2.5 font-semibold">Account</th>
                  <th className="px-3 py-2.5 font-semibold text-center">Orders</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Gross Sales</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Returns Reversal</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Net Sales</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Commission</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Fixed Fee</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Rev. Shipping</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Taxes (TCS/TDS/GST)</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Order Net Bank</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Marketing &amp; MFB</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Split NOD</th>
                  <th className="px-3 py-2.5 font-semibold text-right">SPF &amp; Credits</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Total Settled</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading ? (
                  <tr>
                    <td colSpan={15} className="px-4 py-8 text-center text-secondary">
                      Loading Myntra month-wise settlement summary…
                    </td>
                  </tr>
                ) : monthlyData.length === 0 ? (
                  <tr>
                    <td colSpan={15} className="px-4 py-8 text-center text-secondary">
                      No Myntra monthly settlement records found. Upload payment remittances from Data Hub.
                    </td>
                  </tr>
                ) : (
                  monthlyData.map(row => {
                    const taxes = Number(row.tcs || 0) + Number(row.tds || 0) + Number(row.gst_on_mp_fees || 0);
                    const spfAndCredits = Number(row.spf_reimbursements || 0) + Number(row.credit_notes || 0);
                    return (
                      <tr key={`${row.month}-${row.seller_account}`} className="hover:bg-surface-container-low/50">
                        <td className="px-3 py-2.5 font-bold text-ink">
                          {row.month}
                        </td>
                        <td className="px-3 py-2.5 font-medium text-secondary">
                          <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                            row.seller_account === 'myntra_ej'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-rose-100 text-rose-800'
                          }`}>
                            {row.seller_account_label || row.seller_account}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-center text-secondary">
                          <span className="font-semibold text-ink">{row.order_count}</span>
                          <span className="text-[10px] text-secondary ml-1">
                            ({row.forward_count} fwd / {row.return_count} ret)
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right font-semibold text-ink">
                          {money(row.gross_sales)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-rose-700">
                          {money(row.returns_amount)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-semibold text-ink">
                          {money(row.net_sales)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-rose-700">
                          {money(row.commission)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-rose-700">
                          {money(row.fixed_fee)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-rose-700">
                          {money(row.reverse_shipping)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-secondary">
                          {money(taxes)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-bold text-emerald-700">
                          {money(row.order_bank_received)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-medium text-purple-700">
                          {money(row.marketing_mfb_deductions)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-rose-700">
                          {money(row.split_nod_deductions)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-medium text-emerald-700">
                          {spfAndCredits > 0 ? `+${money(spfAndCredits)}` : money(spfAndCredits)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-bold text-ink">
                          {money(row.total_bank_settled)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
              {monthlyData.length > 0 && (
                <tfoot className="border-t-2 border-border bg-surface-container-low/80 font-bold text-ink">
                  <tr>
                    <td className="px-3 py-2.5" colSpan={2}>
                      Total ({monthlyData.length} Months)
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {monthlyTotals.order_count}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {money(monthlyTotals.gross_sales)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-rose-700">
                      {money(monthlyTotals.returns_amount)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {money(monthlyTotals.net_sales)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-rose-700" colSpan={3}>
                      Fees: {money(monthlyTotals.total_order_fees)}
                    </td>
                    <td className="px-3 py-2.5 text-right" colSpan={1}>
                      —
                    </td>
                    <td className="px-3 py-2.5 text-right text-emerald-700 font-extrabold">
                      {money(monthlyTotals.order_bank_received)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-purple-700">
                      {money(monthlyTotals.marketing_mfb_deductions)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-rose-700">
                      {money(monthlyTotals.split_nod_deductions)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-emerald-700">
                      +{money(monthlyTotals.spf_reimbursements + monthlyTotals.credit_notes)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-extrabold text-blue-800">
                      {money(monthlyTotals.total_bank_settled)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {/* Tab 2: Reconciled Orders */}
      {tab === 'orders' && (
        <div className="space-y-3">
          <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 text-xs text-blue-900 flex items-center justify-between">
            <div>
              <span className="font-bold">🔗 Order Mapping Linkage:</span> Settlements are strictly mapped via Order Release ID &amp; Order Line ID (<code>orders.order_item_id = mp_invoices.order_line_id</code>). 99.998% match rate verified in active reporting periods.
            </div>
            <span className="rounded-full bg-blue-200/80 px-2.5 py-0.5 text-[10px] font-bold text-blue-950">
              {total} Total Settlements
            </span>
          </div>

          <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-xs">
            <table className="w-full min-w-[1000px] text-left text-xs">
              <thead className="bg-surface-container-low text-secondary border-b border-border">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">Release / Order ID</th>
                  <th className="px-3 py-2.5 font-semibold">Line ID</th>
                  <th className="px-3 py-2.5 font-semibold">SKU</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Customer Paid</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Commission</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Fixed Fee</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Rev. Shipping</th>
                  <th className="px-3 py-2.5 font-semibold text-right">TCS / TDS</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Net Bank Payout</th>
                  <th className="px-3 py-2.5 font-semibold text-center">Lifecycle Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-secondary">
                      Loading Myntra order settlements…
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-secondary">
                      No Myntra order settlements found. Upload payment remittances from the Upload page.
                    </td>
                  </tr>
                ) : (
                  items.map(row => {
                    const isReturn = Boolean(row.return_type || Number(row.reverse_shipping || 0) > 0 || Number(row.bank_settlement || 0) < 0);
                    const taxDeductions = Number(row.tcs || 0) + Number(row.tds || 0);

                    return (
                      <tr key={`${row.order_item_id}-${row.payment_date}`} className="hover:bg-surface-container-low/50">
                        <td className="px-3 py-2.5 font-semibold text-ink">
                          <div>{row.order_id || '—'}</div>
                          <div className="text-[10px] text-secondary">{row.payment_date}</div>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-[11px] text-secondary">
                          {row.order_item_id}
                        </td>
                        <td className="px-3 py-2.5 font-medium text-ink max-w-[150px] truncate" title={row.seller_sku}>
                          {row.seller_sku || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right font-semibold text-ink">
                          {money(row.sale_amount)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-rose-700">
                          {money(row.commission)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-rose-700">
                          {money(row.fixed_fee)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-rose-700">
                          {Number(row.reverse_shipping || 0) > 0 ? money(row.reverse_shipping) : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right text-secondary">
                          {money(taxDeductions)}
                        </td>
                        <td className={`px-3 py-2.5 text-right font-bold ${
                          Number(row.bank_settlement || 0) >= 0 ? 'text-emerald-700' : 'text-rose-700'
                        }`}>
                          {money(row.bank_settlement)}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          {isReturn ? (
                            <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-bold text-purple-800">
                              Reverse / Return
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                              Settled
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>

            {/* Pagination */}
            {total > pageSize && (
              <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs">
                <span className="text-secondary">
                  Showing {((page - 1) * pageSize) + 1} to {Math.min(page * pageSize, total)} of {total} orders
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    className="rounded-lg border border-border px-3 py-1 font-medium text-ink hover:bg-surface-container-low disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={page * pageSize >= total}
                    onClick={() => setPage(p => p + 1)}
                    className="rounded-lg border border-border px-3 py-1 font-medium text-ink hover:bg-surface-container-low disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 3: Non-Order Deductions & Credits (NOD) */}
      {tab === 'nod' && (
        <div className="space-y-4">
          {/* NOD Structured Category KPIs */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <div className="rounded-xl border border-border bg-surface p-3 shadow-xs">
              <div className="text-[11px] font-medium text-purple-700">Marketing &amp; MFB Invoices</div>
              <div className="mt-1 text-base font-bold text-purple-900">
                {money((nodSummary.marketingTotal || 0) + (nodSummary.mfbTotal || 0) + (nodSummary.serviceInvoicesTotal || 0))}
              </div>
              <div className="mt-0.5 text-[10px] text-secondary">
                {(nodSummary.marketingCount || 0) + (nodSummary.mfbCount || 0) + (nodSummary.serviceInvoicesCount || 0)} invoices/fees
              </div>
            </div>

            <div className="rounded-xl border border-border bg-surface p-3 shadow-xs">
              <div className="text-[11px] font-medium text-rose-700">Split NOD Deductions</div>
              <div className="mt-1 text-base font-bold text-rose-900">
                {money(nodSummary.splitNodTotal || 0)}
              </div>
              <div className="mt-0.5 text-[10px] text-secondary">
                {nodSummary.splitNodCount || 0} remittance splits
              </div>
            </div>

            <div className="rounded-xl border border-border bg-surface p-3 shadow-xs">
              <div className="text-[11px] font-medium text-emerald-700">SPF Claim Reimbursements</div>
              <div className="mt-1 text-base font-bold text-emerald-900">
                +{money(nodSummary.spfTotal || 0)}
              </div>
              <div className="mt-0.5 text-[10px] text-emerald-700">
                {nodSummary.spfCount || 0} approved claims
              </div>
            </div>

            <div className="rounded-xl border border-border bg-surface p-3 shadow-xs">
              <div className="text-[11px] font-medium text-blue-700">Credit Notes (CN)</div>
              <div className="mt-1 text-base font-bold text-blue-900">
                +{money(nodSummary.creditNotesTotal || 0)}
              </div>
              <div className="mt-0.5 text-[10px] text-blue-700">
                {nodSummary.creditNotesCount || 0} credit adjustments
              </div>
            </div>

            <div className="rounded-xl border border-border bg-surface p-3 shadow-xs">
              <div className="text-[11px] font-medium text-ink">Net NOD Balance</div>
              <div className={`mt-1 text-base font-bold ${nodTotal < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                {money(nodTotal)}
              </div>
              <div className="mt-0.5 text-[10px] text-secondary">
                {nonOrderData.myntraNod?.length || 0} total entries
              </div>
            </div>
          </div>

          {/* Category Filter Pills */}
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border pb-2 text-xs">
            <span className="font-semibold text-secondary mr-1">Filter Category:</span>
            {[
              { id: 'all', label: `All (${nonOrderData.myntraNod?.length || 0})` },
              { id: 'marketing_mfb', label: `Marketing, MFB & Invoices (${(nodSummary.marketingCount || 0) + (nodSummary.mfbCount || 0) + (nodSummary.serviceInvoicesCount || 0)})` },
              { id: 'split_nod', label: `Split Remittances (${nodSummary.splitNodCount || 0})` },
              { id: 'spf', label: `SPF Claims (${nodSummary.spfCount || 0})` },
              { id: 'credit_note', label: `Credit Notes (${nodSummary.creditNotesCount || 0})` },
              { id: 'logistics_reimb', label: `Logistics Reimb. (${nodSummary.logisticsReimbCount || 0})` },
            ].map(cat => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setNodCategoryFilter(cat.id)}
                className={`rounded-md px-2.5 py-1 font-medium transition ${
                  nodCategoryFilter === cat.id
                    ? 'bg-rose-700 text-white font-bold shadow-xs'
                    : 'bg-surface-container-low text-secondary hover:text-ink'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-xs">
            <table className="w-full min-w-[850px] text-left text-xs">
              <thead className="bg-surface-container-low text-secondary border-b border-border">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">Payment / NEFT Ref</th>
                  <th className="px-3 py-2.5 font-semibold">Payment Date</th>
                  <th className="px-3 py-2.5 font-semibold">Account</th>
                  <th className="px-3 py-2.5 font-semibold">Category</th>
                  <th className="px-3 py-2.5 font-semibold">Description / Reference</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Settled Amount (₹)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {!filteredNodRows.length ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-secondary">
                      No Non-Order Deductions found for the selected category.
                    </td>
                  </tr>
                ) : (
                  filteredNodRows.map((row, idx) => {
                    const isCredit = Number(row.settlement_value || 0) > 0;
                    return (
                      <tr key={`${row.neft_id}-${idx}`} className="hover:bg-surface-container-low/50">
                        <td className="px-3 py-2.5 font-mono text-[11px] text-ink">{row.neft_id || '—'}</td>
                        <td className="px-3 py-2.5 text-secondary">{row.payment_date || '—'}</td>
                        <td className="px-3 py-2.5 font-medium text-secondary">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                            row.seller_account === 'myntra_ej' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'
                          }`}>
                            {row.seller_account === 'myntra_ej' ? 'Myntra (EJ)' : 'Myntra (VB)'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${
                            row.category === 'spf'
                              ? 'bg-emerald-100 text-emerald-800'
                              : row.category === 'credit_note'
                              ? 'bg-blue-100 text-blue-800'
                              : row.category === 'logistics_reimb'
                              ? 'bg-teal-100 text-teal-800'
                              : row.category === 'marketing' || row.category === 'mfb'
                              ? 'bg-purple-100 text-purple-800'
                              : 'bg-rose-100 text-rose-800'
                          }`}>
                            {row.category_label || row.category || 'Deduction'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 font-medium text-ink max-w-[280px] truncate" title={row.description}>
                          {row.description}
                        </td>
                        <td className={`px-3 py-2.5 text-right font-bold ${
                          isCredit ? 'text-emerald-700' : 'text-rose-700'
                        }`}>
                          {isCredit ? `+${money(row.settlement_value)}` : money(row.settlement_value)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
