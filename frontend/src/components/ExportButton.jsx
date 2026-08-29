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
    idle:    { bg: 'bg-surface hover:bg-indigo-50 border-border text-ink hover:border-primary hover:text-primary', icon: <DownloadIcon />,  text: label },
    loading: { bg: 'bg-primary-container border-primary text-primary cursor-wait',                                                 icon: <SpinIcon />,      text: 'Generating…' },
    done:    { bg: 'bg-emerald-50 border-emerald-300 text-emerald-700',                                                          icon: <CheckIcon />,     text: 'Downloaded!' },
    error:   { bg: 'bg-rose-50 border-rose-300 text-rose-700',                                                                   icon: <ErrorIcon />,     text: 'Failed' },
  }[state];

  return (
    <button
      onClick={handleExport}
      disabled={disabled || state === 'loading'}
      title={state === 'error' ? errorMessage : undefined}
      className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold transition-all duration-150 select-none ${cfg.bg} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
    >
      {cfg.icon}
      {cfg.text}
    </button>
  );
}

function DownloadIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
    </svg>
  );
}
function SpinIcon() {
  return (
    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}
function ErrorIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
