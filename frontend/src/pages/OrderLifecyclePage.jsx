import { useState } from 'react';
import useFetch from '../hooks/useFetch';
import PageHeader from '../components/PageHeader';
import OrderDetailDrawer from '../components/OrderDetailDrawer';
import { currency, formatDateShort } from '../utils/format';

export default function OrderLifecyclePage() {
  const [page, setPage] = useState(1);
  const [orderDrawerId, setOrderDrawerId] = useState(null);

  const { data, loading, error } = useFetch(`/reconcile/unified-linkup?page=${page}&pageSize=50`, [page]);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <PageHeader 
        title="Unified Linkup" 
        subtitle="Complete linkage of Sales, Returns, and Payments across all marketplaces"
      />

      <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden flex flex-col">
        {loading && !data ? (
          <div className="p-8 text-center text-secondary">Loading...</div>
        ) : error ? (
          <div className="p-8 text-center text-rose-500">{error}</div>
        ) : data?.data?.length === 0 ? (
          <div className="p-8 text-center text-secondary">No orders found.</div>
        ) : (
          <div className="overflow-x-auto min-h-[500px]">
            <table className="min-w-full text-left text-sm border-collapse">
              <thead className="bg-surface-container text-secondary text-xs uppercase tracking-wider sticky top-0 z-10">
                <tr>
                  <th className="px-5 py-3.5 border-b border-border font-semibold">Order ID</th>
                  <th className="px-5 py-3.5 border-b border-border font-semibold">Marketplace</th>
                  <th className="px-5 py-3.5 border-b border-border font-semibold">Date</th>
                  <th className="px-5 py-3.5 border-b border-border font-semibold text-right">Invoice Amt</th>
                  <th className="px-5 py-3.5 border-b border-border font-semibold">Return Status</th>
                  <th className="px-5 py-3.5 border-b border-border font-semibold text-right">Settlements</th>
                  <th className="px-5 py-3.5 border-b border-border font-semibold text-right">Bank Received</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data?.data.map((row, i) => (
                  <tr 
                    key={row.order_item_id || i} 
                    className="hover:bg-surface-container-low transition-colors cursor-pointer"
                    onClick={() => setOrderDrawerId(row.order_item_id)}
                  >
                    <td className="px-5 py-3.5 font-mono text-xs font-semibold text-primary">{row.order_id}</td>
                    <td className="px-5 py-3.5 capitalize">{row.marketplace}</td>
                    <td className="px-5 py-3.5 whitespace-nowrap">{formatDateShort(row.order_date)}</td>
                    <td className="px-5 py-3.5 text-right font-medium">{currency(row.final_invoice_amount)}</td>
                    <td className="px-5 py-3.5">
                      {row.return_status ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-700 uppercase">
                          {row.return_status}
                        </span>
                      ) : (
                        <span className="text-secondary/50">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-right font-medium">{row.settlement_count}</td>
                    <td className={`px-5 py-3.5 text-right font-bold ${row.total_bank_settlement > 0 ? 'text-emerald-600' : row.total_bank_settlement < 0 ? 'text-rose-600' : 'text-secondary'}`}>
                      {currency(row.total_bank_settlement)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        
        {data?.total > 0 && (
          <div className="px-5 py-3 border-t border-border bg-surface flex justify-between items-center text-xs">
            <span className="text-secondary font-medium">Total {data.total.toLocaleString()} linked orders</span>
            <div className="flex items-center gap-2">
              <button 
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 border border-border rounded text-secondary hover:bg-surface-container disabled:opacity-50 font-medium transition-colors"
              >
                Previous
              </button>
              <button 
                onClick={() => setPage(p => p + 1)}
                disabled={page * 50 >= data.total}
                className="px-3 py-1.5 border border-border rounded text-secondary hover:bg-surface-container disabled:opacity-50 font-medium transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {orderDrawerId && (
        <OrderDetailDrawer orderItemId={orderDrawerId} onClose={() => setOrderDrawerId(null)} />
      )}
    </div>
  );
}
