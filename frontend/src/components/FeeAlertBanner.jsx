import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchFeeIntelligence } from '../api/client';
import { useAuth } from '../context/AuthContext';

/**
 * FeeAlertBanner — global dismissable banner that appears when new/increased fees
 * are detected via the /rate-card/intelligence endpoint.
 *
 * - Polls once on mount (no re-poll — performance safe)
 * - Dismissed state stored in localStorage keyed by alert fingerprint
 * - Reappears if alerts change (different fingerprint)
 * - "Configure Rate Card" only for admins
 */
export default function FeeAlertBanner() {
  const navigate   = useNavigate();
  const { user }   = useAuth();
  const isAdmin    = user?.role === 'admin';
  const [alerts,   setAlerts]   = useState([]);
  const [visible,  setVisible]  = useState(false);
  const [loading,  setLoading]  = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await fetchFeeIntelligence();
      const critical = (data?.alerts || []).filter(a => a.severity === 'new' || a.severity === 'up');
      if (!critical.length) { setLoading(false); return; }

      const fingerprint = critical.map(a => `${a.key}:${a.severity}:${Math.round((a.curr||0)/10)*10}`).sort().join('|');
      const dismissed   = localStorage.getItem('feeAlertDismissed');
      if (dismissed === fingerprint) { setLoading(false); return; }

      setAlerts(critical);
      setVisible(true);
    } catch {
      // fail silently — banner is non-critical
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const dismiss = () => {
    if (!alerts.length) return;
    const fingerprint = alerts.map(a => `${a.key}:${a.severity}:${Math.round((a.curr||0)/10)*10}`).sort().join('|');
    localStorage.setItem('feeAlertDismissed', fingerprint);
    setVisible(false);
  };

  if (loading || !visible || !alerts.length) return null;

  const newAlerts = alerts.filter(a => a.severity === 'new');
  const upAlerts  = alerts.filter(a => a.severity === 'up');

  const isNew = newAlerts.length > 0;
  const bg    = isNew ? 'bg-rose-600'   : 'bg-amber-500';
  const bdr   = isNew ? 'border-rose-700' : 'border-amber-600';
  const btnCls = isNew
    ? 'bg-surface text-rose-700 hover:bg-rose-50 border border-rose-200'
    : 'bg-surface text-amber-700 hover:bg-amber-50 border border-amber-200';

  const parts = [];
  if (newAlerts.length) parts.push(`${newAlerts.length} new fee${newAlerts.length > 1 ? 's' : ''} detected`);
  if (upAlerts.length)  parts.push(`${upAlerts.length} fee${upAlerts.length > 1 ? 's' : ''} significantly increased`);
  const headline = parts.join(' · ');

  const names = alerts.slice(0, 3).map(a => a.label);
  const extra = alerts.length > 3 ? ` +${alerts.length - 3} more` : '';

  return (
    <div
      role="alert"
      className={`${bg} ${bdr} border-b text-white flex items-center gap-3 px-4 py-2.5 flex-wrap shrink-0`}
      style={{ zIndex: 50 }}
    >
      <span className="material-symbols-outlined text-[20px] shrink-0" aria-hidden="true">{isNew ? 'warning' : 'trending_up'}</span>
      <div className="flex-1 min-w-0">
        <span className="text-sm font-semibold">{headline}:&nbsp;</span>
        <span className="text-sm opacity-90">
          {names.join(', ')}{extra}
        </span>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => { dismiss(); navigate('/rate-audit'); }}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-white/80 ${btnCls}`}
        >
          View in Rate Audit
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">open_in_new</span>
        </button>
        {isAdmin && (
          <button
            type="button"
            onClick={() => { dismiss(); navigate('/rate-card-config'); }}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-white/80 ${btnCls}`}
          >
            Configure Rate Card
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">arrow_forward</span>
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          title="Dismiss (won't show again for this set of alerts)"
          className="ml-1 rounded-md text-white opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-white/80"
          aria-label="Dismiss fee alert banner"
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">close</span>
        </button>
      </div>
    </div>
  );
}
