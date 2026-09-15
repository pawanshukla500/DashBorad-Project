import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchReconciliationSummary,
  fetchReconciliationItems,
  fetchNonOrderDeductions,
} from '../api/client';
import { exportXlsx } from '../utils/exportXlsx';
import { Link } from 'react-router-dom';

const MONEY = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const money = value => MONEY.format(Number(value || 0));

export function MeeshoReconciliationPanel({ market, embedded = false }) {
  const [tab, setTab] = useState('orders'); // 'orders' | 'claims'
  const [summary, setSummary] = useState(null);
  const [items, setItems] = useState([]);
  const [nonOrderData, setNonOrderData] = useState({ meeshoClaims: [] });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 50;

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [sumRes, itemRes, nonOrdRes] = await Promise.all([
        fetchReconciliationSummary({ marketplace: 'meesho' }),
        fetchReconciliationItems({ marketplace: 'meesho', page, pageSize }),
        fetchNonOrderDeductions({ marketplace: 'meesho' }),
      ]);
      setSummary(sumRes);
      setItems(itemRes?.data || []);
      setTotal(itemRes?.total || 0);
      setNonOrderData(nonOrdRes || { meeshoClaims: [] });
    } catch (e) {
      console.error('Error loading Meesho reconciliation data:', e);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleExport = () => {
    if (!items.length) return;
    exportXlsx([
      {
        sheetName: 'Sub Orders',
        headers: ['Sub Order No', 'Order ID', 'SKU', 'Order Date', 'Payment Date', 'Sale Amount', 'Commission', 'Fixed Fee', 'Shipping Fee', 'Reverse Shipping', 'TCS', 'TDS', 'Claims', 'Bank Settlement', 'Return Status'],
        rows: items.map(r => [
          r.order_item_id,
          r.order_id || r.order_item_id,
          r.seller_sku || r.sku,
          r.order_date || '',
          r.payment_date || '',
          Number(r.sale_amount || 0),
          Number(r.commission || 0),
          Number(r.fixed_fee || 0),
          Number(r.shipping_fee || 0),
          Number(r.reverse_shipping || 0),
          Number(r.tcs || 0),
          Number(r.tds || 0),
          Number(r.spf_received_amount || 0),
          Number(r.bank_settlement || 0),
          r.return_type || 'Delivered',
        ]),
      },
    ], `Meesho_Reconciliation_${new Date().toISOString().slice(0, 10)}`);
  };

  const totalClaims = useMemo(() => {
    return (nonOrderData.meeshoClaims || []).reduce((acc, row) => acc + Number(row.settlement_value || 0), 0);
  }, [nonOrderData]);

  return (
    <div className="space-y-5">
      {/* Top Banner */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-emerald-200 bg-emerald-50/70 p-4">
        <div>
          <h2 className="text-base font-bold text-emerald-950 flex items-center gap-2">
            <span>🛍️</span>
            <span>Meesho Payment Reconciliation</span>
            <span className="rounded-full bg-emerald-200/80 px-2.5 py-0.5 text-xs font-semibold text-emerald-900">
              Order Payments
            </span>
          </h2>
          <p className="mt-1 text-xs text-emerald-800">
            Reconciles Sub Order payments from multi-sheet remittance files, accounting for Sale Amount, Commission, Warehousing fees, Shipping & Reverse Shipping charges, and Claims.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/upload?marketplace=meesho"
            className="rounded-lg border border-emerald-400 bg-white px-3 py-1.5 text-xs font-bold text-emerald-800 shadow-sm hover:bg-emerald-100/50 transition"
          >
            📤 Upload Payment File
          </Link>
          <button
            type="button"
            onClick={handleExport}
            disabled={!items.length}
            className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-emerald-800 transition disabled:opacity-50"
          >
            📥 Export Report
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-xl border border-border bg-surface p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-secondary">Gross Sales</div>
          <div className="mt-1 text-financial-md font-semibold text-ink tabular-nums">{money(summary?.total_sale)}</div>
          <div className="mt-0.5 text-[10px] text-secondary">{summary?.settled_items || 0} sub-orders</div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-secondary">Bank Settlement</div>
          <div className="mt-1 text-financial-md font-semibold text-emerald-600 tabular-nums">{money(summary?.bank_received)}</div>
          <div className="mt-0.5 text-[10px] text-emerald-700 font-medium">Final payout</div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-secondary">Total Deductions</div>
          <div className="mt-1 text-financial-md font-semibold text-rose-600 tabular-nums">{money(summary?.total_deductions)}</div>
          <div className="mt-0.5 text-[10px] text-secondary">Fees + Shipping</div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-secondary">Returned Orders</div>
          <div className="mt-1 text-financial-md font-semibold text-purple-700 tabular-nums">{summary?.returned_items || 0}</div>
          <div className="mt-0.5 text-[10px] text-purple-600 font-medium">RVP + RTO</div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-secondary">Claims & Recovery</div>
          <div className="mt-1 text-financial-md font-semibold text-emerald-700 tabular-nums">{money(totalClaims)}</div>
          <div className="mt-0.5 text-[10px] text-secondary">{nonOrderData.meeshoClaims?.length || 0} claims</div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-secondary">Unsettled Sub-Orders</div>
          <div className="mt-1 text-financial-md font-semibold text-amber-600 tabular-nums">{summary?.unsettled_items || 0}</div>
          <div className="mt-0.5 text-[10px] text-amber-700 font-medium">{money(summary?.unsettled_amount)}</div>
        </div>
      </div>

      {/* Sub-Tabs */}
      <div className="flex gap-2 border-b border-border pb-2">
        <button
          type="button"
          onClick={() => setTab('orders')}
          className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
            tab === 'orders'
              ? 'bg-emerald-700 text-white shadow-xs'
              : 'text-secondary hover:bg-surface-container-low'
          }`}
        >
          📦 Sub-Orders ({total})
        </button>
        <button
          type="button"
          onClick={() => setTab('claims')}
          className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
            tab === 'claims'
              ? 'bg-emerald-700 text-white shadow-xs'
              : 'text-secondary hover:bg-surface-container-low'
          }`}
        >
          🛡️ Claims & Compensations ({nonOrderData.meeshoClaims?.length || 0})
        </button>
      </div>

      {tab === 'orders' ? (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-xs">
          <table className="w-full min-w-[1050px] text-left text-xs">
            <thead className="bg-surface-container-low text-secondary border-b border-border">
              <tr>
                <th className="px-3 py-2.5 font-semibold">Sub Order No</th>
                <th className="px-3 py-2.5 font-semibold">Supplier SKU</th>
                <th className="px-3 py-2.5 font-semibold">Payment Date</th>
                <th className="px-3 py-2.5 font-semibold text-right">Sale Amount</th>
                <th className="px-3 py-2.5 font-semibold text-right">Commission</th>
                <th className="px-3 py-2.5 font-semibold text-right">Fixed Fee</th>
                <th className="px-3 py-2.5 font-semibold text-right">Shipping</th>
                <th className="px-3 py-2.5 font-semibold text-right">Rev. Shipping</th>
                <th className="px-3 py-2.5 font-semibold text-right">TCS / TDS</th>
                <th className="px-3 py-2.5 font-semibold text-right">Bank Settlement</th>
                <th className="px-3 py-2.5 font-semibold text-center">Return Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-secondary">
                    Loading Meesho settlements…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-secondary">
                    No Meesho settlements recorded. Upload an "Order Payments" sheet from the Upload page.
                  </td>
                </tr>
              ) : (
                items.map(row => {
                  const isReturn = Boolean(row.return_type || Number(row.reverse_shipping || 0) > 0 || Number(row.bank_settlement || 0) < 0);
                  const tax = Number(row.tcs || 0) + Number(row.tds || 0);

                  return (
                    <tr key={`${row.order_item_id}-${row.payment_date}`} className="hover:bg-surface-container-low/50">
                      <td className="px-3 py-2.5 font-mono font-medium text-ink">
                        {row.order_item_id}
                      </td>
                      <td className="px-3 py-2.5 font-medium text-ink max-w-[160px] truncate" title={row.seller_sku}>
                        {row.seller_sku || '—'}
                      </td>
                      <td className="px-3 py-2.5 text-secondary">
                        {row.payment_date || '—'}
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
                        {money(row.shipping_fee)}
                      </td>
                      <td className="px-3 py-2.5 text-right text-rose-700">
                        {Number(row.reverse_shipping || 0) > 0 ? money(row.reverse_shipping) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right text-secondary">
                        {money(tax)}
                      </td>
                      <td className={`px-3 py-2.5 text-right font-bold ${
                        Number(row.bank_settlement || 0) >= 0 ? 'text-emerald-700' : 'text-rose-700'
                      }`}>
                        {money(row.bank_settlement)}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {isReturn ? (
                          <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-bold text-purple-800">
                            {row.return_type || 'Return'}
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                            Delivered
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
                Showing {((page - 1) * pageSize) + 1} to {Math.min(page * pageSize, total)} of {total} sub-orders
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
      ) : (
        /* Claims Tab */
        <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-xs">
          <table className="w-full min-w-[750px] text-left text-xs">
            <thead className="bg-surface-container-low text-secondary border-b border-border">
              <tr>
                <th className="px-3 py-2.5 font-semibold">Settlement ID</th>
                <th className="px-3 py-2.5 font-semibold">Payment Date</th>
                <th className="px-3 py-2.5 font-semibold">Sub Order No</th>
                <th className="px-3 py-2.5 font-semibold">SKU</th>
                <th className="px-3 py-2.5 font-semibold">Type / Description</th>
                <th className="px-3 py-2.5 font-semibold text-right">Claim Amount (₹)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {!nonOrderData.meeshoClaims?.length ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-secondary">
                    No Meesho claims or recovery records found.
                  </td>
                </tr>
              ) : (
                nonOrderData.meeshoClaims.map((row, idx) => (
                  <tr key={`${row.neft_id}-${idx}`} className="hover:bg-surface-container-low/50">
                    <td className="px-3 py-2.5 font-mono text-[11px] text-ink">{row.neft_id || '—'}</td>
                    <td className="px-3 py-2.5 text-secondary">{row.payment_date || '—'}</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-secondary">{row.order_item_id || '—'}</td>
                    <td className="px-3 py-2.5 font-medium text-ink">{row.sku || '—'}</td>
                    <td className="px-3 py-2.5 font-medium text-ink">{row.description}</td>
                    <td className="px-3 py-2.5 text-right font-bold text-emerald-700">
                      {money(row.settlement_value)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
