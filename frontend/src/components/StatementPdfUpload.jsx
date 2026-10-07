import { useRef, useState } from 'react';
import { commitStatement, uploadStatement } from '../api/client';
import { currencyFull } from '../utils/format';

/**
 * Settlement statement PDF → review → save.
 *
 * Uploading only parses the PDF (Gemini reads its text) and returns a preview;
 * nothing is written until the reviewer saves it. Replacing a month that is
 * already saved, and saving rows whose figures or descriptions could not be
 * found in the PDF text, each need an explicit tick.
 */
export default function StatementPdfUpload() {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [step, setStep] = useState('idle'); // idle | parsing | review | saving | saved
  const [preview, setPreview] = useState(null);
  const [replace, setReplace] = useState(false);
  const [acceptUnverified, setAcceptUnverified] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);

  function reset() {
    setFile(null);
    setPreview(null);
    setReplace(false);
    setAcceptUnverified(false);
    setError(null);
    setSaved(null);
    setStep('idle');
    if (fileRef.current) fileRef.current.value = '';
  }

  async function handleRead() {
    if (!file) return;
    setError(null);
    setStep('parsing');
    try {
      const form = new FormData();
      form.append('pdf', file);
      const result = await uploadStatement(form);
      setPreview(result);
      setReplace(false);
      setAcceptUnverified(false);
      setStep('review');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setStep('idle');
    }
  }

  async function handleSave() {
    if (!preview) return;
    setError(null);
    setStep('saving');
    try {
      const result = await commitStatement({
        previewId: preview.previewId,
        ...(replace ? { replace: true } : {}),
        ...(acceptUnverified ? { acceptUnverified: true } : {}),
      });
      setSaved(result);
      setStep('saved');
    } catch (e) {
      const status = e.response?.status;
      const data = e.response?.data || {};
      if (status === 404) {
        // Expired or already saved — the preview cannot be committed again.
        reset();
      } else {
        if (status === 409 && data.monthExists) {
          // Another upload saved this month after the preview was made.
          setPreview(p => ({ ...p, monthExists: true, existingRows: data.existingRows }));
          setReplace(false);
        }
        setStep('review');
      }
      setError(data.error || e.message);
    }
  }

  const flagged = preview?.flaggedRows || 0;
  const needsReplace = !!preview?.monthExists;
  const canSave = step === 'review' && (!needsReplace || replace) && (!flagged || acceptUnverified);

  return (
    <section className="rounded-xl border border-stone-200 bg-surface px-4 py-4 space-y-3" aria-labelledby="statement-pdf-heading">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 id="statement-pdf-heading" className="text-sm font-semibold text-ink">Settlement statement PDF</h2>
          <p className="text-xs text-outline mt-0.5">
            Read a Flipkart monthly settlement statement, check the extracted lines, then save them.
          </p>
        </div>
        {step === 'review' || step === 'saving' || step === 'saved' ? (
          <button type="button" onClick={reset} disabled={step === 'saving'}
            className="rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-semibold text-secondary hover:text-ink disabled:opacity-50">
            {step === 'saved' ? 'Upload another' : 'Discard'}
          </button>
        ) : null}
      </div>

      {(step === 'idle' || step === 'parsing') && (
        <div className="flex items-center gap-2 flex-wrap">
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            disabled={step === 'parsing'}
            onChange={e => { setFile(e.target.files?.[0] || null); setError(null); }}
            className="text-xs text-secondary file:mr-3 file:rounded-lg file:border file:border-stone-200 file:bg-stone-50 file:px-3 file:py-1.5 file:text-xs file:font-semibold"
          />
          <button type="button" onClick={handleRead} disabled={!file || step === 'parsing'}
            className="rounded-lg bg-[#902A4A] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {step === 'parsing' ? 'Reading PDF…' : 'Read statement'}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
      )}

      {preview && (step === 'review' || step === 'saving') && (
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Fact label="Month" value={preview.month} />
            <Fact label="Period" value={preview.period} />
            <Fact label="Sale amount" value={currencyFull(preview.saleAmount)} />
            <Fact label="Total settled" value={currencyFull(preview.totalSettled)} />
          </dl>

          {needsReplace && (
            <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} className="mt-0.5" />
              <span>
                A statement for <strong>{preview.month}</strong> is already saved ({preview.existingRows} rows).
                Replace it with these {preview.items.length} lines.
              </span>
            </label>
          )}

          {flagged > 0 && (
            <label className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
              <input type="checkbox" checked={acceptUnverified} onChange={e => setAcceptUnverified(e.target.checked)} className="mt-0.5" />
              <span>
                {flagged} highlighted line{flagged === 1 ? '' : 's'} could not be matched to the PDF text, so the
                AI may have misread or invented them. I have checked them against the PDF.
              </span>
            </label>
          )}

          <div className="overflow-x-auto rounded-lg border border-stone-200">
            <table className="w-full text-xs">
              <thead className="bg-stone-50 text-left text-[11px] uppercase tracking-wide text-outline">
                <tr>
                  <th scope="col" className="px-3 py-2 font-semibold">Description</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Category</th>
                  <th scope="col" className="px-3 py-2 font-semibold text-right">Credits</th>
                  <th scope="col" className="px-3 py-2 font-semibold text-right">Debits</th>
                  <th scope="col" className="px-3 py-2 font-semibold text-right">Net</th>
                  <th scope="col" className="px-3 py-2 font-semibold text-right">% of sales</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {preview.items.map((item, i) => {
                  const issues = item.issues || [];
                  return (
                    <tr key={i} className={issues.length ? 'bg-rose-50/70' : item.category === 'Total' ? 'bg-stone-50 font-semibold' : ''}>
                      <td className="px-3 py-1.5 text-ink">
                        {item.description}
                        {issues.length > 0 && (
                          <ul className="mt-0.5 text-[11px] font-normal text-rose-700">
                            {issues.map(issue => <li key={issue}>{issue}</li>)}
                          </ul>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-secondary">{item.category}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{item.credits ? currencyFull(item.credits) : '—'}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{item.debits ? currencyFull(item.debits) : '—'}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{currencyFull(item.net)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{item.pct}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-end gap-3">
            {!canSave && step === 'review' && (
              <span className="text-[11px] text-outline">Tick the confirmation{needsReplace && flagged ? 's' : ''} above to save.</span>
            )}
            <button type="button" onClick={handleSave} disabled={!canSave}
              className="rounded-lg bg-[#902A4A] px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {step === 'saving' ? 'Saving…' : needsReplace ? `Replace ${preview.month}` : `Save ${preview.month}`}
            </button>
          </div>
        </div>
      )}

      {step === 'saved' && saved && (
        <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          Saved {saved.rowsWritten} lines for {saved.month} ({saved.period})
          {saved.replacedRows ? `, replacing ${saved.replacedRows} earlier lines` : ''}.
        </p>
      )}
    </section>
  );
}

function Fact({ label, value }) {
  return (
    <div className="rounded-lg bg-stone-50 px-3 py-2">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-outline">{label}</dt>
      <dd className="mt-0.5 font-semibold text-ink">{value}</dd>
    </div>
  );
}
