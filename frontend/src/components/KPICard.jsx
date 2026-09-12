import { useAnimatedDisplayValue } from '../hooks/useAnimatedDisplayValue';

const TONES = {
  primary: { bg: 'bg-primary/10', text: 'text-primary', border: 'border-primary/20' },
  success: { bg: 'bg-emerald-50', text: 'text-success', border: 'border-emerald-100' },
  warning: { bg: 'bg-amber-50', text: 'text-warning', border: 'border-amber-100' },
  danger: { bg: 'bg-rose-50', text: 'text-danger', border: 'border-rose-100' },
};

const ALIAS = {
  indigo: 'primary',
  sky: 'primary',
  teal: 'primary',
  purple: 'primary',
  violet: 'primary',
  emerald: 'success',
  amber: 'warning',
  orange: 'warning',
  rose: 'danger',
};

export default function KPICard({ title, label, value, sub, color = 'primary', icon, compact = false, onClick }) {
  const tone = TONES[ALIAS[color] || color] || TONES.primary;
  const heading = title || label;
  const animatedValue = useAnimatedDisplayValue(value);

  return (
    <div
      className={`bg-surface rounded-xl border border-border ${compact ? 'p-card-padding' : 'p-4'} flex min-w-0 flex-col gap-3 ${
        onClick ? 'cursor-pointer hover:border-primary/40 hover:shadow-sm transition-all' : ''
      }`}
      role={onClick ? 'button' : 'group'}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } } : undefined}
      aria-label={heading}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 font-sans text-label-md text-outline uppercase">{heading}</p>
        {icon && (
          <div className={`${compact ? 'w-8 h-8' : 'w-9 h-9'} rounded-lg flex items-center justify-center shrink-0 border ${tone.bg} ${tone.text} ${tone.border}`} aria-hidden="true">
            {icon}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <p className="break-words font-sans text-financial-lg font-semibold text-ink tabular-nums">{animatedValue}</p>
        {sub && <p className="mt-1 min-w-0 font-sans text-body-sm text-outline">{sub}</p>}
      </div>
    </div>
  );
}
