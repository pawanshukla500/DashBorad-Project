import { useState } from 'react';
import { exportXlsx } from '../utils/exportXlsx';
import { useAuth } from '../context/AuthContext';
import { canExport } from '../utils/roles';

export default function ExportButton({ buildExport, label = 'Export XLSX', disabled = false }) {
  const { user } = useAuth();
  const allowed = canExport(user?.role);
  const [state, setState] = useState('idle'); // idle | loading | done | error
  const [errorMessage, setErrorMessage] = useState('');

  async function handleExport() {
    if (!allowed || state === 'loading' || disabled) return;
    setErrorMessage('');
    setState('loading');
    try {
      const { filename, sheets } = await Promise.resolve(buildExport());
      await exportXlsx(sheets, filename);
      setState('done');
      setTimeout(() => setState('idle'), 2500);
    } catch (e) {
      console.error('Export failed', e);
      setErrorMessage(e instanceof Error ? e.message : 'The export could not be generated.');
      setState('error');
      setTimeout(() => {
        setState('idle');
        setErrorMessage('');
      }, 5000);
    }
  }

  if (!allowed) {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-[11px] text-outline" title="Analyst role or higher required">
        Export (analyst+)
      </span>
    );
  }

  const cfg = {
    idle:    { bg: 'bg-surface hover:bg-indigo-50 border-border text-ink hover:border-primary hover:text-primary', icon: 'download',  text: label },
    loading: { bg: 'bg-primary-container border-primary text-primary cursor-wait',                                  icon: 'progress_activity', text: 'Generating...' },
    done:    { bg: 'bg-emerald-50 border-emerald-300 text-emerald-700',                                           icon: 'check',     text: 'Downloaded!' },
    error:   { bg: 'bg-rose-50 border-rose-300 text-rose-700',                                                     icon: 'error',     text: 'Failed' },
  }[state];

  return (
    <button
      type="button"
      onClick={handleExport}
      disabled={disabled || state === 'loading'}
      title={state === 'error' ? errorMessage : undefined}
      aria-busy={state === 'loading'}
      aria-live="polite"
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-all duration-150 select-none focus-visible:ring-2 focus-visible:ring-primary/40 ${cfg.bg} ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
    >
      <span className={`material-symbols-outlined text-[16px] ${state === 'loading' ? 'animate-spin' : ''}`} aria-hidden="true">
        {cfg.icon}
      </span>
      {cfg.text}
    </button>
  );
}
