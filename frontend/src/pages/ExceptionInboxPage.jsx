import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import { fetchExceptions, updateExceptionStatus } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { OPS_ROLES } from '../navigation';
import { hasRole } from '../utils/roles';
import useFetch from '../hooks/useFetch';

const TYPE_LABELS = {
  failed_upload: 'Failed uploads',
  unmapped_sku: 'Unmapped SKUs',
  unsettled_orders: 'Unsettled orders',
  unresolved_returns: 'Returns',
  missing_rate_card: 'Rate-card gaps',
};

export default function ExceptionInboxPage() {
  const { user } = useAuth();
  const [type, setType] = useState('all');
  const [includeResolved, setIncludeResolved] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [actionError, setActionError] = useState('');
  const canResolve = hasRole(user?.role, OPS_ROLES);
  const { data: response, loading, error: reportError, refetch } = useFetch(
    () => fetchExceptions(includeResolved),
    [includeResolved],
  );
  const data = response || { summary: {}, items: [] };
  const error = actionError || reportError;

  const items = useMemo(
    () => type === 'all' ? data.items : data.items.filter(item => item.type === type),
    [data.items, type]
  );

  const resolve = async (item, status) => {
    setBusyKey(item.key);
    setActionError('');
    try {
      await updateExceptionStatus(item.key, status);
      refetch();
    } catch (err) {
      setActionError(err.response?.data?.error || err.message);
    } finally {
      setBusyKey('');
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Exception Inbox"
        subtitle="A single queue for financial and operational issues that need attention"
      >
        <button onClick={() => { setActionError(''); refetch(); }} className="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-bold text-secondary hover:bg-surface-container-low">
          Refresh
        </button>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ['Open issues', data.summary.total || 0, 'text-ink'],
          ['Critical', data.summary.critical || 0, 'text-rose-600'],
          ['Warnings', data.summary.warning || 0, 'text-amber-600'],
          ['Rate gaps', data.summary.missing_rate_card || 0, 'text-primary'],
        ].map(([label, value, color]) => (
          <div key={label} className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-wider text-outline">{label}</p>
            <p className={`mt-2 text-2xl font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface p-3">
        <button
          onClick={() => setType('all')}
          className={`rounded-lg px-3 py-1.5 text-xs font-bold ${type === 'all' ? 'bg-primary text-white' : 'text-secondary hover:bg-surface-container-low'}`}
        >
          All
        </button>
        {Object.entries(TYPE_LABELS).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setType(key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold ${type === key ? 'bg-primary text-white' : 'text-secondary hover:bg-surface-container-low'}`}
          >
            {label}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-xs font-semibold text-secondary">
          <input type="checkbox" checked={includeResolved} onChange={event => setIncludeResolved(event.target.checked)} />
          Show resolved
        </label>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">
          <span>{response ? `Showing the last verified exceptions. ${error}` : error}</span>
          <button onClick={() => { setActionError(''); refetch(); }} className="shrink-0 rounded-lg border border-rose-200 bg-surface px-3 py-1.5 text-xs font-bold text-rose-700">Retry</button>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        {loading && !response ? (
          <div className="p-10 text-center text-sm text-outline">Loading exceptions…</div>
        ) : items.length === 0 ? (
          <div className="p-12 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">✓</div>
            <p className="mt-3 font-bold text-ink">Inbox is clear</p>
            <p className="mt-1 text-sm text-outline">No issues match this view.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {items.map(item => {
              const resolved = item.resolution?.status === 'resolved';
              return (
                <div key={item.key} className={`flex flex-col gap-4 p-4 md:flex-row md:items-center ${resolved ? 'bg-surface-container-low/70 opacity-65' : ''}`}>
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${item.severity === 'critical' ? 'bg-rose-500' : 'bg-amber-400'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-bold text-ink">{item.title}</p>
                      {item.marketplace && <span className="rounded-full bg-surface-container px-2 py-0.5 text-[10px] font-bold uppercase text-secondary">{item.marketplace}</span>}
                      <span className="rounded-full bg-primary-container px-2 py-0.5 text-[10px] font-bold text-primary">{TYPE_LABELS[item.type]}</span>
                    </div>
                    <p className="mt-1 text-sm text-secondary">{item.detail}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Link to={item.route} className="rounded-lg border border-border px-3 py-2 text-xs font-bold text-secondary hover:bg-surface-container-low">
                      Open
                    </Link>
                    {canResolve && (
                      <button
                        disabled={busyKey === item.key}
                        onClick={() => resolve(item, resolved ? 'open' : 'resolved')}
                        className={`rounded-lg px-3 py-2 text-xs font-bold ${
                          resolved ? 'bg-surface-container-high text-ink' : 'bg-emerald-600 text-white hover:bg-emerald-700'
                        }`}
                      >
                        {resolved ? 'Reopen' : 'Resolve'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {loading && response && <div className="border-t border-border p-3 text-center text-xs font-semibold text-outline">Refreshing exceptions…</div>}
      </div>
    </div>
  );
}
