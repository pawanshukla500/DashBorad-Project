import React, { useMemo, useRef, useState } from 'react';
import { 
  fetchReturnsTracker, 
  downloadReturnsTemplate, 
  uploadReturnsReceived, 
  fetchReturnsReceivedSummary 
} from '../api/client';
import KPICard from '../components/KPICard';
import useFetch from '../hooks/useFetch';
import * as XLSX from 'xlsx';

export default function ReturnTrackingPage() {
  const [filter, setFilter]       = useState('all');
  const [page, setPage]           = useState(1);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState(null);
  const fileRef                   = useRef(null);
  const PAGE_SIZE = 100;
  const trackerRequest = useMemo(() => ({ filter, page }), [filter, page]);
  const {
    data: trackerData,
    loading,
    error: trackerError,
    refetch: refetchTracker,
  } = useFetch(
    () => fetchReturnsTracker(trackerRequest.filter, null, trackerRequest.page, PAGE_SIZE),
    [filter, page],
  );
  const { data: summary, error: summaryError, refetch: refetchSummary } = useFetch(
    () => fetchReturnsReceivedSummary(),
    [],
  );
  const rows = trackerData?.data || [];
  const total = trackerData?.total || 0;
  const error = trackerError || summaryError;

  const handleDownload = async () => {
    try {
      const blob = await downloadReturnsTemplate();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `returns-tracker-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) { alert('Download failed: ' + e.message); }
  };

  const handleUpload = async (file) => {
    if (!file) return;
    setUploading(true);
    setUploadMsg(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheetName = wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      
      const headers = rawRows[0] || [];
      const dataRows = rawRows.slice(1).filter(r => r.some(c => c !== ''));
      
      const CHUNK_SIZE = 5000;
      if (dataRows.length > CHUNK_SIZE) {
        let inserted = 0;
        let skipped = 0;
        for (let i = 0; i < dataRows.length; i += CHUNK_SIZE) {
          const chunkRows = dataRows.slice(i, i + CHUNK_SIZE);
          const percent = Math.round((i / dataRows.length) * 100);
          setUploadMsg({ ok: true, text: `Uploading batch ${Math.floor(i/CHUNK_SIZE) + 1} of ${Math.ceil(dataRows.length/CHUNK_SIZE)} (${percent}%)...` });
          
          const chunkWs = XLSX.utils.aoa_to_sheet([headers, ...chunkRows]);
          const chunkBw = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(chunkBw, chunkWs, sheetName);
          const chunkBuf = XLSX.write(chunkBw, { type: 'array', bookType: 'xlsx' });
          const chunkBlob = new Blob([chunkBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
          const chunkFile = new File([chunkBlob], `part_${Math.floor(i/CHUNK_SIZE) + 1}_${file.name}`, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
          
          const fd = new FormData();
          fd.append('file', chunkFile);
          const r = await uploadReturnsReceived(fd);
          inserted += (r.inserted || 0);
          skipped += (r.skipped || 0);
        }
        setUploadMsg({ ok: true, text: `✓ Uploaded in batches: ${inserted} new/updated, ${skipped} skipped` });
      } else {
        const fd = new FormData();
        fd.append('file', file);
        const r = await uploadReturnsReceived(fd);
        setUploadMsg({ ok: true, text: `✓ Uploaded: ${r.inserted || 0} new, ${r.updated || 0} updated` });
      }
      refetchTracker();
      refetchSummary();
    } catch (e) {
      setUploadMsg({ ok: false, text: 'Upload failed: ' + (e.response?.data?.error || e.message) });
    } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="p-6 bg-surface-container-low min-h-screen text-ink">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Returns & SPF Tracking</h1>
        <p className="text-sm text-secondary mt-1">Manage return conditions and track SPF claims order by order.</p>
      </div>
      <div className="space-y-4">
      {error && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <span>{trackerData || summary ? `Showing the last verified return data. ${error}` : error}</span>
          <button onClick={() => { refetchTracker(); refetchSummary(); }} className="shrink-0 rounded-lg border border-rose-200 bg-surface px-3 py-1.5 text-xs font-bold text-rose-700">Retry</button>
        </div>
      )}
      {/* KPI bar */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
          <KPICard label="Total Returns"  value={summary.total       || 0} color="indigo"  sub="all return requests" />
          <KPICard label="Received"       value={summary.received    || 0} color="emerald" sub="confirmed received" />
          <KPICard label="Not Received"   value={summary.notReceived || 0} color="amber"   sub="awaiting receipt" />
          <KPICard label="Good Condition" value={summary.good        || 0} color="emerald" sub="resaleable" />
          <KPICard label="Bad / Damaged"  value={summary.bad         || 0} color="rose"    sub="damaged returns" />
          <KPICard label="SPF Pending"    value={summary.spfPending  || 0} color="amber"   sub="bad + no SPF" />
        </div>
      )}

      {/* Info note about template */}
      <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-xs text-blue-800">
        <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>
          Download the Excel template pre-filled with all return orders → fill columns O–R (Received?, Condition, Date, Notes) →
          upload back. <strong>Condition: Good</strong> = no issue. <strong>Bad</strong> = damaged; system will auto-check if SPF
          (Seller Protection Fund) was received in <code>fk_settlement_orders.protection_fund</code>.
        </span>
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 bg-surface-container rounded-lg p-1">
          {[['all', 'All'], ['not-received', 'Not Received'], ['bad', 'Bad Returns'], ['spf-pending', 'SPF Pending']].map(([v, l]) => (
            <button key={v} onClick={() => { setFilter(v); setPage(1); }}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${filter === v ? 'bg-surface text-ink shadow-sm' : 'text-secondary hover:text-ink'}`}
            >{l}</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={handleDownload}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary-container text-primary border border-primary rounded-lg hover:bg-primary-container font-semibold transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Download Template
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
            onChange={e => handleUpload(e.target.files[0])} />
          <button onClick={() => fileRef.current?.click()} disabled={uploading}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-lg hover:bg-emerald-100 font-semibold transition-colors disabled:opacity-60"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l4-4m0 0l4 4m-4-4v12" />
            </svg>
            {uploading ? 'Uploading…' : 'Upload Returns'}
          </button>
        </div>
      </div>

      {/* Upload feedback */}
      {uploadMsg && (
        <div className={`px-4 py-2.5 rounded-lg text-sm flex items-center gap-2 ${uploadMsg.ok ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}`}>
          {uploadMsg.text}
          <button onClick={() => setUploadMsg(null)} className="ml-auto text-outline hover:text-secondary text-base leading-none">✕</button>
        </div>
      )}

      {/* Table */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">Return Tracker</h3>
          <span className="text-xs text-outline">{total.toLocaleString()} returns · page {page} of {totalPages || 1}</span>
        </div>
        {loading && !trackerData ? (
          <div className="p-8 text-center text-outline text-sm animate-pulse">Loading returns…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-outline text-sm">No returns found for this filter</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-surface-container-low border-b border-border">
                  {['Order ID','Return ID','SKU','Category','Return Type','Marketplace Status','Return Date','Order Date','Received?','Condition','SPF Status','Invoice Amt'].map(h => (
                    <th key={h} className={`px-3 py-2.5 text-secondary font-medium whitespace-nowrap ${['Order ID','Return ID','SKU','Category','Return Type','Marketplace Status'].includes(h) ? 'text-left' : 'text-right'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map(r => (
                  <tr key={r.order_item_id} className="hover:bg-surface-container-low/70">
                    <td className="px-3 py-2 font-mono text-[11px] text-ink">{r.order_id || '—'}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-ink">{r.order_item_id}</td>
                    <td className="px-3 py-2 text-secondary max-w-[150px] truncate" title={r.sku}>{r.sku || '—'}</td>
                    <td className="px-3 py-2 text-secondary">{r.category || '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${r.return_type === 'RTO' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`}>
                        {r.return_type || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-secondary max-w-[180px] truncate" title={r.return_status}>{r.return_status || '—'}</td>
                    <td className="px-3 py-2 text-right text-secondary">{r.return_date ? String(r.return_date).slice(0,10) : '—'}</td>
                    <td className="px-3 py-2 text-right text-secondary">{r.order_date  ? String(r.order_date).slice(0,10)  : '—'}</td>
                    <td className="px-3 py-2 text-right">
                      {r.is_received == null
                        ? <span className="text-outline">—</span>
                        : r.is_received
                          ? <span className="text-emerald-600 font-semibold">✓ Yes</span>
                          : <span className="text-amber-600 font-semibold">⏳ No</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.is_bad_return == null
                        ? <span className="text-outline">—</span>
                        : r.is_bad_return
                          ? <span className="text-rose-600 font-semibold">⚠ Bad</span>
                          : <span className="text-emerald-600 font-semibold">Good</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.is_bad_return
                        ? r.spf_received
                          ? <span className="text-sky-600 font-semibold text-[10px]">✓ SPF Rcvd</span>
                          : r.spf_deducted > 0
                            ? <span className="text-amber-600 font-semibold text-[10px]">Pending ₹{(+r.spf_deducted).toLocaleString('en-IN',{maximumFractionDigits:0})}</span>
                            : <span className="text-rose-500 text-[10px]">No SPF</span>
                        : <span className="text-outline">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-ink">
                      {r.invoice_amount
                        ? `₹${(+r.invoice_amount).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {loading && trackerData && <div className="border-t border-border p-3 text-center text-xs font-semibold text-outline">Refreshing return records…</div>}
        {totalPages > 1 && (
          <div className="px-5 py-3 border-t border-border flex items-center justify-between">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
              className="text-xs px-3 py-1.5 border border-border rounded-lg text-secondary hover:bg-surface-container-low disabled:opacity-40">← Prev</button>
            <span className="text-xs text-outline">Page {page} of {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
              className="text-xs px-3 py-1.5 border border-border rounded-lg text-secondary hover:bg-surface-container-low disabled:opacity-40">Next →</button>
          </div>
        )}
      </div>
    </div>
    </div>
  );
}

// ── Sub-view 2: Order Payment Status ─────────────────────────────────────────
