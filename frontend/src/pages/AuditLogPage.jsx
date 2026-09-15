import { useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import { fetchAuditEvents } from '../api/client';
import useFetch from '../hooks/useFetch';

export default function AuditLogPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const request = useMemo(() => ({ page, action, actor }), [page, action, actor]);
  const { data, loading, error, refetch } = useFetch(() => fetchAuditEvents(request), [page, action, actor]);
  const events = data?.data || [];
  const total = data?.total || 0;
  const pageSize = data?.pageSize || 50;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader title="Audit History" subtitle="Trace configuration, upload, user, and financial changes" />

      <div className="flex flex-wrap gap-3 rounded-xl border border-border bg-surface p-4">
        <input
          value={action}
          onChange={event => { setPage(1); setAction(event.target.value); }}
          placeholder="Filter by action"
          className="rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-[#902A4A] placeholder-outline-variant"
        />
        <input
          value={actor}
          onChange={event => { setPage(1); setActor(event.target.value); }}
          placeholder="Filter by user or role"
          className="rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-[#902A4A] placeholder-outline-variant"
        />
        <span className="ml-auto self-center text-xs font-semibold text-outline">{total} events</span>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          <span>{data ? `Showing the last verified audit events. ${error}` : error}</span>
          <button onClick={refetch} className="shrink-0 rounded-lg border border-rose-200 bg-surface px-3 py-1.5 text-xs font-bold text-rose-700">Retry</button>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-surface-container-low text-[10px] uppercase tracking-wider text-outline">
              <tr>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Actor</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Entity</th>
                <th className="px-4 py-3">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {events.map(event => (
                <tr key={event.id} className="hover:bg-surface-container-low/60">
                  <td className="whitespace-nowrap px-4 py-3 text-secondary">{new Date(event.created_at).toLocaleString('en-IN')}</td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-ink">{event.actor_email || 'System'}</p>
                    <p className="text-[10px] uppercase text-outline">{event.actor_role || 'service'}</p>
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-ink">{event.action}</td>
                  <td className="px-4 py-3 text-secondary">{event.entity_type}{event.entity_id ? ` · ${event.entity_id}` : ''}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-emerald-50 px-2 py-1 font-bold text-emerald-700">
                      HTTP {event.details?.statusCode || 'OK'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading && !data && <div className="p-10 text-center text-sm text-outline">Loading audit history…</div>}
        {loading && data && <div className="border-t border-border p-3 text-center text-xs font-semibold text-outline">Refreshing audit history…</div>}
        <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-secondary">
          <button disabled={page === 1} onClick={() => setPage(value => value - 1)} className="rounded-lg border px-3 py-1.5 disabled:opacity-40">Previous</button>
          <span>Page {page}</span>
          <button disabled={page * pageSize >= total} onClick={() => setPage(value => value + 1)} className="rounded-lg border px-3 py-1.5 disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>
  );
}
