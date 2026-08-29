import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import ExportButton from '../components/ExportButton';
import { useAnimatedDisplayValue } from '../hooks/useAnimatedDisplayValue';
import useFetch from '../hooks/useFetch';
import {
  downloadMpInvoiceTemplate,
  fetchMarketplaceAccounts,
  fetchMpConfig,
  fetchMpInvoices,
  fetchRateCardConfigStatus,
  fetchMpLedger,
  fetchMpLedgerSummary,
  fetchSkuSettlementBenchmark,
  sendSkuSettlementBenchmarkNotification,
  uploadMpInvoices,
} from '../api/client';
import { AmazonReconciliationPanel } from './AmazonReconciliationPage';
import { FlipkartFeeAudit } from './RateAuditPage';

const MONEY = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const money = value => MONEY.format(Number(value || 0));
const PRESET_MARKETS = [
  { marketplace: 'flipkart', display_name: 'Flipkart', reco_type: 'order', color: 'indigo' },
  { marketplace: 'amazon', display_name: 'Amazon', reco_type: 'order', color: 'amber' },
  // Meesho does not yet have a source-payment format in this project. Show the
  // tab now, but do not invent an expected fee or call an unsupported parser.
  { marketplace: 'meesho', display_name: 'Meesho', reco_type: 'setup', color: 'emerald' },
];
const BENCHMARK_MARKETS = [
  { key: 'flipkart', label: 'Flipkart' },
  { key: 'amazon', label: 'Amazon' },
  { key: 'meesho', label: 'Meesho' },
  { key: 'myntra', label: 'Myntra' },
];

function downloadInvoiceExceptions(marketplace, summary, rows) {
  return {
    filename: `${marketplace}_Payment_Exceptions_${new Date().toISOString().slice(0, 10)}`,
    sheets: [
      {
        sheetName: 'Payment Summary',
        headers: ['Metric', 'Value'],
        rows: [
          ['Marketplace', marketplace], ['Invoices', summary.invoice_count || 0],
          ['Expected payment (Rs)', Number(summary.total_net_payable || 0)], ['Received (Rs)', Number(summary.total_received || 0)],
          ['Outstanding (Rs)', Number(summary.total_pending || 0)], ['Pending invoices', summary.pending_count || 0],
          ['Partial invoices', summary.partial_count || 0], ['Disputed invoices', summary.disputed_count || 0],
        ], colWidths: [30, 22],
      },
      {
        sheetName: 'Payment Exceptions',
        headers: ['Status', 'Invoice number', 'Invoice date', 'Seller account', 'SKU', 'Quantity', 'Invoice amount (Rs)', 'Expected payment (Rs)', 'Received (Rs)', 'Outstanding (Rs)', 'Payment reference', 'Notes'],
        rows: rows.map(row => [
          row.status, row.invoice_number || '', row.invoice_date || '', row.seller_account || 'default', row.sku || '', row.quantity || 1,
          Number(row.invoice_amount || 0), Number(row.net_payable || 0), Number(row.amount_received || 0), Math.max(0, Number(row.net_payable || 0) - Number(row.amount_received || 0)), row.payment_reference || '', row.notes || '',
        ]), colWidths: [14, 22, 14, 18, 22, 10, 18, 20, 16, 18, 22, 32],
      },
    ],
  };
}

function downloadLedgerExceptions(marketplace, summary, rows) {
  return {
    filename: `${marketplace}_Unreconciled_Ledger_${new Date().toISOString().slice(0, 10)}`,
    sheets: [
      {
        sheetName: 'Ledger Summary',
        headers: ['Metric', 'Value'],
        rows: [
          ['Marketplace', marketplace], ['Ledger entries', summary.entry_count || 0],
          ['Total credits (Rs)', Number(summary.total_credits || 0)], ['Total debits (Rs)', Number(summary.total_debits || 0)],
          ['Net balance (Rs)', Number(summary.net_balance || 0)], ['Unreconciled entries', summary.unreconciled_count || 0],
        ], colWidths: [30, 22],
      },
      {
        sheetName: 'Unreconciled Entries',
        headers: ['Date', 'Reference', 'Order ID', 'Entry type', 'Description', 'Debit (Rs)', 'Credit (Rs)', 'Running balance (Rs)', 'Notes'],
        rows: rows.map(row => [row.entry_date || '', row.reference_number || '', row.order_id || '', row.entry_type || '', row.description || '', Number(row.debit || 0), Number(row.credit || 0), Number(row.running_balance || 0), row.notes || '']),
        colWidths: [14, 22, 22, 16, 44, 16, 16, 20, 32],
      },
    ],
  };
}

function downloadSkuSettlementBenchmark(report) {
  const rows = report?.rows || [];
  const reportName = `${report?.marketplace || 'marketplace'}_SKU_Median_Price_${report?.month || 'report'}`;
  return {
    filename: reportName,
    sheets: [
      {
        sheetName: 'SKU Median Price',
        headers: ['Marketplace', 'Order month', 'Seller account', 'SKU', 'Median price per unit (Rs)'],
        rows: rows.map(row => [
          report.marketplace, report.month, row.seller_account || 'default', row.sku || '',
          Number(row.representative_settlement || 0),
        ]),
        colWidths: [15, 16, 18, 28, 28],
      },
    ],
  };
}

function LoadingPanel({ label }) {
  return <div className="rounded-xl border border-border bg-surface p-10 text-center text-sm text-secondary">Loading {label} payment data…</div>;
}

function MyntraAccountToolbar({ accounts, sellerAccount, onAccountChange, onUploaded }) {
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const selectedName = accounts.find(account => account.account_id === sellerAccount)?.display_name || 'an account';

  const downloadTemplate = async () => {
    try {
      const blob = await downloadMpInvoiceTemplate('myntra');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'myntra-payment-template.xlsx';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(`Template download failed: ${error?.response?.data?.error || error.message}`);
    }
  };

  const uploadFile = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!sellerAccount) {
      setMessage('Select Myntra (VB) or Myntra (EJ) before choosing a file.');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setMessage('This file is larger than the 20 MB invoice upload limit.');
      return;
    }

    setUploading(true);
    setMessage('Uploading and assigning every row to the selected account…');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const result = await uploadMpInvoices('myntra', formData, sellerAccount);
      setMessage(`${result.inserted || 0} rows imported to ${selectedName}${result.skipped ? `; ${result.skipped} skipped` : ''}.`);
      onUploaded();
    } catch (error) {
      setMessage(error?.response?.data?.error || error.message || 'Myntra upload failed.');
    } finally {
      setUploading(false);
    }
  };

  return <div className="rounded-xl border border-pink-200 bg-pink-50/70 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-sm font-bold text-ink">Myntra account and file</h2>
        <p className="mt-1 text-xs leading-relaxed text-secondary">Choose the account first. The whole uploaded file is stored under that account, so VB and EJ payments, exceptions, and rate cards cannot mix.</p>
      </div>
      <button type="button" onClick={downloadTemplate} className="rounded-lg border border-pink-200 bg-surface px-3 py-2 text-xs font-bold text-pink-700 hover:bg-pink-100">Download template</button>
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <label className="text-xs font-bold text-secondary" htmlFor="myntra-account">View account</label>
      <select id="myntra-account" value={sellerAccount} onChange={event => onAccountChange(event.target.value)} disabled={!accounts.length || uploading} className="rounded-lg border border-pink-200 bg-surface px-3 py-2 text-xs font-semibold text-ink outline-none focus:border-pink-400">
        <option value="">All Myntra accounts</option>
        {accounts.map(account => <option key={account.account_id} value={account.account_id}>{account.display_name}</option>)}
      </select>
      <label className={`cursor-pointer rounded-lg px-3 py-2 text-xs font-bold text-white ${sellerAccount && !uploading ? 'bg-pink-600 hover:bg-pink-700' : 'cursor-not-allowed bg-surface-container-highest'}`}>
        <input type="file" accept=".xlsx,.xls,.csv" className="sr-only" disabled={!sellerAccount || uploading} onChange={uploadFile} />
        {uploading ? 'Uploading…' : `Upload for ${selectedName}`}
      </label>
    </div>
    {message && <p className={`mt-3 text-xs ${message.includes('failed') || message.includes('Select ') || message.includes('larger') ? 'text-rose-700' : 'text-secondary'}`}>{message}</p>}
  </div>;
}

function InvoicePaymentPanel({ market }) {
  const isMyntra = market.marketplace === 'myntra';
  const [sellerAccount, setSellerAccount] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [viewTab, setViewTab] = useState('exceptions'); // 'exceptions' | 'rate_audit' | 'all'
  const { data: accountData } = useFetch(
    () => isMyntra ? fetchMarketplaceAccounts('myntra') : Promise.resolve({ accounts: [] }),
    [isMyntra]
  );
  const accounts = accountData?.accounts || [];

  useEffect(() => {
    if (!isMyntra) {
      setSellerAccount('');
      return;
    }
    if (accounts.length && !accounts.some(account => account.account_id === sellerAccount)) {
      setSellerAccount(accounts[0].account_id);
    }
  }, [isMyntra, accountData, sellerAccount, accounts]);

  const { data, loading, error } = useFetch(
    () => fetchMpInvoices(market.marketplace, '', 1, 500, sellerAccount, refreshKey),
    [market.marketplace, sellerAccount, refreshKey]
  );
  const { data: rateCardStatus } = useFetch(
    () => fetchRateCardConfigStatus(market.marketplace, sellerAccount || 'default', refreshKey),
    [market.marketplace, sellerAccount, refreshKey]
  );

  const summary = data?.summary?.[0] || {};
  const allRows = data?.data || [];
  const paymentExceptions = allRows.filter(row => row.status !== 'Paid');
  const rateDiscrepancies = allRows.filter(row => row.rate_card_status === 'overcharged' || row.rate_card_status === 'undercharged');
  const rateOvercharges = rateDiscrepancies.filter(row => row.rate_card_status === 'overcharged');
  const totalOvercharge = rateOvercharges.reduce((sum, row) => sum + Math.max(0, Number(row.commission_variance || 0)), 0);
  const matchedRateRows = allRows.filter(row => row.rate_card_status === 'matched').length;
  // Invoice audit currently applies the legacy commission table, so a fixed or
  // shipping rule alone must not be presented as an active commission audit.
  const commissionRuleCount = Number(rateCardStatus?.breakdown?.commission || 0);
  const rateCardConfigured = commissionRuleCount > 0;

  const displayedRows = viewTab === 'rate_audit'
    ? rateDiscrepancies
    : viewTab === 'all'
    ? allRows
    : paymentExceptions;

  if (loading) return <LoadingPanel label={market.display_name} />;
  if (error) return <ProblemPanel message={error} />;

  return <section className="space-y-4">
    {isMyntra && <MyntraAccountToolbar accounts={accounts} sellerAccount={sellerAccount} onAccountChange={setSellerAccount} onUploaded={() => setRefreshKey(value => value + 1)} />}

    {/* Rate Card Integration Status Banner */}
    <div className={`rounded-xl border p-4 transition ${!rateCardStatus ? 'border-border bg-surface-container-low/70' : rateCardConfigured ? 'border-primary bg-gradient-to-r from-indigo-50/80 to-blue-50/60' : 'border-amber-200 bg-amber-50/70'}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl font-bold text-lg ${!rateCardStatus ? 'bg-surface-container-highest text-white' : rateCardConfigured ? 'bg-primary text-white shadow-sm' : 'bg-amber-500 text-white'}`}>
            {!rateCardStatus ? '…' : rateCardConfigured ? '✓' : '⚠️'}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-ink">
                Rate Card Integration: {!rateCardStatus ? 'Checking configured rules…' : rateCardConfigured ? `${commissionRuleCount} Active Commission Rule${commissionRuleCount > 1 ? 's' : ''}` : 'No Commission Rules Configured'}
              </h3>
              <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${!rateCardStatus ? 'bg-surface-container-high text-secondary' : rateCardConfigured ? 'bg-primary-container text-primary' : 'bg-amber-100 text-amber-800'}`}>
                {!rateCardStatus ? 'Checking' : rateCardConfigured ? 'Active Audit' : 'Action Needed'}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-secondary">
              {rateCardConfigured
                ? `Auditing invoice commission deductions against verified commercial rate card for ${sellerAccount || market.display_name}.`
                : rateCardStatus ? `Add commission percentage slabs in Rate Card Config to automatically detect and flag overcharged invoices.` : 'Verifying the active rate-card configuration.'}
            </p>
          </div>
        </div>
        <Link
          to={`/rate-card?marketplace=${market.marketplace}&account=${sellerAccount || 'default'}`}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-bold text-white shadow-sm hover:bg-primary transition"
        >
          <span>⚙️</span>
          <span>Configure {market.display_name} Rate Card</span>
        </Link>
      </div>
      {rateCardConfigured && rateOvercharges.length > 0 && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-rose-100/80 px-3 py-2 text-xs font-semibold text-rose-800">
          <span>🚨</span>
          <span><b>{rateOvercharges.length} invoice{rateOvercharges.length > 1 ? 's have' : ' has'} commission overcharges</b> totaling <b>{money(totalOvercharge)}</b> above contracted rates.</span>
        </div>
      )}
    </div>

    {!data?.total ? <NoDataPanel market={market} source="invoice/payment" /> : <>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-bold text-ink">Invoice Payment & Rate Audit</h2>
        <p className="mt-1 text-xs text-secondary">Cross-verifying payment receipts and rate card commission deductions.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-border bg-surface-container p-0.5 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setViewTab('exceptions')}
            className={`rounded-md px-3 py-1.5 transition ${viewTab === 'exceptions' ? 'bg-surface text-ink shadow-sm' : 'text-secondary hover:text-ink'}`}
          >
            Payment Exceptions ({paymentExceptions.length})
          </button>
          <button
            type="button"
            onClick={() => setViewTab('rate_audit')}
            className={`rounded-md px-3 py-1.5 transition ${viewTab === 'rate_audit' ? 'bg-surface text-ink shadow-sm' : 'text-secondary hover:text-ink'}`}
          >
            Rate Discrepancies ({rateDiscrepancies.length})
          </button>
          <button
            type="button"
            onClick={() => setViewTab('all')}
            className={`rounded-md px-3 py-1.5 transition ${viewTab === 'all' ? 'bg-surface text-ink shadow-sm' : 'text-secondary hover:text-ink'}`}
          >
            All Invoices ({allRows.length})
          </button>
        </div>
        <ExportButton label="Download exception file" disabled={!displayedRows.length} buildExport={() => downloadInvoiceExceptions(market.display_name, summary, displayedRows)} />
      </div>
    </div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Expected payment" value={money(summary.total_net_payable)} />
      <Metric label="Payment received" value={money(summary.total_received)} tone="emerald" />
      <Metric label="Outstanding" value={money(summary.total_pending)} tone="rose" />
      <Metric
        label="Rate Overcharges"
        value={money(totalOvercharge)}
        sub={`${rateOvercharges.length} invoice overcharges · ${matchedRateRows} matched`}
        tone={rateOvercharges.length ? 'rose' : 'emerald'}
      />
    </div>
    <ExceptionTable rows={displayedRows} type="invoice" />
    </>}
  </section>;
}

function LedgerPaymentPanel({ market }) {
  const { data, loading, error } = useFetch(() => fetchMpLedger(market.marketplace, '', 1, 500), [market.marketplace]);
  const { data: summaryData } = useFetch(() => fetchMpLedgerSummary(market.marketplace), [market.marketplace]);
  // /ledger is deliberately paged. The summary endpoint is aggregated but the
  // row endpoint is the source for the case file, capped at its safe API limit.
  const summary = summaryData?.[0] || {};
  const exceptions = (data?.data || []).filter(row => !row.is_reconciled);
  if (loading) return <LoadingPanel label={market.display_name} />;
  if (error) return <ProblemPanel message={error} />;
  if (!data?.total) return <NoDataPanel market={market} source="ledger" />;
  return <section className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-base font-bold text-ink">Unreconciled ledger entries</h2><p className="mt-1 text-xs text-secondary">These entries need review before they are treated as cleared. A fee leak is not asserted without an approved rate rule.</p></div>
      <ExportButton label="Download exception file" disabled={!exceptions.length} buildExport={() => downloadLedgerExceptions(market.display_name, summary, exceptions)} />
    </div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Credits" value={money(summary.total_credits)} tone="emerald" />
      <Metric label="Debits" value={money(summary.total_debits)} tone="amber" />
      <Metric label="Net balance" value={money(summary.net_balance)} />
      <Metric label="Needs reconciliation" value={summary.unreconciled_count || 0} tone={(summary.unreconciled_count || 0) ? 'rose' : 'emerald'} />
    </div>
    <ExceptionTable rows={exceptions} type="ledger" />
  </section>;
}

function Metric({ label, value, sub, tone = 'slate' }) {
  const tones = { slate: 'border-border bg-surface', emerald: 'border-emerald-200 bg-emerald-50', rose: 'border-rose-200 bg-rose-50', amber: 'border-amber-200 bg-amber-50' };
  const animatedValue = useAnimatedDisplayValue(value);
  return <div className={`rounded-xl border p-4 ${tones[tone] || tones.slate}`}><p className="text-[11px] font-bold uppercase tracking-[0.1em] text-secondary">{label}</p><p className="mt-1 text-xl font-bold tabular-nums text-ink">{animatedValue}</p>{sub && <p className="mt-1 text-xs text-secondary">{sub}</p>}</div>;
}

function ExceptionTable({ rows, type }) {
  if (!rows.length) return <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-sm text-emerald-800">No records found for the selected view.</div>;
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full min-w-[960px] text-xs">
        <thead className="bg-surface-container-low text-left text-secondary">
          <tr>
            {type === 'invoice' ? (
              <>
                <th className="px-3 py-2.5 font-semibold">Payment</th>
                <th className="px-3 py-2.5 font-semibold">Rate Audit</th>
                <th className="px-3 py-2.5 font-semibold">Invoice</th>
                <th className="px-3 py-2.5 font-semibold">Date</th>
                <th className="px-3 py-2.5 font-semibold">Account</th>
                <th className="px-3 py-2.5 font-semibold">SKU</th>
                <th className="px-3 py-2.5 text-right font-semibold">Invoice ₹</th>
                <th className="px-3 py-2.5 text-right font-semibold">Comm Charged</th>
                <th className="px-3 py-2.5 text-right font-semibold">Rate Card Exp.</th>
                <th className="px-3 py-2.5 text-right font-semibold">Variance</th>
                <th className="px-3 py-2.5 text-right font-semibold">Expected Payout</th>
                <th className="px-3 py-2.5 text-right font-semibold">Received</th>
                <th className="px-3 py-2.5 text-right font-semibold">Outstanding</th>
              </>
            ) : (
              ['Date', 'Reference', 'Order ID', 'Type', 'Description', 'Debit', 'Credit', 'Status'].map(label => (
                <th key={label} className="px-3 py-2.5 font-semibold">{label}</th>
              ))
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map(row => type === 'invoice' ? (
            <tr key={row.id} className={row.rate_card_status === 'overcharged' ? 'bg-rose-50/40 hover:bg-rose-50/70' : 'hover:bg-surface-container-low/70'}>
              <td className="px-3 py-2.5">
                <span className={`rounded-full px-2 py-0.5 font-bold ${row.status === 'Paid' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                  {row.status}
                </span>
              </td>
              <td className="px-3 py-2.5">
                <span className={`rounded-full px-2 py-0.5 font-bold ${
                  row.rate_card_status === 'matched' ? 'bg-emerald-100 text-emerald-700'
                  : row.rate_card_status === 'overcharged' ? 'bg-rose-100 text-rose-700'
                  : row.rate_card_status === 'undercharged' ? 'bg-sky-100 text-sky-700'
                  : 'bg-surface-container text-secondary'
                }`}>
                  {row.rate_card_status === 'matched' ? 'Matched'
                   : row.rate_card_status === 'overcharged' ? 'Overcharge'
                   : row.rate_card_status === 'undercharged' ? 'Below Rate'
                   : 'No Rule'}
                </span>
              </td>
              <td className="px-3 py-2.5 font-semibold text-ink">{row.invoice_number || '—'}</td>
              <td className="px-3 py-2.5 text-secondary">{row.invoice_date || '—'}</td>
              <td className="px-3 py-2.5 text-secondary">{row.seller_account || 'default'}</td>
              <td className="px-3 py-2.5 text-secondary">{row.sku || '—'}</td>
              <td className="px-3 py-2.5 text-right font-medium text-ink">{money(row.invoice_amount)}</td>
              <td className="px-3 py-2.5 text-right text-secondary">
                {row.commission_pct ? `${row.commission_pct}%` : '—'} <span className="text-[11px] text-outline">({money(row.commission_amount)})</span>
              </td>
              <td className="px-3 py-2.5 text-right text-secondary">
                {row.expected_commission_pct !== null && row.expected_commission_pct !== undefined ? `${row.expected_commission_pct}%` : '—'}
              </td>
              <td className={`px-3 py-2.5 text-right font-bold ${
                (row.commission_variance || 0) > 2 ? 'text-rose-600' : (row.commission_variance || 0) < -2 ? 'text-sky-600' : 'text-secondary'
              }`}>
                {row.expected_commission_amount !== null && row.expected_commission_amount !== undefined ? `${(row.commission_variance || 0) > 0 ? '+' : ''}${money(row.commission_variance)}` : '—'}
              </td>
              <td className="px-3 py-2.5 text-right font-semibold text-ink">{money(row.net_payable)}</td>
              <td className="px-3 py-2.5 text-right text-emerald-700">{money(row.amount_received)}</td>
              <td className="px-3 py-2.5 text-right font-bold text-rose-600">
                {money(Math.max(0, Number(row.net_payable || 0) - Number(row.amount_received || 0)))}
              </td>
            </tr>
          ) : (
            <tr key={row.id} className="hover:bg-surface-container-low/70">
              <td className="px-3 py-2.5 text-secondary">{row.entry_date || '—'}</td>
              <td className="px-3 py-2.5 font-semibold text-ink">{row.reference_number || '—'}</td>
              <td className="px-3 py-2.5 text-secondary">{row.order_id || '—'}</td>
              <td className="px-3 py-2.5 text-secondary">{row.entry_type || '—'}</td>
              <td className="max-w-xs truncate px-3 py-2.5 text-secondary">{row.description || '—'}</td>
              <td className="px-3 py-2.5 text-right">{money(row.debit)}</td>
              <td className="px-3 py-2.5 text-right">{money(row.credit)}</td>
              <td className="px-3 py-2.5"><span className="rounded-full bg-rose-100 px-2 py-0.5 font-bold text-rose-700">Review</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NoDataPanel({ market, source }) {
  return <div className="rounded-xl border border-dashed border-border bg-surface p-8 text-center"><p className="font-semibold text-ink">No {market.display_name} {source} data has been imported.</p><p className="mt-1 text-sm text-secondary">Once the payment file is uploaded, exceptions and the downloadable case file will appear in this tab.</p><Link to="/upload" className="mt-4 inline-flex rounded-lg border border-primary bg-primary-container px-3 py-2 text-xs font-bold text-primary">Open data upload</Link></div>;
}

function ProblemPanel({ message }) {
  return <div className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">Could not load this payment data: {message}</div>;
}

function SetupPanel({ market }) {
  const isMeesho = market.marketplace === 'meesho';
  return <div className="rounded-xl border border-dashed border-border bg-surface p-8">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-bold text-ink">{market.display_name} payment mapping is not configured yet</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-secondary">{isMeesho ? 'Meesho is included here so the finance team has one fixed payment workspace. Its settlement format and verified rate-card rules have not been supplied yet, so this app will not guess a fee leak or produce incorrect amounts.' : 'This marketplace needs its settlement format and verified rate-card rules before fee discrepancies can be calculated.'}</p>
        <p className="mt-3 text-xs text-secondary">After the payment file is mapped, this tab will show only supported payment exceptions and the download button will create a case-ready file from the imported evidence.</p>
      </div>
      <Link
        to={`/rate-card?marketplace=${market.marketplace}`}
        className="inline-flex items-center gap-1.5 rounded-lg border border-primary bg-primary-container px-3 py-2 text-xs font-bold text-primary hover:bg-primary-container"
      >
        <span>⚙️</span>
        <span>Configure Rate Card</span>
      </Link>
    </div>
    <div className="mt-4 flex gap-2">
      <Link to="/upload" className="inline-flex rounded-lg bg-primary px-3 py-2 text-xs font-bold text-white">Open data upload</Link>
    </div>
  </div>;
}

function SettlementBenchmarkPanel() {
  const [marketplace, setMarketplace] = useState('flipkart');
  const [month, setMonth] = useState('');
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const { data: report, loading, error } = useFetch(
    () => fetchSkuSettlementBenchmark(marketplace, month),
    [marketplace, month]
  );

  const switchMarketplace = value => {
    setMarketplace(value);
    setMonth('');
    setNotice('');
  };
  const sendAlerts = async () => {
    if (!report?.month || sending) return;
    setSending(true);
    setNotice('Sending the reviewed alert list…');
    try {
      const result = await sendSkuSettlementBenchmarkNotification(marketplace, report.month);
      setNotice(result.status === 'accepted' ? 'Alert email accepted by Resend for payments@youthnic.shop.' : (result.reason || result.error_message || `Email status: ${result.status}`));
    } catch (sendError) {
      setNotice(sendError?.response?.data?.error || sendError.message || 'Could not send the alert email.');
    } finally {
      setSending(false);
    }
  };

  if (loading) return <LoadingPanel label="SKU settlement benchmark" />;
  if (error) return <ProblemPanel message={error} />;
  const rows = report?.rows || [];
  const availableMonths = report?.availableMonths || [];
  const activeMonth = month || report?.month || '';
  return <section className="space-y-4">
    <div className="rounded-xl border border-primary bg-primary-container p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-ink">SKU median price</h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-secondary">The selected month is the <b>order month</b>, never payment or settlement month. Only delivered sales with a positive settlement and no return/refund/cancellation/RTO evidence are included. ₹429.50, ₹430.00, and ₹430.50 support the ₹430 median-price band.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select aria-label="Benchmark marketplace" value={marketplace} onChange={event => switchMarketplace(event.target.value)} className="rounded-lg border border-primary bg-surface px-3 py-2 text-xs font-bold text-ink outline-none focus:border-primary">
            {BENCHMARK_MARKETS.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select>
          <select aria-label="Order month" value={activeMonth || ''} disabled={!availableMonths.length} onChange={event => { setMonth(event.target.value); setNotice(''); }} className="rounded-lg border border-primary bg-surface px-3 py-2 text-xs font-bold text-ink outline-none focus:border-primary">
            {!availableMonths.length && <option value="">No eligible order month</option>}
            {availableMonths.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
          <ExportButton label="Download median-price file" disabled={!rows.length} buildExport={() => downloadSkuSettlementBenchmark(report)} />
        </div>
      </div>
      {report?.sourceMessage && <p className="mt-3 text-xs text-secondary">{report.sourceMessage}</p>}
    </div>

    {!report?.sourceReady ? <div className="rounded-xl border border-dashed border-border bg-surface p-7 text-sm text-secondary">This benchmark source is not available yet. No placeholder settlement values are being used.</div> : !rows.length ? <div className="rounded-xl border border-dashed border-border bg-surface p-7 text-sm text-secondary">No eligible settled-sale rows were found for this month.</div> : <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="SKUs benchmarked" value={report.summary?.skuCount || 0} />
        <Metric label="Delivered sale lines" value={report.summary?.deliveredOrders || 0} tone="emerald" />
        <Metric label="Units included" value={report.summary?.units || 0} />
        <Metric label="Change alerts" value={report.summary?.alerts || 0} sub="Representative settlement moved > ₹2" tone={(report.summary?.alerts || 0) ? 'amber' : 'emerald'} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3">
        <p className="text-xs text-secondary">Alerts compare {report.month} with {report.previousMonth}. A new settlement import automatically queues one email when Resend is configured; use this button to send the reviewed list manually.</p>
        <button type="button" disabled={!report.summary?.alerts || sending} onClick={sendAlerts} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800 disabled:cursor-not-allowed disabled:opacity-50">{sending ? 'Sending…' : `Email ${report.summary?.alerts || 0} alert${report.summary?.alerts === 1 ? '' : 's'}`}</button>
      </div>
      {notice && <p className={`rounded-lg px-3 py-2 text-xs ${notice.includes('Could not') ? 'bg-rose-50 text-rose-700' : 'bg-surface-container text-secondary'}`}>{notice}</p>}
      <div className="overflow-x-auto rounded-xl border border-border bg-surface"><table className="w-full min-w-[880px] text-xs"><thead className="bg-surface-container-low text-left text-secondary"><tr>{['SKU', 'Account', 'Delivered sale lines', 'Units', 'Median price / unit', 'Previous month', 'Change', 'Status'].map(label => <th key={label} className="px-3 py-2.5 font-semibold">{label}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{rows.map(row => <tr key={`${row.seller_account}:${row.sku}`} className={row.has_change_alert ? 'bg-amber-50/60' : ''}><td className="px-3 py-2.5 font-semibold text-ink">{row.sku}</td><td className="px-3 py-2.5 text-secondary">{row.seller_account || 'default'}</td><td className="px-3 py-2.5 text-right">{row.delivered_orders}</td><td className="px-3 py-2.5 text-right">{row.units}</td><td className="px-3 py-2.5 text-right font-bold text-ink">{money(row.representative_settlement)}</td><td className="px-3 py-2.5 text-right">{row.previous_representative_settlement === null ? '—' : money(row.previous_representative_settlement)}</td><td className={`px-3 py-2.5 text-right font-bold ${row.has_change_alert ? 'text-amber-800' : 'text-secondary'}`}>{row.change_from_previous === null ? '—' : `${row.change_from_previous > 0 ? '+' : ''}${money(row.change_from_previous)}`}</td><td className="px-3 py-2.5">{row.has_change_alert ? <span className="rounded-full bg-amber-100 px-2 py-0.5 font-bold text-amber-800">Review</span> : <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-bold text-emerald-700">Normal</span>}</td></tr>)}</tbody></table></div>
    </>}
  </section>;
}

export default function PaymentReconciliationPage() {
  const { data: config, loading: configLoading, error: configError } = useFetch(fetchMpConfig, []);
  const markets = useMemo(() => {
    const all = [...PRESET_MARKETS];
    (config || []).filter(row => row.is_active).forEach(row => {
      const index = all.findIndex(item => item.marketplace === row.marketplace);
      if (index >= 0) all[index] = { ...all[index], ...row };
      else all.push(row);
    });
    const priority = ['flipkart', 'amazon', 'myntra', 'meesho'];
    return all.sort((a, b) => (priority.indexOf(a.marketplace) + 1 || 99) - (priority.indexOf(b.marketplace) + 1 || 99));
  }, [config]);
  const [activeKey, setActiveKey] = useState('flipkart');
  const active = markets.find(market => market.marketplace === activeKey) || markets[0];

  useEffect(() => {
    if (activeKey !== 'sku-benchmark' && markets.length && !markets.some(market => market.marketplace === activeKey)) setActiveKey(markets[0].marketplace);
  }, [markets, activeKey]);

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <PageHeader title="Payment Check" subtitle="One place to review marketplace payments, fee discrepancies, pending payouts, and downloadable case evidence." />
      <Link
        to={`/rate-card?marketplace=${active?.marketplace || 'flipkart'}`}
        className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-primary transition"
      >
        <span>⚙️</span>
        <span>Configure Rate Cards</span>
      </Link>
    </div>
    <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-relaxed text-blue-900"><b>Safe discrepancy rule:</b> a fee is called a potential leak only when an imported payment charge exceeds a verified rate-card rule. Missing rate cards and return credits stay visible but are not labelled as an overcharge.</div>
    {configError && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">Marketplace configuration could not be refreshed. Showing the core payment tabs.</div>}
    <div className="flex gap-2 overflow-x-auto rounded-xl border border-border bg-surface p-2" role="tablist" aria-label="Marketplace payment checks">
      <button type="button" onClick={() => setActiveKey('sku-benchmark')} role="tab" aria-selected={activeKey === 'sku-benchmark'} className={`shrink-0 rounded-lg px-4 py-2 text-sm font-bold transition ${activeKey === 'sku-benchmark' ? 'bg-primary text-white shadow-sm' : 'text-secondary hover:bg-surface-container-low'}`}>SKU Benchmark</button>
      {markets.map(market => <button key={market.marketplace} type="button" onClick={() => setActiveKey(market.marketplace)} role="tab" aria-selected={activeKey === market.marketplace} className={`shrink-0 rounded-lg px-4 py-2 text-sm font-bold transition ${activeKey === market.marketplace ? 'bg-primary text-white shadow-sm' : 'text-secondary hover:bg-surface-container-low'}`}>{market.display_name}{market.reco_type === 'setup' && <span className="ml-1.5 text-[10px] font-medium opacity-70">Setup</span>}</button>)}
    </div>
    {configLoading && !config ? <LoadingPanel label="marketplace configuration" /> : activeKey === 'sku-benchmark' ? <SettlementBenchmarkPanel /> : active?.marketplace === 'flipkart' ? <FlipkartFeeAudit embedded /> : active?.marketplace === 'amazon' ? <AmazonReconciliationPanel embedded /> : active?.reco_type === 'invoice' ? <InvoicePaymentPanel market={active} /> : active?.reco_type === 'ledger' ? <LedgerPaymentPanel market={active} /> : <SetupPanel market={active || PRESET_MARKETS[0]} />}
  </div>;
}
