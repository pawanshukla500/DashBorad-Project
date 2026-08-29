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
  const icon  = isNew ? '⚡'              : '📈';
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
      <span className="text-lg shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <span className="text-sm font-bold">{headline}:&nbsp;</span>
        <span className="text-sm opacity-90">
          {names.join(', ')}{extra}
        </span>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => { dismiss(); navigate('/rate-audit'); }}
          className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${btnCls}`}
        >
          View in Rate Audit ↗
        </button>
        {isAdmin && (
          <button
            type="button"
            onClick={() => { dismiss(); navigate('/rate-card-config'); }}
            className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${btnCls}`}
          >
            Configure Rate Card →
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          title="Dismiss (won't show again for this set of alerts)"
          className="opacity-70 hover:opacity-100 transition-opacity ml-1 text-white text-lg leading-none"
          aria-label="Dismiss fee alert banner"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
