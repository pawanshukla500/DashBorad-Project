import { useState, useRef, useCallback, useEffect } from 'react';
import { fetchUploadStatus, fetchUploadHistory, downloadTemplate, uploadDataFile, uploadFkSettlement, pollFkProgress, saveUploadRemark, clearUploadData, fetchSkippedRows, pushSettlementReport, uploadAmazonSettlement, pollAmazonSettlementProgress, uploadMeeshoSettlement, fetchLinkageHealth, downloadMpInvoiceTemplate, uploadMpInvoices, downloadMyntraTemplate, uploadMyntraData, invalidateApiReadCache } from '../api/client';

// ── Constants ──────────────────────────────────────────────────────────────────
const MARKETPLACES = [
  { id: 'flipkart', label: 'Flipkart',
    cls:    'bg-primary-container border-primary text-primary',
    active: 'bg-primary border-primary text-white shadow-sm',
    logo: (
      <svg viewBox="0 0 32 32" className="w-5 h-5 shrink-0" fill="none">
        <rect width="32" height="32" rx="6" fill="#2874F0"/>
        <text x="16" y="22" textAnchor="middle" fontSize="13" fontWeight="bold" fill="white" fontFamily="Arial">FK</text>
      </svg>
    ),
  },
  { id: 'amazon', label: 'Amazon',
    cls:    'bg-amber-50 border-amber-200 text-amber-800',
    active: 'bg-amber-500 border-amber-500 text-white shadow-sm',
    logo: (
      <svg viewBox="0 0 32 32" className="w-5 h-5 shrink-0" fill="none">
        <rect width="32" height="32" rx="6" fill="#FF9900"/>
        <text x="16" y="22" textAnchor="middle" fontSize="11" fontWeight="bold" fill="white" fontFamily="Arial">AM</text>
      </svg>
    ),
  },
  { id: 'myntra', label: 'Myntra',
    cls:    'bg-pink-50 border-pink-200 text-pink-700',
    active: 'bg-pink-600 border-pink-600 text-white shadow-sm',
    logo: (
      <svg viewBox="0 0 32 32" className="w-5 h-5 shrink-0" fill="none">
        <rect width="32" height="32" rx="6" fill="#FF3F6C"/>
        <text x="16" y="22" textAnchor="middle" fontSize="11" fontWeight="bold" fill="white" fontFamily="Arial">MY</text>
      </svg>
    ),
  },
  { id: 'meesho', label: 'Meesho',
    cls:    'bg-purple-50 border-purple-200 text-purple-700',
    active: 'bg-purple-600 border-purple-600 text-white shadow-sm',
    logo: (
      <svg viewBox="0 0 32 32" className="w-5 h-5 shrink-0" fill="none">
        <rect width="32" height="32" rx="6" fill="#9C27B0"/>
        <text x="16" y="22" textAnchor="middle" fontSize="11" fontWeight="bold" fill="white" fontFamily="Arial">ME</text>
      </svg>
    ),
  },
  { id: 'custom', label: 'Custom',
    cls:    'bg-surface-container-low border-border text-secondary',
    active: 'bg-primary border-primary text-white shadow-sm',
    logo: (
      <svg viewBox="0 0 32 32" className="w-5 h-5 shrink-0" fill="none">
        <rect width="32" height="32" rx="6" fill="#475569"/>
        <text x="16" y="22" textAnchor="middle" fontSize="13" fontWeight="bold" fill="white" fontFamily="Arial">···</text>
      </svg>
    ),
  },
];

const DATA_TYPES = [
  { key: 'orders',        label: 'Sales / Orders',       icon: '📦', uniqueKey: 'Order Item ID' },
  { key: 'returns',       label: 'Returns',              icon: '↩️', uniqueKey: 'return_id' },
  { key: 'fk-settlement', label: 'FK Settlement Report', icon: '🔒', uniqueKey: 'Multi-sheet', multiSheet: true },
  { key: 'amazon-sale-orders', label: 'Sale Orders', icon: '📦', uniqueKey: '(Amazon Order Id, Merchant SKU)',
    blurb: 'Amazon Sale Order export — the 14-column template with shipment, FC, product, shipping and gift amounts.',
    checklistStep: 1 },
  { key: 'amazon-fba-returns',   label: 'FBA Returns',          icon: '🔁', uniqueKey: 'license-plate-number',
    blurb: 'Amazon-fulfilled returns — keyed by LPN; links to orders via (order_id, sku)',
    checklistStep: 3 },
  { key: 'amazon-flex-returns',  label: 'Flex Returns',         icon: '🚚', uniqueKey: 'RMA ID',
    blurb: 'Seller-fulfilled (Flex) returns — keyed by RMA ID; links via (order_id, mSKU)',
    checklistStep: 3 },
  { key: 'amazon-settlement',    label: 'Settlement (Payment)', icon: '📊', uniqueKey: 'settlement-id',
    blurb: 'Flat-File V2 — long-format. Fulfillment-Fee-Refund rows link via order_id (no sku/item-id needed).',
    checklistStep: 4 },
  { key: 'meesho-settlement', label: 'Settlement (Payment)', icon: '💰', uniqueKey: 'Transaction ID',
    blurb: 'Meesho Payments Excel file containing Order Payments, Ads Cost, Referral Payments, and Compensation.' },
  { key: 'myntra-orders', label: 'Sales / Orders', icon: '📦', uniqueKey: 'Order Line ID',
    blurb: 'Myntra Order Layout only. Order Release ID is stored as the order ID and Order Line ID as the order item ID. PPMP is treated as Non-FBM; other PO types are FBM.' },
  { key: 'myntra-returns', label: 'Returns', icon: '↩️', uniqueKey: 'Order Line ID',
    blurb: 'Myntra Return Layout only. Return Order ID and Order Line ID link to the uploaded order for the same selected Myntra account.' },
  { key: 'myntra-invoices', label: 'Invoice / Payment', icon: '🧾', uniqueKey: 'Invoice Number',
    blurb: 'Myntra invoice/payment file. The selected Data Center account is stored on every row and can never mix with the other Myntra account.' },
  { key: 'settlements', label: 'Settlement (Payment)', icon: '📊', uniqueKey: 'settlement_id',
    blurb: 'Generic settlement / payment file upload.' },
];

const MYNTRA_ACCOUNT_TABS = [
  { marketplace: 'myntra', sellerAccount: 'myntra_ej', label: 'Myntra (EJ)', active: 'bg-pink-600 border-pink-600 text-white shadow-sm' },
  { marketplace: 'myntra', sellerAccount: 'myntra_vb', label: 'Myntra (VB)', active: 'bg-fuchsia-700 border-fuchsia-700 text-white shadow-sm' },
];

const MYNTRA_DATA_TYPES = new Set(['myntra-orders', 'myntra-returns', 'myntra-invoices']);
const DATA_TYPE_KEYS_BY_MARKETPLACE = Object.freeze({
  flipkart: ['orders', 'returns', 'fk-settlement'],
  amazon: ['amazon-sale-orders', 'amazon-fba-returns', 'amazon-flex-returns', 'amazon-settlement'],
  meesho: ['orders', 'returns', 'meesho-settlement'],
  // Myntra follows the same three-stage order → return → payment flow as
  // Flipkart, but payment is its account-scoped invoice/payment importer.
  myntra: ['myntra-orders', 'myntra-returns', 'myntra-invoices'],
});
const dataTypesForMarketplace = marketplace => {
  const allowed = new Set(DATA_TYPE_KEYS_BY_MARKETPLACE[marketplace] || []);
  return DATA_TYPES.filter(type => allowed.has(type.key));
};
const myntraLogType = (sellerAccount, dataType) => {
  const suffix = {
    'myntra-orders': 'orders',
    'myntra-returns': 'returns',
    'myntra-invoices': 'invoices',
  }[dataType];
  return suffix && sellerAccount ? `${sellerAccount}_${suffix}` : '';
};

export default function UploadPage() {
  const [dbStatus, setDbStatus] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [linkage, setLinkage]   = useState(null);

  const [marketplace, setMarketplace] = useState('flipkart');
  const [sellerAccount, setSellerAccount] = useState('');
  const [dataType, setDataType]       = useState('orders');
  const [step, setStep]               = useState('drop'); // 'drop' | 'map' | 'result'
  const [file, setFile]               = useState(null);
  const [uploading, setUploading]     = useState(false);
  const [progress, setProgress]       = useState(null);
  const [result, setResult]           = useState(null);
  const [resultContext, setResultContext] = useState(null);
  const [error, setError]             = useState(null);
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);

  const refreshStatus = useCallback(async () => {
    try {
      const [d, h] = await Promise.all([
        fetchUploadStatus(),
        ['flipkart', 'amazon'].includes(marketplace) ? fetchLinkageHealth(marketplace) : Promise.resolve(null),
      ]);
      setDbStatus(d);
      setLinkage(h);
    } catch {
      setDbStatus({ configured: false, logs: [], counts: {} });
    }
    setHistoryRefreshToken(token => token + 1);
    setLoading(false);
  }, [marketplace]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const resetFlow = useCallback(() => {
    setStep('drop'); setFile(null); setResult(null); setResultContext(null); setError(null); setProgress(null);
  }, []);

  const handleDataTypeChange = (key) => {
    if (uploading) return;
    setDataType(key);
    resetFlow();
  };

  const handleFileDrop = useCallback(async (f) => {
    if (!f) return;
    setError(null);
    const extension = f.name.split('.').pop()?.toLowerCase();
    const basicErrors = [];
    if (!['xlsx', 'xls', 'csv'].includes(extension)) basicErrors.push('Use an XLSX, XLS, or CSV file.');
    if (f.size === 0) basicErrors.push('The selected file is empty.');
    if (f.size > 50 * 1024 * 1024) basicErrors.push('The file is larger than the 50 MB upload limit.');

    if (basicErrors.length) {
      setError(basicErrors.join(' '));
      return;
    }

    setFile(f);
    // Since mapping is handled automatically in the backend, skip the map step
    // and go straight to uploading. We use a microtask to ensure state updates 
    // before handleUpload reads `f`.
    setTimeout(() => {
      // We trigger the upload. For settlement types that require sheetKey,
      // we still need the map step if they need user selection, but fk-settlement
      // handles its own flow. Actually fk-settlement needs to select sheets!
      // Let's just set step to 'map' for fk-settlement, otherwise auto upload.
      if (dataType === 'fk-settlement' || dataType === 'amazon-settlement' || dataType === 'meesho-settlement') {
        setStep('map');
      } else {
        // We will pass the file directly to avoid state race conditions
        handleUpload(null, f);
      }
    }, 0);
  }, [dataType, marketplace, sellerAccount]);

  const handleUpload = async (sheetKey = '', overrideFile = null) => {
    const uploadFile = overrideFile || file;
    // Preserve the selection that initiated this upload. The user can navigate
    // after completion, but that must never change the endpoint or its result label.
    const uploadContext = { marketplace, sellerAccount, dataType };
    if (!uploadFile) {
      setError('No file provided');
      setStep('uploading');
      return;
    }
    setStep('uploading');
    setUploading(true);
    setError(null);
    setProgress(null);
    try {
      let res;
      if (uploadContext.dataType === 'fk-settlement') {
        const fd = new FormData();
        fd.append('file', uploadFile);
        fd.append('marketplace', uploadContext.marketplace);
        if (sheetKey) fd.append('sheetKey', sheetKey);
        // Returns jobId immediately — then poll until done
        const { jobId } = await uploadFkSettlement(fd);
        let poll;
        let attempts = 0;
        const MAX_ATTEMPTS = 180; // ~6 min at 2s
        do {
          await new Promise(r => setTimeout(r, 2000));
          poll = await pollFkProgress(jobId);
          setProgress(poll);
          if (poll.status === 'error') throw new Error(poll.error || 'Upload failed');
          attempts += 1;
          if (attempts >= MAX_ATTEMPTS) throw new Error('Settlement upload timed out — check Upload Status Board and retry if needed');
        } while (poll.status !== 'done');
        res = poll;
      } else {
        const uploadFd = new FormData();
        // Always use uploadFile (override from drop OR state) — never stale `file`
        uploadFd.append('file', uploadFile);
        uploadFd.append('marketplace', uploadContext.marketplace);
        if (uploadContext.dataType === 'amazon-settlement') {
          const startRes = await uploadAmazonSettlement(uploadFd);
          if (startRes.jobId) {
            let poll;
            let attempts = 0;
            const MAX_ATTEMPTS = 600; // ~20 min for large multi-sheet workbooks
            do {
              await new Promise(r => setTimeout(r, 2000));
              poll = await pollAmazonSettlementProgress(startRes.jobId);
              setProgress(poll);
              if (poll.status === 'error') throw new Error(poll.error || 'Upload failed');
              attempts += 1;
              if (attempts >= MAX_ATTEMPTS) throw new Error('Settlement upload timed out — check Upload Status Board and retry if needed');
            } while (poll.status !== 'done');
            res = poll.result || poll;
          } else {
            res = startRes;
          }
        } else if (uploadContext.dataType === 'meesho-settlement') {
          res = await uploadMeeshoSettlement(uploadFd);
        } else if (uploadContext.dataType === 'myntra-invoices') {
          // The endpoint validates this selected account against the active
          // Myntra directory before importing. EJ and VB therefore stay
          // separate even when their spreadsheets have identical columns.
          res = await uploadMpInvoices('myntra', uploadFd, uploadContext.sellerAccount);
        } else if (uploadContext.dataType === 'myntra-orders' || uploadContext.dataType === 'myntra-returns') {
          res = await uploadMyntraData(
            uploadContext.dataType === 'myntra-orders' ? 'orders' : 'returns',
            uploadFd,
            uploadContext.sellerAccount,
          );
        } else {
          uploadFd.append('columnMap', '{}');
          res = await uploadDataFile(uploadContext.dataType, uploadFd);
        }
      }
      // Settlement imports finish in a background job after the upload request
      // returned; reports fetched meanwhile may hold partial totals.
      invalidateApiReadCache();
      setResult(res);
      setResultContext(uploadContext);
      setStep('result');
      refreshStatus();
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Upload failed');
    }
    setUploading(false);
  };

  // Map frontend dataType → log data_type key(s) for duplicate detection
  const LOG_TYPE_MAP = {
    orders: 'orders', returns: 'returns', settlements: 'settlements',
    'fk-settlement':         'fk_settlement_orders',
    'amazon-sale-orders':    'amazon_sale_orders',
    'amazon-fba-returns':    'amazon_fba_returns',
    'amazon-flex-returns':   'amazon_flex_returns',
    'amazon-settlement':     'amazon_settlement',
  };
  const logTypeKey = MYNTRA_DATA_TYPES.has(dataType)
    ? myntraLogType(sellerAccount, dataType)
    : (LOG_TYPE_MAP[dataType] || dataType);
  const lastUpload = dbStatus?.logs?.find(l =>
    (l.marketplace || '').toLowerCase() === marketplace && l.data_type === logTypeKey
  ) || null;

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-ink">Upload Data</h1>
          <p className="text-sm text-secondary mt-1">Guided recon checklist — upload files in order for accurate dashboards</p>
        </div>
      </div>

      {/* Linkage health / checklist */}
      {linkage?.configured && (
        <div className="bg-surface rounded-xl border border-border p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <h2 className="text-sm font-semibold text-ink">
              {marketplace === 'amazon' ? 'Amazon' : 'Flipkart'} recon health
            </h2>
            <div className="flex gap-3 text-[11px] text-secondary flex-wrap">
              <span><b className="text-ink">{(linkage.orders || 0).toLocaleString()}</b> orders</span>
              <span><b className="text-emerald-700">{linkage.settledPct ?? 0}%</b> settled</span>
              <span><b className="text-ink">{linkage.returnsMatchedPct ?? 0}%</b> returns matched</span>
            </div>
          </div>
          <ol className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {(linkage.checklist || []).map((step, i) => {
              const done = (dbStatus?.logs || []).some(l =>
                (l.marketplace || '').toLowerCase() === marketplace &&
                (l.data_type || '').replace(/-/g, '_') === (step.key || '').replace(/-/g, '_') &&
                l.status === 'ok'
              ) || (dbStatus?.logs || []).some(l =>
                (l.marketplace || '').toLowerCase() === marketplace &&
                String(l.data_type).includes(step.key.split('-').pop()) &&
                l.status === 'ok'
              );
              return (
                <li key={step.key}
                  className={`rounded-lg border px-3 py-2 text-xs ${done ? 'border-emerald-200 bg-emerald-50' : 'border-slate-150 bg-surface-container-low'}`}>
                  <div className="flex items-center gap-2">
                    <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${done ? 'bg-emerald-600 text-white' : 'bg-surface-container-high text-secondary'}`}>
                      {done ? '✓' : i + 1}
                    </span>
                    <span className="font-semibold text-ink">{step.label}</span>
                    {step.required && !done && <span className="text-[9px] text-amber-600 font-bold ml-auto">REQ</span>}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
      
      {/* ── Fee anomaly check code was removed here ── */}
      
      {/* Step 1 & 2 Container */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="bg-surface rounded-xl border border-border p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-ink mb-4 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-surface-container text-secondary flex items-center justify-center text-[10px]">1</span>
            Select Dataset Type
          </h2>
          <div className="flex flex-wrap gap-2">
            {[
              { marketplace: 'flipkart', sellerAccount: '', label: 'Flipkart', active: 'bg-blue-50 border-blue-200 text-blue-700' },
              { marketplace: 'amazon', sellerAccount: '', label: 'Amazon', active: 'bg-orange-50 border-orange-200 text-orange-700' },
              ...MYNTRA_ACCOUNT_TABS,
            ].map(source => (
              <button key={`${source.marketplace}:${source.sellerAccount || 'default'}`} onClick={() => {
                if (uploading) return;
                setMarketplace(source.marketplace);
                setSellerAccount(source.sellerAccount);
                const first = dataTypesForMarketplace(source.marketplace)[0];
                if (first) setDataType(first.key);
                resetFlow();
              }}
                disabled={uploading}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all border disabled:cursor-not-allowed disabled:opacity-50 ${
                  marketplace === source.marketplace && sellerAccount === source.sellerAccount
                    ? source.active
                    : 'bg-surface border-border text-secondary hover:bg-surface-container-low hover:border-border'
                }`}>
                {source.label}
              </button>
            ))}
          </div>
          
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {dataTypesForMarketplace(marketplace).map(dt => (
              <button key={dt.key} onClick={() => handleDataTypeChange(dt.key)} disabled={uploading}
                className={`px-3 py-2.5 rounded-lg text-xs font-semibold text-left transition-all border disabled:cursor-not-allowed disabled:opacity-50 ${
                  dataType === dt.key 
                    ? 'bg-primary text-white border-primary shadow-md' 
                    : 'bg-surface border-border text-secondary hover:border-border hover:bg-surface-container-low'
                }`}>
                <div className="flex justify-between items-center">
                  <span>{dt.label}</span>
                  {dataType === dt.key && <span className="text-outline">✓</span>}
                </div>
              </button>
            ))}
          </div>

          {/* Per-type blurb — explains what file goes into this tile */}
          {(() => {
            const dt = DATA_TYPES.find(d => d.key === dataType);
            if (!dt?.blurb) return null;
            return (
              <p className="mt-3 text-xs text-secondary bg-surface-container-low border border-border rounded-lg px-3 py-2">
                <span className="font-semibold text-ink">{dt.label}:</span> {dt.blurb}
              </p>
            );
          })()}

          {/* Template download with sample rows */}
          {['orders','returns','amazon-sale-orders','amazon-fba-returns','amazon-flex-returns','amazon-settlement', ...MYNTRA_DATA_TYPES].includes(dataType) && (
            <button
              type="button"
              onClick={async () => {
                try {
                  const blob = dataType === 'myntra-invoices'
                    ? await downloadMpInvoiceTemplate('myntra')
                    : dataType === 'myntra-orders' || dataType === 'myntra-returns'
                      ? await downloadMyntraTemplate(dataType === 'myntra-orders' ? 'orders' : 'returns')
                      : await downloadTemplate(dataType);
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = dataType === 'myntra-invoices'
                    ? `Myntra_${sellerAccount === 'myntra_ej' ? 'EJ' : 'VB'}_Invoice_Payment_Template.xlsx`
                    : dataType === 'myntra-orders' || dataType === 'myntra-returns'
                      ? `Myntra_${sellerAccount === 'myntra_ej' ? 'EJ' : 'VB'}_${dataType === 'myntra-orders' ? 'Order' : 'Return'}_Template.xlsx`
                      : `template_${dataType}_sample.xlsx`;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  URL.revokeObjectURL(url);
                } catch (e) {
                  alert('Template download failed: ' + (e?.response?.data?.error || e.message));
                }
              }}
              className="mt-4 w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-semibold border border-dashed border-primary text-primary bg-indigo-50/60 hover:bg-indigo-50 hover:border-primary transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download template (with 2–3 sample rows)
            </button>
          )}
        </div>

        {/* Step 3 — File / Map / Result */}
        {step === 'drop' && <DropZone onFile={handleFileDrop} error={error} lastUpload={lastUpload} />}
        {step === 'map' && dataType === 'fk-settlement' && (
          <FkSettlementReady
            file={file} uploading={uploading} progress={progress} error={error} lastUpload={lastUpload}
            onUpload={handleUpload} onReset={resetFlow}
          />
        )}
        {step === 'map' && dataType === 'amazon-settlement' && (
          <AmazonSettlementReady
            file={file} uploading={uploading} progress={progress} error={error}
            onUpload={handleUpload} onReset={resetFlow}
          />
        )}
        {step === 'drop' && marketplace === 'amazon' && dataType === 'amazon-sale-orders' && (
          <AmazonOrdersGuide />
        )}
        {step === 'uploading' && dataType !== 'fk-settlement' && dataType !== 'amazon-settlement' && dataType !== 'meesho-settlement' && (
          <ColumnMapper
            file={file} uploading={uploading} progress={progress} error={error}
            onUpload={handleUpload} onReset={resetFlow}
          />
        )}
        {step === 'result' && result && (
          <ResultPanel
            result={result}
            dataType={resultContext?.dataType || dataType}
            marketplace={resultContext?.marketplace || marketplace}
            sellerAccount={resultContext?.sellerAccount || sellerAccount}
            onReset={resetFlow}
            onRemarkSaved={refreshStatus}
          />
        )}
      </div>

      {/* DB Utilities */}
      <DbUtilities />

      <DataCoveragePanel
        coverage={dbStatus?.dataCoverage}
        marketplace={marketplace}
        sellerAccount={sellerAccount}
        onRefresh={refreshStatus}
      />

      <UploadLog refreshToken={historyRefreshToken} onRefresh={refreshStatus} />

      {/* Upload status board — filtered to current tab */}
      {dbStatus?.logs?.length > 0 && (
        <UploadHistory logs={dbStatus.logs} counts={dbStatus.counts} onRemarkSaved={refreshStatus} activeTab={dataType} marketplace={marketplace} sellerAccount={sellerAccount} />
      )}

    </div>
  );
}

function PreflightSummary({ preflight, file }) {
  const ready = preflight.errors.length === 0;
  return (
    <div className="px-6 py-4">
      <SectionLabel n={3} label="Validate File" />
      <div className={`mt-3 rounded-xl border p-4 ${
        ready ? 'border-emerald-200 bg-emerald-50/60' : 'border-rose-200 bg-rose-50'
      }`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className={`text-sm font-bold ${ready ? 'text-emerald-800' : 'text-rose-800'}`}>
              {ready ? 'Preflight checks passed' : 'File needs attention'}
            </p>
            <p className="mt-0.5 text-xs text-secondary">
              {file?.name} · {preflight.rowCount.toLocaleString()} rows
              {preflight.sheetName ? ` · ${preflight.sheetName}` : ''}
              {preflight.required != null ? ` · ${preflight.mapped}/${preflight.required} columns mapped` : ''}
            </p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${
            ready ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
          }`}>
            {ready ? 'Ready' : `${preflight.errors.length} error${preflight.errors.length === 1 ? '' : 's'}`}
          </span>
        </div>
        {preflight.errors.map(message => (
          <p key={message} className="mt-2 text-xs font-semibold text-rose-700">• {message}</p>
        ))}
        {preflight.warnings.map(message => (
          <p key={message} className="mt-2 text-xs text-amber-700">• {message}</p>
        ))}
      </div>
    </div>
  );
}

function SectionLabel({ n, label }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-6 h-6 rounded-full bg-primary-container text-primary flex items-center justify-center text-xs font-bold shrink-0">{n}</div>
      <h3 className="text-sm font-bold text-ink">{label}</h3>
    </div>
  );
}

// ── Column mapper ──────────────────────────────────────────────────────────────
function ColumnMapper({ file, uploading, progress, error, onUpload, onReset }) {
  return (
    <div className="px-6 py-5">
      <div className="flex items-center justify-between mb-4">
        <SectionLabel n={3} label="Uploading & AI Mapping" />
        <div className="flex items-center gap-3 text-xs text-outline">
          <span className="font-medium text-secondary">{file?.name}</span>
        </div>
      </div>

      <div className="rounded-xl border border-border overflow-hidden mb-4 p-6 bg-surface-container-low flex flex-col items-center justify-center text-center">
        {!error ? (
          <>
            <div className="w-10 h-10 border-4 border-primary border-t-indigo-600 rounded-full animate-spin mb-4"></div>
            <h3 className="text-sm font-bold text-ink mb-1">Processing file</h3>
            <p className="text-xs text-secondary max-w-md">
              The file has been sent to the backend. Any missing columns will be automatically mapped by NVIDIA AI before ingestion.
            </p>
          </>
        ) : (
          <>
            <div className="text-4xl mb-3">❌</div>
            <h3 className="text-sm font-bold text-rose-800 mb-1">Upload failed</h3>
          </>
        )}
      </div>

      {/* Live progress bar while uploading */}
      {uploading && progress && (
        <div className="px-4 py-3 bg-primary-container border border-primary rounded-xl mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-primary">
              {progress.msg || 'Ingesting data...'}
            </span>
            <span className="text-xs text-primary font-bold">
              {progress.percent != null ? `${progress.percent}%` : 'Working…'}
            </span>
          </div>
          <div className="w-full h-2 bg-primary-container rounded-full overflow-hidden">
            <div
              className="h-2 bg-primary rounded-full transition-all duration-300"
              style={{ width: progress.percent != null ? `${progress.percent}%` : '15%' }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-rose-50 border border-rose-200 rounded-xl mb-4 text-sm text-rose-700">
          <span>❌</span><span>{error}</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3">
          <button onClick={onReset} className="px-4 py-2 bg-surface border border-border text-ink hover:bg-surface-container-low text-sm font-semibold rounded-lg transition-colors shadow-sm">
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

function DropZone({ onFile, error, lastUpload }) {
  const fileInputRef = useRef(null);
  return (
    <div className="px-6 py-5">
      <div 
        className="border-2 border-dashed border-primary rounded-xl p-8 flex flex-col items-center justify-center cursor-pointer hover:bg-indigo-50 transition-colors"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); }}
      >
        <div className="text-4xl mb-3">📁</div>
        <h3 className="text-sm font-bold text-ink">Drag & Drop your file here</h3>
        <p className="text-xs text-secondary mt-1">or click to browse from your computer</p>
        <input 
          type="file" 
          className="hidden" 
          ref={fileInputRef} 
          accept=".csv,.xlsx,.xls" 
          onChange={e => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = ''; }} 
        />
      </div>
      {error && <div className="mt-4 text-xs text-rose-600 bg-rose-50 p-3 rounded-xl border border-rose-200">{error}</div>}
      {lastUpload && <div className="mt-4"><LastUploadBanner log={lastUpload} /></div>}
    </div>
  );
}

function AmazonOrdersGuide() {
  return (
    <div className="px-6 pb-5">
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mt-2">
        <h4 className="text-sm font-bold text-amber-800 flex items-center gap-2">
          <span>💡</span> Amazon Order Upload Guide
        </h4>
        <p className="text-xs text-amber-700 mt-2">
          Upload the <strong>Amazon Sale Order</strong> file with the 14 columns from the renewed template.
          Order Reports are no longer required; settlement and return linkage uses Amazon Order Id + Merchant SKU.
        </p>
      </div>
    </div>
  );
}


function MeeshoSettlementReady({ file, uploading, progress, error, onUpload, onReset }) {
  if (uploading) return <UploadProgress label="Importing Meesho Settlement" progress={progress} error={error} onReset={onReset} />;
  return (
    <div className="px-6 py-5">
      <div className="flex items-center justify-between mb-4">
        <SectionLabel n={3} label="Uploading & AI Mapping" />
        <div className="flex items-center gap-3 text-xs text-outline">
          <span className="font-medium text-secondary">{file?.name}</span>
        </div>
      </div>
      <div className="mt-6 mb-8 text-center bg-gray-50 rounded-xl p-8 border border-gray-100">
        <h3 className="text-sm font-bold text-ink">Meesho Payments File</h3>
        <p className="text-xs text-secondary max-w-md mx-auto mt-1">
          This file will be parsed and loaded directly. The backend automatically extracts Order Payments, Ads Cost, and Referrals. No manual column mapping required.
        </p>
      </div>
      <div className="flex items-center justify-between mt-6 pt-5 border-t border-gray-100">
        <button onClick={onReset} className="px-4 py-2 text-sm font-medium text-secondary hover:text-ink transition-colors">Back</button>
        <button onClick={() => onUpload('')} className="px-5 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors shadow-sm">
          Process Payment File
        </button>
      </div>
    </div>
  );
}

function AmazonSettlementReady({ file, uploading, progress, error, onUpload, onReset }) {
  return (
    <div className="px-6 py-5">
      <div className="flex items-center justify-between mb-4">
        <SectionLabel n={3} label="Upload Settlement" />
        <div className="flex items-center gap-3 text-xs text-outline">
          <span className="font-medium text-secondary">{file?.name}</span>
        </div>
      </div>
      
      <div className="rounded-xl border border-border p-6 bg-surface-container-low text-center">
        <div className="text-3xl mb-2">📊</div>
        <h3 className="text-sm font-bold text-ink">Amazon Flat File V2</h3>
        <p className="text-xs text-secondary max-w-md mx-auto mt-1">
          This file will be parsed and loaded directly. Amazon settlements do not require manual column mapping.
        </p>
      </div>

      {uploading && progress && (
        <div className="px-4 py-3 bg-primary-container border border-primary rounded-xl mt-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-primary">{progress.msg || 'Ingesting data...'}</span>
            <span className="text-xs text-primary font-bold">{progress.percent != null ? `${progress.percent}%` : 'Working…'}</span>
          </div>
          <div className="w-full h-2 bg-primary-container rounded-full overflow-hidden">
            <div className="h-2 bg-primary rounded-full transition-all duration-300" style={{ width: progress.percent != null ? `${progress.percent}%` : '15%' }} />
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-center gap-2 px-4 py-3 bg-rose-50 border border-rose-200 rounded-xl text-sm text-rose-700">
          <span>❌</span><span>{error}</span>
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button onClick={onUpload} disabled={uploading} className="px-5 py-2.5 bg-primary hover:bg-primary disabled:opacity-60 text-white text-sm font-semibold rounded-xl">
          {uploading ? 'Uploading...' : 'Upload Data'}
        </button>
        <button onClick={onReset} className="text-sm text-outline hover:text-secondary font-medium px-2">Cancel</button>
      </div>
    </div>
  );
}

// ── Last upload banner (duplicate prevention) ──────────────────────────────────
function LastUploadBanner({ log }) {
  const dt = new Date(log.uploaded_at);
  const dateStr = dt.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const isErr = log.status !== 'ok';
  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-xs ${
      isErr ? 'bg-rose-50 border-rose-200' : 'bg-amber-50 border-amber-200'
    }`}>
      <span className="text-base shrink-0">{isErr ? '⚠️' : '📋'}</span>
      <div className="flex-1 min-w-0">
        <p className={`font-semibold ${isErr ? 'text-rose-700' : 'text-amber-800'}`}>
          {isErr ? 'Last upload failed' : 'Already uploaded'} — {dateStr}
        </p>
        <p className="text-secondary mt-0.5">
          File: <span className="font-medium text-ink">{log.filename}</span>
          {!isErr && <> · <span className="text-emerald-700 font-semibold">{(log.rows_inserted || 0).toLocaleString()} rows</span></>}
          {isErr && <> · <span className="text-rose-600">{log.error_msg}</span></>}
        </p>
        {log.remark && (
          <p className="mt-1 text-secondary">
            Remark: <span className="italic font-medium">"{log.remark}"</span>
          </p>
        )}
        {!isErr && (
          <p className={`mt-1 font-semibold ${isErr ? 'text-rose-700' : 'text-amber-700'}`}>
            Make sure this is a new/different data file to avoid duplicate records.
          </p>
        )}
      </div>
    </div>
  );
}

// ── FK Settlement ready panel ──────────────────────────────────────────────────
function FkSettlementReady({ file, uploading, progress, error, onUpload, onReset, lastUpload }) {
  const [activeSheet, setActiveSheet] = useState(null); // which sheet is currently uploading

  const SHEETS = [
    { key: 'orders',     label: 'Orders (all deductions)',  desc: 'Commission, fixed fee, shipping, TCS, TDS, new fees — 60+ columns' },
    { key: 'spf',        label: 'Non-Order SPF claims',     desc: 'Warehouse-lost item reimbursements' },
    { key: 'storage',    label: 'Storage & Recall fees',    desc: 'Monthly FBF storage + recall/removal charges' },
    { key: 'ads',        label: 'Flipkart Ads wallet',      desc: 'Redeem / topup / refund transactions' },
    { key: 'google_ads', label: 'Google Ads billing',       desc: 'Google Ads spend deducted from settlement' },
  ];

  const handleSheet = (key) => {
    setActiveSheet(key);
    onUpload(key);
  };
  const handleAll = () => {
    setActiveSheet('all');
    onUpload('');
  };

  const isUploading = uploading;
  const currentLabel = activeSheet === 'all'
    ? 'All Sheets'
    : SHEETS.find(s => s.key === activeSheet)?.label ?? '';

  return (
    <div className="px-6 py-5">
      <div className="flex items-center justify-between mb-4">
        <SectionLabel n={3} label="Ready to Upload" />
        <div className="flex items-center gap-3 text-xs text-outline">
          <span className="font-medium text-secondary">{file?.name}</span>
          <button onClick={onReset} disabled={isUploading} className="text-primary hover:text-primary underline font-medium disabled:opacity-40">Change file</button>
        </div>
      </div>
      {lastUpload && <LastUploadBanner log={lastUpload} />}
      <div className="bg-primary-container border border-primary rounded-xl px-4 py-3 text-sm text-primary font-medium mb-4">
        Upload all sheets at once, or click <strong>Upload</strong> next to any individual sheet to push only that one.
      </div>

      {/* Sheet table */}
      <div className="rounded-xl border border-border overflow-hidden mb-4">
        <div className="bg-surface-container-low border-b border-border px-4 py-2.5 grid grid-cols-[1fr_1fr_auto]">
          <p className="text-[11px] font-semibold text-secondary uppercase tracking-wide">Sheet</p>
          <p className="text-[11px] font-semibold text-secondary uppercase tracking-wide">What gets saved</p>
          <p className="text-[11px] font-semibold text-secondary uppercase tracking-wide w-16 text-right">Action</p>
        </div>
        <div className="divide-y divide-slate-50">
          {SHEETS.map(s => {
            const isThisUploading = isUploading && activeSheet === s.key;
            return (
              <div key={s.key} className="grid grid-cols-[1fr_1fr_auto] items-center px-4 py-2.5 gap-2">
                <div className="flex items-center gap-2">
                  {isThisUploading
                    ? <svg className="w-3 h-3 animate-spin text-primary shrink-0" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8"/></svg>
                    : <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                  }
                  <span className="text-xs font-semibold text-ink">{s.label}</span>
                </div>
                <span className="text-xs text-secondary">{s.desc}</span>
                <button
                  onClick={() => handleSheet(s.key)}
                  disabled={isUploading}
                  className="w-16 text-right text-[11px] font-semibold text-primary hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isThisUploading ? 'Uploading…' : 'Upload'}
                </button>
              </div>
            );
          })}
          {['MP Fee Rebate','Value Added Services','TCS Recovery','TDS','GST Details'].map(s => (
            <div key={s} className="grid grid-cols-[1fr_1fr_auto] items-center px-4 py-2.5 opacity-40">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-surface-container-highest shrink-0" />
                <span className="text-xs text-secondary">{s}</span>
              </div>
              <span className="text-xs text-outline">Skipped (usually empty)</span>
              <span className="w-16" />
            </div>
          ))}
        </div>
      </div>

      {/* Live progress bar while uploading */}
      {isUploading && progress && (
        <div className="mb-4 px-4 py-3 bg-primary-container border border-primary rounded-xl">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-primary">
              {currentLabel && <span className="text-indigo-400 mr-1">[{currentLabel}]</span>}
              {progress.sheet}
            </span>
            <span className="text-xs text-primary">
              {progress.sheetTotal > 0
                ? `${progress.sheetDone.toLocaleString()} / ${progress.sheetTotal.toLocaleString()} rows`
                : 'Working…'}
            </span>
          </div>
          <div className="w-full h-2 bg-primary-container rounded-full overflow-hidden">
            <div
              className="h-2 bg-primary rounded-full transition-all duration-300"
              style={{ width: progress.sheetTotal > 0 ? `${Math.min(100, (progress.sheetDone / progress.sheetTotal) * 100)}%` : '15%' }}
            />
          </div>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-rose-50 border border-rose-200 rounded-xl mb-4 text-sm text-rose-700">
          <span>&#x2715;</span><span>{error}</span>
        </div>
      )}

      {/* Upload All button */}
      <div className="flex items-center gap-3">
        <button onClick={handleAll} disabled={isUploading}
          className="flex items-center gap-2 px-5 py-2.5 bg-primary hover:bg-primary disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors shadow-sm">
          {isUploading && activeSheet === 'all' ? (
            <><svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8" />
            </svg> Processing…</>
          ) : (
            <><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg> Upload All Sheets</>
          )}
        </button>
        <p className="text-xs text-outline">Runs in background — no timeout</p>
      </div>
    </div>
  );
}

// ── Remark input (shown after any successful upload) ──────────────────────────
function RemarkBox({ logId, onSaved }) {
  const [text, setText]     = useState('');
  const [saved, setSaved]   = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const handleSave = async () => {
    if (!logId || !text.trim()) return;
    setSaving(true);
    setSaveError('');
    try {
      const response = await saveUploadRemark(logId, text.trim());
      if (!response?.ok) throw new Error('The remark was not saved.');
      setSaved(true);
      await onSaved?.();
    } catch (error) {
      setSaveError(error?.response?.data?.error || error?.message || 'The remark could not be saved. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (saved) return (
    <div className="flex items-center gap-2 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-700 font-medium">
      ✅ Remark saved — visible in upload history
    </div>
  );

  return (
    <div className="w-full max-w-lg space-y-2">
      <p className="text-xs font-semibold text-secondary">Add a remark for this upload (optional)</p>
      <p className="text-[11px] text-outline">e.g. "March 2026 orders batch" — shown in history until next upload of same type</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSave()}
          placeholder="Enter remark…"
          maxLength={500}
          className="flex-1 text-sm border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <button onClick={handleSave} disabled={saving || !text.trim()}
          className="px-4 py-2 bg-primary hover:bg-primary disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors">
          {saving ? '…' : 'Save'}
        </button>
      </div>
      {saveError && <p className="text-xs text-rose-600" role="alert">{saveError}</p>}
    </div>
  );
}

// ── Result panel ───────────────────────────────────────────────────────────────
function ResultPanel({ result, dataType, marketplace, sellerAccount, onReset, onRemarkSaved }) {
  // FK Settlement: multi-sheet result
  if (dataType === 'fk-settlement' && result.results) {
    const { results, totalInserted, newColumnsFound, logId } = result;
    const sheetLabels = {
      orders:         'Orders',
      spf_claims:     'Non-Order SPF',
      storage_recall: 'Storage & Recall',
      ads:            'Flipkart Ads',
      google_ads:     'Google Ads',
    };
    return (
      <div className="px-6 py-8 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <p className="text-base font-bold text-ink">Settlement report uploaded!</p>
            <p className="text-sm text-secondary">{totalInserted?.toLocaleString()} rows saved across all sheets</p>
          </div>
        </div>
        <div className="rounded-xl border border-border overflow-hidden">
          {Object.entries(sheetLabels).map(([key, label]) => {
            const r = results[key];
            if (!r) return null;
            return (
              <div key={key} className="flex items-center justify-between px-4 py-2.5 border-b border-slate-50 last:border-0">
                <span className="text-sm font-medium text-ink">{label}</span>
                <div className="flex gap-4 text-xs">
                  <span className="text-emerald-700 font-semibold">{(r.inserted||0).toLocaleString()} saved</span>
                  {r.skipped > 0 && <span className="text-outline">{r.skipped} skipped</span>}
                </div>
              </div>
            );
          })}
        </div>
        {newColumnsFound?.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <p className="text-sm font-semibold text-amber-800 mb-1">⚠️ New columns detected</p>
            <div className="flex flex-wrap gap-1 mt-1">
              {newColumnsFound.map(c => (
                <span key={c} className="text-[10px] font-mono bg-amber-100 text-amber-800 px-2 py-0.5 rounded">{c}</span>
              ))}
            </div>
          </div>
        )}
        {logId && <RemarkBox logId={logId} onSaved={onRemarkSaved} />}
        <button onClick={onReset} className="text-sm text-primary hover:text-primary font-semibold underline">
          Upload another file
        </button>
      </div>
    );
  }

  const dataset = DATA_TYPES.find(type => type.key === dataType);
  const datasetLabel = dataset?.label || dataType;
  const marketplaceLabel = marketplace === 'myntra' && sellerAccount
    ? `Myntra (${sellerAccount === 'myntra_ej' ? 'EJ' : 'VB'}) — `
    : (marketplace ? `${marketplace[0].toUpperCase()}${marketplace.slice(1)} — ` : '');

  return (
    <div className="px-6 py-10 flex flex-col items-center gap-5">
      <div className="w-14 h-14 bg-emerald-100 rounded-full flex items-center justify-center">
        <svg className="w-7 h-7 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <div className="text-center">
        <p className="text-base font-bold text-ink">Upload complete!</p>
        <p className="text-sm text-secondary mt-0.5">{marketplaceLabel}{datasetLabel} data saved to database</p>
      </div>
      <div className="flex gap-8">
        <ResultStat label="New" value={result.inserted} color="text-emerald-600" />
        {result.updated != null && <ResultStat label="Updated" value={result.updated} color="text-primary" />}
        <ResultStat label="Skipped" value={result.skipped} color="text-outline" />
        <ResultStat label="Total" value={result.total} color="text-ink" />
      </div>
      {result.newFCs?.length > 0 && (
        <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-left w-full max-w-lg">
          <p className="text-sm font-semibold text-amber-800 flex items-center gap-2">
            <span>⚠️</span> New Fulfillment Centers Detected
          </p>
          <p className="text-xs text-amber-700 mt-1">
            The following Amazon FCs are missing from the master list and were automatically defaulted to <strong>FBA</strong>. If they are actually Flex warehouses, please let me know.
          </p>
          <div className="flex flex-wrap gap-1 mt-2">
            {result.newFCs.map(c => (
              <span key={c} className="text-[10px] font-mono bg-amber-100 text-amber-800 px-2 py-0.5 rounded border border-amber-300">{c}</span>
            ))}
          </div>
        </div>
      )}
      {result.dateFormats && <DateFormatSummary formats={result.dateFormats} />}
      {result.skipped > 0 && result.logId && <SkippedRowsPanel logId={result.logId} total={result.skipped} />}
      {result.logId && <RemarkBox logId={result.logId} onSaved={onRemarkSaved} />}
      {dataType === 'amazon-settlement' && (
        <a href="/amazon-reconciliation" className="rounded-lg bg-amber-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-amber-700">
          Review Amazon payment parameters
        </a>
      )}
      <button onClick={onReset}
        className="text-sm text-primary hover:text-primary font-semibold underline">
        Upload another file
      </button>
    </div>
  );
}

// ── Skipped Rows Panel ─────────────────────────────────────────────────────────
function SkippedRowsPanel({ logId, total, compact = false }) {
  const [open, setOpen]   = useState(false);
  const [loading, setLoading] = useState(false);
  const [page, setPage]   = useState(1);
  const [data, setData]   = useState(null);

  const load = async (p = 1) => {
    setLoading(true);
    try { const d = await fetchSkippedRows(logId, p); setData(d); setPage(p); }
    catch { /* ignore */ }
    finally { setLoading(false); }
  };

  const toggle = () => {
    if (!open && !data) load(1);
    setOpen(o => !o);
  };

  const downloadAll = async () => {
    // Fetch all pages and build Excel
    let all = [];
    let p = 1;
    while (true) {
      const d = await fetchSkippedRows(logId, p);
      all = all.concat(d.rows);
      if (all.length >= d.total || d.rows.length === 0) break;
      p++;
    }
    if (!all.length) return;
    const headers = Array.from(new Set(all.flatMap(r => Object.keys(r.data || {}))));
    const wsData = [
      ['Row #', 'Skip Reason', ...headers],
      ...all.map(r => [r.rowNum, r.reason, ...headers.map(h => r.data?.[h] ?? '')]),
    ];
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(wsData), 'Skipped Rows');
    XLSX.writeFile(wb, `skipped_rows_upload_${logId}.xlsx`);
  };

  const rows = data?.rows || [];
  const cols = rows.length ? Array.from(new Set(rows.flatMap(r => Object.keys(r.data || {})))).slice(0, 8) : [];

  return (
    <div className={`rounded-xl border border-amber-200 bg-amber-50 overflow-hidden ${compact ? '' : 'w-full max-w-3xl'}`}>
      <div className="flex items-center justify-between px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-amber-600 text-xs font-semibold">{total.toLocaleString()} rows skipped</span>
          {!compact && <span className="text-amber-500 text-xs">— missing required ID field</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={downloadAll}
            className="text-[11px] font-semibold text-primary hover:text-primary border border-primary bg-surface px-2.5 py-1 rounded-lg">
            Download
          </button>
          <button onClick={toggle}
            className="text-[11px] font-semibold text-amber-700 border border-amber-200 bg-surface px-2.5 py-1 rounded-lg">
            {open ? 'Hide' : 'View'}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-amber-200 bg-surface">
          {loading && <p className="text-xs text-outline px-4 py-3">Loading…</p>}
          {!loading && rows.length === 0 && <p className="text-xs text-outline px-4 py-3">No rows found.</p>}
          {!loading && rows.length > 0 && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-amber-50 text-left">
                      <th className="px-3 py-2 font-semibold text-secondary whitespace-nowrap">Row #</th>
                      <th className="px-3 py-2 font-semibold text-secondary whitespace-nowrap">Reason</th>
                      {cols.map(c => <th key={c} className="px-3 py-2 font-semibold text-secondary whitespace-nowrap">{c}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map(r => (
                      <tr key={r.rowNum} className="hover:bg-amber-50/40">
                        <td className="px-3 py-1.5 text-secondary">{r.rowNum}</td>
                        <td className="px-3 py-1.5 text-red-500">{r.reason}</td>
                        {cols.map(c => <td key={c} className="px-3 py-1.5 text-ink max-w-[160px] truncate">{r.data?.[c] ?? ''}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between px-4 py-2 border-t border-amber-100">
                <span className="text-xs text-outline">Showing {(page-1)*100+1}—{Math.min(page*100, data.total)} of {data.total}</span>
                <div className="flex gap-2">
                  <button disabled={page <= 1} onClick={() => load(page-1)}
                    className="text-xs px-2 py-1 border rounded disabled:opacity-40">Prev</button>
                  <button disabled={page * 100 >= data.total} onClick={() => load(page+1)}
                    className="text-xs px-2 py-1 border rounded disabled:opacity-40">Next</button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DateFormatSummary({ formats }) {
  const rows = Object.entries(formats || {}).filter(([, v]) => v?.sample);
  if (!rows.length) return null;
  return (
    <div className="w-full max-w-xl rounded-xl border border-border bg-surface-container-low px-4 py-3">
      <p className="text-xs font-semibold text-ink mb-2">Date conversion checked for SQL</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {rows.map(([field, info]) => (
          <div key={field} className="bg-surface border border-border rounded-lg px-3 py-2">
            <p className="text-[11px] font-semibold text-secondary">{field}</p>
            <p className="text-[10px] text-outline mt-0.5">
              {info.format || 'Auto'} from "{String(info.sample)}" ({info.source})
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResultStat({ label, value, color }) {
  return (
    <div className="text-center">
      <p className={`text-2xl font-bold ${color}`}>{(value || 0).toLocaleString()}</p>
      <p className="text-xs text-outline font-medium mt-0.5">{label}</p>
    </div>
  );
}

// ── DB Banner ──────────────────────────────────────────────────────────────────
function DbBanner({ configured, counts, lastUploads, fkSettlementPeriod }) {
  const fmtDate = (v) => {
    if (!v) return null;
    return new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  };
  const fmtMon = (v) => {
    if (!v) return null;
    return new Date(v).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  };

  if (!configured) return (
    <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-5 py-4">
      <span className="text-xl">⚠️</span>
      <div>
        <p className="text-sm font-semibold text-amber-800">Database not connected</p>
        <p className="text-xs text-amber-600 mt-0.5">Add the Hostinger PostgreSQL DATABASE_URL to backend/.env and restart.</p>
      </div>
    </div>
  );

  // `logKey` matches the data_type written into upload_log.data_type so we can
  // look up lastUploads[logKey]. `key` is the frontend dataType (hyphenated).
  const types = [
    { key: 'orders',             logKey: 'orders',                label: 'Orders (FK)',        count: counts?.orders },
    { key: 'returns',            logKey: 'returns',               label: 'Returns (FK)',       count: counts?.returns },
    { key: 'fk-settlement',      logKey: 'fk_settlement_orders',  label: 'FK Settlement',      count: counts?.fk_settlement_orders },
    // Amazon multi-source pipeline

    { key: 'amazon-fba-returns',   logKey: 'amazon_fba_returns',   label: 'Amazon FBA Ret.',    count: counts?.amazon_fba_returns },
    { key: 'amazon-flex-returns',  logKey: 'amazon_flex_returns',  label: 'Amazon Flex Ret.',   count: counts?.amazon_flex_returns },
    { key: 'amazon-settlement',    logKey: 'amazon_settlement',    label: 'Amazon Settlement',  count: counts?.amazon_settlement_lines },
  ];

  return (
    <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm font-semibold text-emerald-800">PostgreSQL connected</span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {types.map(({ key, logKey, label, count }) => {
          // upload_log writes data_type with underscores (e.g. amazon_settlement,
          // fk_settlement_orders) so use logKey, not the hyphenated tab key.
          const lastUp = lastUploads?.[logKey] || lastUploads?.[key];
          const isFK   = key === 'fk-settlement';
          const fkPeriodStr = isFK && fkSettlementPeriod?.period_start
            ? `${fmtMon(fkSettlementPeriod.period_start)} → ${fmtMon(fkSettlementPeriod.period_end)}`
            : null;
          return (
            <div key={key} className="bg-surface rounded-xl border border-emerald-100 px-3 py-2.5">
              <p className="text-[10px] font-semibold text-secondary uppercase tracking-widest">{label}</p>
              <p className="text-lg font-bold text-ink mt-0.5">{(count || 0).toLocaleString()}</p>
              {fkPeriodStr && (
                <p className="text-[10px] text-primary font-semibold mt-0.5">{fkPeriodStr}</p>
              )}
              {lastUp
                ? <p className="text-[10px] text-outline mt-0.5">Last upload: {fmtDate(lastUp)}</p>
                : <p className="text-[10px] text-outline mt-0.5">Not uploaded yet</p>
              }
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Setup Guide ────────────────────────────────────────────────────────────────
function SetupGuide() {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-surface-container-low border border-border rounded-xl overflow-hidden">
      <button className="w-full flex items-center justify-between px-5 py-4 text-left" onClick={() => setOpen(o => !o)}>
        <div className="flex items-center gap-3">
          <span className="text-lg">📘</span>
          <div>
            <p className="text-sm font-semibold text-ink">PostgreSQL Setup Guide</p>
            <p className="text-xs text-outline">Click to expand — step-by-step instructions</p>
          </div>
        </div>
        <svg className={`w-4 h-4 text-outline transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="px-5 pb-5 pt-4 border-t border-border space-y-4">
          <GuideStep n={1} title="Use the Hostinger PostgreSQL database">
            Keep PostgreSQL running in Docker on the Hostinger VPS. Use one permanent application database and do not switch back to previous databases.
          </GuideStep>
          <GuideStep n={2} title="Keep the database private">
            On the VPS, let the API reach PostgreSQL through the Docker network. Do not open PostgreSQL to the public internet for production traffic.
          </GuideStep>
          <GuideStep n={3} title="Add credentials to backend/.env">
            <div className="mt-1.5 bg-primary rounded-lg p-3 font-mono text-[11px] text-green-400 space-y-0.5">
              <p>DATABASE_URL=<span className="text-yellow-300">postgresql://user:password@postgres:5432/paymentapp</span></p>
              <p>DATABASE_ENGINE=<span className="text-yellow-300">postgresql</span></p>
              <p>PG_SSL=<span className="text-yellow-300">false</span></p>
            </div>
          </GuideStep>
          <GuideStep n={4} title="Restart backend server">
            Database tables are created automatically on first startup. Then upload your data files above.
          </GuideStep>
        </div>
      )}
    </div>
  );
}

function GuideStep({ n, title, children }) {
  return (
    <div className="flex gap-3">
      <span className="w-6 h-6 rounded-full bg-primary-container text-primary text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">{n}</span>
      <div>
        <p className="text-sm font-semibold text-ink">{title}</p>
        <div className="text-xs text-secondary mt-0.5 leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

// ── DB Utilities ────────────────────────────────────────────────────────────────
// Settlement snapshot + other one-off DB operations moved here from analysis pages
function DbUtilities() {
  const [pushState, setPushState] = useState('idle');
  const [pushMsg,   setPushMsg]   = useState('');

  async function handlePush() {
    setPushState('loading'); setPushMsg('');
    try {
      const r = await pushSettlementReport();
      setPushState('success');
      setPushMsg(`${r.rowsWritten} rows saved to SQL report table`);
      setTimeout(() => setPushState('idle'), 5000);
    } catch (e) {
      setPushState('error');
      setPushMsg(e?.response?.data?.error || e.message);
      setTimeout(() => setPushState('idle'), 6000);
    }
  }

  return (
    <div className="bg-surface rounded-2xl border border-border divide-y divide-slate-100">
      <div className="px-6 py-4 flex items-center gap-2">
        <span className="w-5 h-5 rounded-full bg-primary text-white text-[10px] font-bold flex items-center justify-center shrink-0">⚙️</span>
        <span className="text-xs font-semibold text-secondary uppercase tracking-widest">DB Utilities</span>
      </div>
      <div className="px-6 py-5 flex flex-wrap items-center gap-5">
        {/* Save Settlement Snapshot */}
        <div className="flex items-start gap-4">
          <div>
            <p className="text-sm font-semibold text-ink">Save Settlement SQL Snapshot</p>
            <p className="text-xs text-outline mt-0.5 max-w-sm">
              Pre-compute and save the settlement reconciliation report to a SQL table for faster Statement page loads.
            </p>
            {pushMsg && (
              <p className={`text-xs mt-1 font-medium ${pushState === 'error' ? 'text-rose-600' : 'text-emerald-600'}`}>
                {pushMsg}
              </p>
            )}
          </div>
          <button
            onClick={handlePush}
            disabled={pushState === 'loading'}
            className={`shrink-0 flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              pushState === 'success' ? 'bg-emerald-600 text-white' :
              pushState === 'error'   ? 'bg-rose-600 text-white' :
              pushState === 'loading' ? 'bg-surface-container-highest text-secondary cursor-not-allowed' :
              'bg-primary text-white hover:bg-primary'
            }`}
          >
            {pushState === 'loading' ? (
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
              </svg>
            ) : pushState === 'success' ? (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" /></svg>
            )}
            {pushState === 'loading' ? 'Saving…' : pushState === 'success' ? 'Saved!' : pushState === 'error' ? 'Failed' : 'Save Snapshot'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Upload Status Board ─────────────────────────────────────────────────────────
// One card per (marketplace, data_type) — latest upload + inline remark editor
const MP_BADGE = {
  flipkart: 'bg-primary-container text-primary',
  amazon:   'bg-amber-100 text-amber-700',
  myntra:   'bg-pink-100 text-pink-700',
  meesho:   'bg-purple-100 text-purple-700',
};
const MP_BORDER = {
  flipkart: 'border-l-indigo-400',
  amazon:   'border-l-amber-400',
  myntra:   'border-l-pink-400',
  meesho:   'border-l-purple-400',
};
const TYPE_LABEL = {
  orders:               'Sales / Orders',
  returns:              'Returns',
  settlements:          'Settlement (Generic)',
  fk_settlement_orders: 'FK Settlement Report',
  fk_settlement:        'FK Settlement Report',
  fk_spf_claims:        'FK SPF Claims',
  fk_storage_recall:    'FK Storage & Recall',
  fk_ads:               'FK Ads',
  fk_google_ads:        'FK Google Ads',
  amazon_order_summary: 'Amazon Sale Orders',
  amazon_order_reports: 'Legacy Amazon Order Reports',
  amazon_sale_orders:   'Amazon Sale Orders',
  amazon_fba_returns:   'Amazon FBA Returns',
  amazon_flex_returns:  'Amazon Flex Returns',
  amazon_settlement:    'Amazon Settlement',
  myntra_ej_orders:     'Myntra (EJ) Sales / Orders',
  myntra_ej_returns:    'Myntra (EJ) Returns',
  myntra_ej_invoices:   'Myntra (EJ) Invoice / Payment',
  myntra_vb_orders:     'Myntra (VB) Sales / Orders',
  myntra_vb_returns:    'Myntra (VB) Returns',
  myntra_vb_invoices:   'Myntra (VB) Invoice / Payment',
};

// Live DB table count key for each upload_log data_type (must match /upload/status counts)
const DB_COUNT_KEY = {
  orders:               'orders',
  returns:              'returns',
  settlements:          'settlements',
  fk_settlement_orders: 'fk_settlement_orders',
  fk_settlement:        'fk_settlement_orders',
  fk_spf_claims:        'fk_spf_claims',
  fk_storage_recall:    'fk_storage_recall',
  fk_ads:               'fk_ads',
  amazon_order_summary: 'amazon_orders',
  amazon_sale_orders:   'amazon_orders',
  amazon_fba_returns:   'amazon_fba_returns',
  amazon_flex_returns:  'amazon_flex_returns',
  amazon_settlement:    'amazon_settlement_lines',
  myntra_ej_orders:     'myntra_ej_orders',
  myntra_ej_returns:    'myntra_ej_returns',
  myntra_ej_invoices:   'myntra_ej_invoices',
  myntra_vb_orders:     'myntra_vb_orders',
  myntra_vb_returns:    'myntra_vb_returns',
  myntra_vb_invoices:   'myntra_vb_invoices',
};

// Maps the active dataType tab → which upload_log.data_type values appear in
// the Status Board + Upload Log for that tab. Keep this in sync with the
// LOG_TYPE_MAP at the top of the file (which goes the other direction).
const TAB_DATA_TYPES = {
  'orders':       ['orders'],
  'returns':      ['returns'],
  'settlements':  ['settlements'],
  'fk-settlement':['fk_settlement_orders','fk_settlement','fk_spf_claims','fk_storage_recall','fk_ads','fk_google_ads'],
  // Amazon — each tile has its own data_type in upload_log

  'amazon-sale-orders':   ['amazon_sale_orders'],
  'amazon-fba-returns':   ['amazon_fba_returns'],
  'amazon-flex-returns':  ['amazon_flex_returns'],
  'amazon-settlement':    ['amazon_settlement'],
  'myntra-orders':        [],
  'myntra-returns':       [],
  'myntra-invoices':      [],
};

function UploadHistory({ logs, counts = {}, onRemarkSaved, activeTab, marketplace, sellerAccount }) {
  const [editId, setEditId]     = useState(null);
  const [editText, setEditText] = useState('');
  const [saving, setSaving]     = useState(false);
  const [saveError, setSaveError] = useState('');
  const [clearing, setClearing] = useState(null);

  const allowed = MYNTRA_DATA_TYPES.has(activeTab) && sellerAccount
    ? [myntraLogType(sellerAccount, activeTab)]
    : (TAB_DATA_TYPES[activeTab] || []);

  // Keep only latest per (marketplace, data_type), filtered to current tab.
  // Do not sum historical batches into New/Updated — use live DB count for sync.
  const latestMap = {};
  for (const log of logs) {
    if (!allowed.includes(log.data_type)) continue;
    const key = `${(log.marketplace || 'flipkart').toLowerCase()}_${log.data_type}`;
    if (!latestMap[key]) {
      latestMap[key] = { ...log, _fileCount: 1 };
    } else {
      latestMap[key]._fileCount += 1;
    }
  }
  const cards = Object.values(latestMap).sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));

  const startEdit  = (log) => { setEditId(log.id); setEditText(log.remark || ''); setSaveError(''); };
  const cancelEdit = () => { setEditId(null); setEditText(''); setSaveError(''); };

  const handleSave = async (id) => {
    setSaving(true);
    setSaveError('');
    try {
      const response = await saveUploadRemark(id, editText);
      if (!response?.ok) throw new Error('The remark was not saved.');
      await onRemarkSaved?.();
      setEditId(null);
    } catch (error) {
      setSaveError(error?.response?.data?.error || error?.message || 'The remark could not be saved. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async (type, label) => {
    const reason = window.prompt(
      `Why are you clearing "${label}" data?\n\nThe original filename, upload counts, your remark, this reason, and the deletion time will remain in Upload History.`,
      `Replacing ${label} with a corrected file`,
    );
    if (reason === null) return;
    if (!reason.trim()) {
      alert('A clear reason is required so the deleted upload can be traced later.');
      return;
    }
    if (!window.confirm(`Clear "${label}" data${marketplace ? ` for ${marketplace}` : ''} from the database?\n\nThe uploaded file record and its remark will be kept in All upload history.`)) return;
    setClearing(type);
    try {
      const result = await clearUploadData(type, marketplace, reason.trim());
      await onRemarkSaved?.();
      alert(`Data cleared. ${result.retainedUploadLogs?.length || 0} upload record(s) were retained in All upload history.`);
    }
    catch (e) { alert('Clear failed: ' + (e?.response?.data?.error || e.message)); }
    setClearing(null);
  };

  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-ink">Upload Status Board</h3>
          <p className="text-[11px] text-outline mt-0.5">Latest upload per data type — click the trash icon to clear and re-upload</p>
        </div>
        <span className="text-[10px] text-outline">{cards.length} active {cards.length === 1 ? 'dataset' : 'datasets'}</span>
      </div>
      <div className="divide-y divide-slate-50">
        {cards.map(log => {
          const mpId = (log.marketplace || 'flipkart').toLowerCase();
          const isOk = log.status === 'ok';
          const isEditing = editId === log.id;
          const dtStr = new Date(log.uploaded_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
          const typeLabel = TYPE_LABEL[log.data_type] || log.data_type;
          const dbKey = DB_COUNT_KEY[log.data_type];
          const liveCount = dbKey != null ? Number(counts[dbKey] || 0) : null;
          return (
            <div key={log.id} className={`flex items-start gap-4 px-5 py-4 hover:bg-surface-container-low/40 border-l-4 transition-colors ${MP_BORDER[mpId] || 'border-l-slate-300'}`}>
              {/* Left: type + meta */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full capitalize ${MP_BADGE[mpId] || 'bg-surface-container text-secondary'}`}>{mpId}</span>
                  <span className="text-sm font-semibold text-ink">{typeLabel}</span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isOk ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                    {isOk ? '✅ OK' : '❌ Error'}
                  </span>
                  {liveCount != null && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-surface-container text-secondary" title="Live row count in database">
                      DB: {liveCount.toLocaleString('en-IN')} rows
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-1 text-[11px] text-secondary flex-wrap">
                  <span>{dtStr}</span>
                  <span>·</span>
                  <span title={log.filename} className="max-w-[200px] truncate">
                    {log.filename} {log._fileCount > 1 && <span className="text-primary font-medium">(+{log._fileCount - 1} more)</span>}
                  </span>
                  {isOk && <><span>·</span><span className="text-emerald-700 font-semibold">{(log.rows_inserted || 0).toLocaleString()} rows in last upload</span></>}
                  {!isOk && <><span>·</span><span className="text-rose-600 max-w-[200px] truncate">{log.error_msg}</span></>}
                </div>

                {/* Skipped rows */}
                {isOk && log.rows_skipped > 0 && (
                  <div className="mt-2">
                    <SkippedRowsPanel logId={log.id} total={log.rows_skipped} compact />
                  </div>
                )}

                {/* Remark row */}
                <div className="mt-2">
                  {isEditing ? (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <input
                          autoFocus
                          type="text"
                          value={editText}
                          onChange={e => setEditText(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleSave(log.id); if (e.key === 'Escape') cancelEdit(); }}
                          placeholder="e.g. March 2026 settlement batch…"
                          maxLength={500}
                          className="flex-1 text-xs border border-primary rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                        <button onClick={() => handleSave(log.id)} disabled={saving}
                          className="text-xs px-3 py-1.5 bg-primary hover:bg-primary disabled:opacity-50 text-white font-semibold rounded-lg">
                          {saving ? '…' : 'Save'}
                        </button>
                        <button onClick={cancelEdit} className="text-xs text-outline hover:text-secondary px-2">Cancel</button>
                      </div>
                      {saveError && <p className="text-xs text-rose-600" role="alert">{saveError}</p>}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      {log.remark
                        ? <span className="text-xs text-secondary italic">"{log.remark}"</span>
                        : <span className="text-[11px] text-outline">No remark — add one to track this batch</span>
                      }
                      <button onClick={() => startEdit(log)}
                        className="flex items-center gap-1 text-[10px] text-primary hover:text-primary font-semibold px-1.5 py-0.5 rounded hover:bg-indigo-50 transition-colors">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                        Edit
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Right: row counts + clear */}
              <div className="flex items-center gap-4 shrink-0">
                {isOk && (
                  <div className="flex gap-4 text-center">
                    <div><p className="text-base font-bold text-emerald-700">{(log.rows_inserted||0).toLocaleString()}</p><p className="text-[10px] text-outline">Processed</p></div>
                    <div><p className="text-base font-bold text-primary">{(log.rows_updated||0).toLocaleString()}</p><p className="text-[10px] text-outline">Updated</p></div>
                    <div><p className="text-base font-bold text-outline">{(log.rows_skipped||0).toLocaleString()}</p><p className="text-[10px] text-outline">Skipped</p></div>
                  </div>
                )}
                <button
                  onClick={() => handleClear(log.data_type, typeLabel)}
                  disabled={!!clearing}
                  title="Clear data — retain file, counts, remark, and audit history"
                  className="p-1.5 text-outline hover:text-rose-500 hover:bg-rose-50 rounded-lg disabled:opacity-40 transition-colors"
                >
                  {clearing === log.data_type ? (
                    <svg className="w-4 h-4 animate-spin text-rose-400" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Current business-data coverage ───────────────────────────────────────────
// Upload time answers "when was the file received?"; this panel answers the
// operational question "up to which business date is the database updated?".
function DataCoveragePanel({ coverage = {}, marketplace, sellerAccount, onRefresh }) {
  const fmtDate = (value) => value && new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
  const account = sellerAccount || '';
  const items = marketplace === 'amazon'
    ? [
        ['amazon_sale_orders', 'Sale Orders'],
        ['amazon_fba_returns', 'FBA Returns'],
        ['amazon_flex_returns', 'Flex Returns'],
        ['amazon_settlement', 'Settlement (Payment)'],
      ]
    : marketplace === 'myntra' && account
      ? [
          [`${account}_orders`, 'Sales / Orders'],
          [`${account}_returns`, 'Returns'],
          [`${account}_invoices`, 'Invoice / Payment'],
        ]
      : [
          ['orders', 'Sales / Orders'],
          ['returns', 'Returns'],
          ['fk_settlement_orders', 'FK Settlement Report'],
        ];

  return (
    <section className="rounded-xl border border-sky-200 bg-sky-50/60 px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-sky-900">Current data coverage</h3>
          <p className="mt-0.5 text-[11px] text-sky-700">Business dates currently stored in the database — use this to know data is updated through which date.</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-lg border border-sky-300 bg-surface px-3 py-1.5 text-xs font-semibold text-sky-800 hover:bg-sky-100"
        >
          ↻ Refresh dates
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {items.map(([key, label]) => {
          const period = coverage[key];
          const through = fmtDate(period?.periodEnd);
          const start = fmtDate(period?.periodStart);
          return (
            <div key={key} className="rounded-lg border border-sky-100 bg-surface px-3 py-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-secondary">{label}</p>
              {through ? <>
                <p className="mt-1 text-sm font-bold text-ink">Updated through {through}</p>
                <p className="mt-0.5 text-[10px] text-secondary">Range: {start || through} → {through}</p>
              </> : <p className="mt-1 text-xs text-outline">No business date has been imported yet</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Full Upload Log ────────────────────────────────────────────────────────────
// Collapsible table showing every upload_log entry (all time)
function UploadLog({ refreshToken, onRefresh }) {
  const [open, setOpen] = useState(true);
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState({ page: 1, pageSize: 25, total: 0 });
  const [marketplace, setMarketplace] = useState('');
  const [status, setStatus] = useState('');
  const [dataType, setDataType] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');

  const [editId, setEditId] = useState(null);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const startEdit = (log) => { setEditId(log.id); setEditText(log.remark || ''); setSaveError(''); };
  const cancelEdit = () => { setEditId(null); setEditText(''); setSaveError(''); };
  const handleSave = async (id) => {
    setSaving(true);
    setSaveError('');
    try {
      const response = await saveUploadRemark(id, editText);
      if (!response?.ok) throw new Error('The remark was not saved.');
      setRows(rows => rows.map(r => r.id === id ? { ...r, remark: editText } : r));
      setEditId(null);
    } catch (error) {
      setSaveError(error?.response?.data?.error || error?.message || 'The remark could not be saved. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError('');
    fetchUploadHistory({
      page,
      pageSize: 25,
      ...(marketplace && { marketplace }),
      ...(status && { status }),
      ...(dataType && { dataType }),
      ...(debouncedSearch && { search: debouncedSearch }),
    }).then(result => {
      if (cancelled) return;
      setRows(result.rows || []);
      setPageInfo(result.pagination || { page, pageSize: 25, total: 0 });
    }).catch(error => {
      if (cancelled) return;
      setRows([]);
      setHistoryError(error?.response?.data?.error || error.message || 'Could not load upload history.');
    }).finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [page, marketplace, status, dataType, debouncedSearch, refreshToken]);

  const changeFilter = (setter) => (event) => {
    setter(event.target.value);
    setPage(1);
  };
  const sorted = rows;
  const pageStart = pageInfo.total ? (pageInfo.page - 1) * pageInfo.pageSize + 1 : 0;
  const pageEnd = Math.min(pageInfo.total, pageInfo.page * pageInfo.pageSize);
  const pageCount = Math.max(1, Math.ceil(pageInfo.total / pageInfo.pageSize));

  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex min-w-0 flex-1 items-center justify-between text-left hover:bg-surface-container-low/50 transition-colors"
        >
        <div>
          <h3 className="text-sm font-semibold text-ink">All upload history</h3>
          <p className="text-[11px] text-outline mt-0.5">Every file attempt, including cleared datasets, across all marketplaces — {pageInfo.total.toLocaleString()} records</p>
        </div>
        <svg className={`w-4 h-4 text-outline transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
        </button>
        <button
          type="button"
          onClick={onRefresh}
          title="Fetch the latest upload history"
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-secondary hover:bg-surface-container-low"
        >
          ↻ Refresh
        </button>
      </div>

      {open && (
        <div className="border-t border-border">
          <div className="grid grid-cols-1 gap-2 p-4 bg-surface-container-low/50 sm:grid-cols-2 lg:grid-cols-4">
            <input
              type="search"
              value={search}
              onChange={changeFilter(setSearch)}
              placeholder="Search file, type, remark, clear reason…"
              className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary"
            />
            <select value={marketplace} onChange={changeFilter(setMarketplace)} className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-ink outline-none focus:border-primary">
              <option value="">All marketplaces</option>
              <option value="flipkart">Flipkart</option>
              <option value="amazon">Amazon</option>
              <option value="myntra">Myntra</option>
            </select>
            <select value={dataType} onChange={changeFilter(setDataType)} className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-ink outline-none focus:border-primary">
              <option value="">All dataset types</option>
              {Object.entries(TYPE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <select value={status} onChange={changeFilter(setStatus)} className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-ink outline-none focus:border-primary">
              <option value="">All statuses</option>
              <option value="ok">Successful</option>
              <option value="error">Failed</option>
              <option value="cleared">Cleared data</option>
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
            <thead>
              <tr className="bg-surface-container-low border-b border-border">
                <th className="text-left px-4 py-2.5 text-[10px] font-semibold text-secondary uppercase tracking-wide">Uploaded at</th>
                <th className="text-left px-4 py-2.5 text-[10px] font-semibold text-secondary uppercase tracking-wide">Marketplace</th>
                <th className="text-left px-4 py-2.5 text-[10px] font-semibold text-secondary uppercase tracking-wide">Type</th>
                <th className="text-left px-4 py-2.5 text-[10px] font-semibold text-secondary uppercase tracking-wide">Status</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-semibold text-secondary uppercase tracking-wide">Processed</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-semibold text-secondary uppercase tracking-wide">Updated</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-semibold text-secondary uppercase tracking-wide">Skipped</th>
                <th className="text-left px-4 py-2.5 text-[10px] font-semibold text-secondary uppercase tracking-wide">File</th>
                <th className="text-left px-4 py-2.5 text-[10px] font-semibold text-secondary uppercase tracking-wide">Error / Remark</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {historyLoading && <tr><td colSpan={9} className="px-4 py-8 text-center text-outline">Loading upload history…</td></tr>}
              {!historyLoading && historyError && <tr><td colSpan={9} className="px-4 py-8 text-center text-rose-600">{historyError}</td></tr>}
              {!historyLoading && !historyError && sorted.length === 0 && <tr><td colSpan={9} className="px-4 py-8 text-center text-outline">No upload records match these filters.</td></tr>}
              {!historyLoading && !historyError && sorted.map(log => {
                const isOk  = log.status === 'ok';
                const isCleared = Boolean(log.data_cleared_at);
                const dtStr = new Date(log.uploaded_at).toLocaleString('en-IN', {
                  day: '2-digit', month: 'short', year: 'numeric',
                  hour: '2-digit', minute: '2-digit',
                });
                const mpId = (log.marketplace || 'flipkart').toLowerCase();
                const clearedAt = isCleared ? new Date(log.data_cleared_at).toLocaleString('en-IN', {
                  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                }) : null;
                const clearedCounts = log.cleared_row_counts && typeof log.cleared_row_counts === 'object'
                  ? Object.entries(log.cleared_row_counts).filter(([, count]) => Number(count) > 0)
                  : [];
                return (
                  <tr key={log.id} className={`hover:bg-surface-container-low/40 ${isCleared ? 'bg-amber-50/40' : !isOk ? 'bg-rose-50/30' : ''}`}>
                    <td className="px-4 py-2.5 text-secondary whitespace-nowrap">{dtStr}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full capitalize ${MP_BADGE[mpId] || 'bg-surface-container text-secondary'}`}>{mpId}</span>
                    </td>
                    <td className="px-4 py-2.5 text-secondary font-medium whitespace-nowrap">{TYPE_LABEL[log.data_type] || log.data_type}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isCleared ? 'bg-amber-100 text-amber-800' : isOk ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                        {isCleared ? '🗑 Cleared' : isOk ? '✅ OK' : '❌ Error'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-ink font-semibold">
                      {isOk ? (log.rows_inserted || 0).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right text-primary font-semibold">{isOk ? (log.rows_updated || 0).toLocaleString() : '—'}</td>
                    <td className="px-4 py-2.5 text-right text-amber-600 font-semibold">{isOk ? (log.rows_skipped || 0).toLocaleString() : '—'}</td>
                    <td className="px-4 py-2.5 text-outline max-w-[180px]">
                      <span className="truncate block" title={log.filename}>
                        {log.filename}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 max-w-[240px]">
                      {!isOk && log.error_msg && (
                        <span className="text-rose-600 truncate block font-mono" title={log.error_msg}>{log.error_msg}</span>
                      )}
                      {isCleared && (
                        <div className="mb-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] leading-4 text-amber-900">
                          <p className="font-semibold">Data cleared {clearedAt}{log.cleared_by_email ? ` by ${log.cleared_by_email}` : ''}</p>
                          {log.clear_reason && <p>Reason: {log.clear_reason}</p>}
                          {clearedCounts.length > 0 && <p>Removed: {clearedCounts.map(([table, count]) => `${Number(count).toLocaleString()} ${table}`).join(', ')}</p>}
                        </div>
                      )}
                      {isOk && (
                        <div className="flex flex-col gap-1 items-start">
                          {editId === log.id ? (
                            <div className="w-full space-y-1 mt-1">
                              <div className="flex items-center gap-1">
                                <input
                                  autoFocus
                                  type="text"
                                  value={editText}
                                  onChange={e => setEditText(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') handleSave(log.id); if (e.key === 'Escape') cancelEdit(); }}
                                  placeholder="Enter remark…"
                                  maxLength={500}
                                  className="flex-1 min-w-0 text-xs border border-primary rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                                <button onClick={() => handleSave(log.id)} disabled={saving} className="text-[10px] px-2 py-1 bg-primary hover:bg-primary text-white font-semibold rounded shrink-0">
                                  {saving ? '…' : 'Save'}
                                </button>
                                <button onClick={cancelEdit} className="text-[10px] text-outline hover:text-secondary px-1 shrink-0">Cancel</button>
                              </div>
                              {saveError && <p className="text-[10px] text-rose-600" role="alert">{saveError}</p>}
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 w-full group">
                              {log.remark 
                                ? <span className="text-secondary italic text-xs truncate" title={log.remark}>"{log.remark}"</span>
                                : <span className="text-[10px] text-outline italic group-hover:text-secondary transition-colors">Add remark</span>
                              }
                              <button onClick={() => startEdit(log)} className="text-[10px] text-primary hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-indigo-50 shrink-0">
                                Edit
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                      {isOk && log.rows_skipped > 0 && <div className="mt-1"><SkippedRowsPanel logId={log.id} total={log.rows_skipped} compact /></div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-2 border-t border-border px-4 py-3 text-xs text-secondary sm:flex-row sm:items-center sm:justify-between">
            <span>{pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of {pageInfo.total.toLocaleString()} records</span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setPage(value => Math.max(1, value - 1))} disabled={page <= 1 || historyLoading} className="rounded-lg border border-border px-3 py-1.5 font-medium text-secondary hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-40">Previous</button>
              <span className="min-w-20 text-center">Page {pageInfo.page} of {pageCount}</span>
              <button type="button" onClick={() => setPage(value => Math.min(pageCount, value + 1))} disabled={page >= pageCount || historyLoading} className="rounded-lg border border-border px-3 py-1.5 font-medium text-secondary hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-40">Next</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
