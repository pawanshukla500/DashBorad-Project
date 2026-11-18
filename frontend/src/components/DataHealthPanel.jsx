import { useState } from 'react';
import { fetchDataHealth, repairMyntraPaymentColumns } from '../api/client';

// On-demand check for stored data that the old upload parsing got wrong
// (swapped dates, rows dropped for valid dates / negative amounts, stale
// derived values). It tells the operator exactly which files to re-upload, and
// offers the one repair that can be done in place.
export default function DataHealthPanel() {
  const [state, setState] = useState({ status: 'idle', report: null, error: null, message: null });

  const run = async () => {
    setState(previous => ({ ...previous, status: 'loading', error: null, message: null }));
    try {
      const report = await fetchDataHealth();
      setState({ status: 'done', report, error: null, message: null });
    } catch (error) {
      setState(previous => ({ ...previous, status: 'idle', error: error?.response?.data?.error || error.message }));
    }
  };

  const repair = async () => {
    setState(previous => ({ ...previous, status: 'loading', error: null }));
    try {
      const { ordersReset, ordersRestored = 0 } = await repairMyntraPaymentColumns();
      const report = await fetchDataHealth();
      const restored = ordersRestored ? ` Restored the status of ${ordersRestored} orders whose reverse payment was removed.` : '';
      setState({ status: 'done', report, error: null, message: `Cleared removed payments from ${ordersReset} Myntra orders.${restored}` });
    } catch (error) {
      setState(previous => ({ ...previous, status: 'done', error: error?.response?.data?.error || error.message }));
    }
  };

  const report = state.report;
  const issues = report ? report.checks.filter(check => check.count > 0) : [];
  const unavailable = report ? report.checks.filter(check => check.unavailable) : [];

  return (
    <div className="bg-surface rounded-xl border border-border p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-ink">Stored data health</h2>
          <p className="text-[11px] text-secondary">
            Finds rows saved by the old upload parsing (swapped dates, dropped rows) and tells you what to re-upload.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={state.status === 'loading'}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-on-primary hover:bg-indigo-dark disabled:opacity-60"
        >
          {state.status === 'loading' ? 'Checking…' : report ? 'Check again' : 'Run check'}
        </button>
      </div>

      {state.error && <p role="alert" className="mt-3 text-xs text-red-700">{state.error}</p>}
      {state.message && <p className="mt-3 text-xs text-emerald-700">{state.message}</p>}

      {report && issues.length === 0 && (
        <p className="mt-3 text-xs text-emerald-700">No affected data found{unavailable.length ? ` (${unavailable.length} check${unavailable.length > 1 ? 's' : ''} unavailable)` : ''}.</p>
      )}

      {issues.length > 0 && (
        <ul className="mt-3 space-y-2">
          {issues.map(check => (
            <li key={check.key} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="font-semibold text-ink">{check.title}</span>
                <span className="font-bold text-amber-700">{check.count.toLocaleString()} rows</span>
              </div>
              <p className="mt-1 text-secondary">{check.detail}</p>
              <ul className="mt-1 text-secondary list-disc pl-4">
                {check.items.slice(0, 8).map(item => (
                  <li key={item.scope}>
                    {item.scope}: {item.count.toLocaleString()}
                    {item.firstDate ? ` (${item.firstDate}${item.lastDate && item.lastDate !== item.firstDate ? ` to ${item.lastDate}` : ''})` : ''}
                  </li>
                ))}
              </ul>
              <div className="mt-1 flex items-center justify-between gap-2 flex-wrap">
                <span className="font-medium text-ink">{check.action}</span>
                {check.repair === 'myntra-payment-columns' && (
                  <button
                    type="button"
                    onClick={repair}
                    disabled={state.status === 'loading'}
                    className="px-2.5 py-1 rounded-md text-[11px] font-semibold border border-primary text-primary bg-primary-container hover:bg-primary-container/70 disabled:opacity-60"
                  >
                    Repair
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
