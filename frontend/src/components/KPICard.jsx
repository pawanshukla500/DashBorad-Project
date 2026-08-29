import { useAnimatedDisplayValue } from '../hooks/useAnimatedDisplayValue';

const ACCENT = {
  indigo:  'border-l-indigo-500',
  emerald: 'border-l-emerald-500',
  rose:    'border-l-rose-500',
  amber:   'border-l-amber-500',
  sky:     'border-l-sky-500',
  orange:  'border-l-orange-500',
  purple:  'border-l-purple-500',
  violet:  'border-l-violet-500',
  teal:    'border-l-teal-500',
};

const COLORS = {
  indigo:  { bg: 'bg-indigo-50/80',  text: 'text-primary',  border: 'border-primary/60' },
  emerald: { bg: 'bg-emerald-50/80', text: 'text-emerald-600', border: 'border-emerald-100/60' },
  rose:    { bg: 'bg-rose-50/80',    text: 'text-rose-600',    border: 'border-rose-100/60' },
  amber:   { bg: 'bg-amber-50/80',   text: 'text-amber-600',   border: 'border-amber-100/60' },
  sky:     { bg: 'bg-sky-50/80',     text: 'text-sky-600',     border: 'border-sky-100/60' },
  orange:  { bg: 'bg-orange-50/80',  text: 'text-orange-600',  border: 'border-orange-100/60' },
  purple:  { bg: 'bg-purple-50/80',  text: 'text-purple-600',  border: 'border-purple-100/60' },
  violet:  { bg: 'bg-violet-50/80',  text: 'text-violet-600',  border: 'border-violet-100/60' },
  teal:    { bg: 'bg-teal-50/80',    text: 'text-teal-600',    border: 'border-teal-100/60' },
};

export default function KPICard({ title, label, value, sub, color = 'indigo', icon, compact = false }) {
  const c = COLORS[color] || COLORS.indigo;
  const heading = title || label;
  const animatedValue = useAnimatedDisplayValue(value);

  return (
    <div className={`bg-surface rounded-2xl border border-border ${compact ? 'p-card-padding' : 'p-lg'} flex flex-col gap-3 shadow-sm hover:shadow-md transition-shadow duration-300`}>
      <div className="flex items-start justify-between gap-2">
        <p className="font-label-md text-label-md text-outline uppercase tracking-wider">{heading}</p>
        {icon && (
          <div className={`${compact ? 'w-8 h-8' : 'w-10 h-10'} rounded-lg flex items-center justify-center shrink-0 border ${c.bg} ${c.text} ${c.border}`}>
            {icon}
          </div>
        )}
      </div>
      <div>
        <p className={`font-financial-lg text-financial-lg font-bold text-ink tracking-tight tabular-nums`}>{animatedValue}</p>
        {sub && <p className="font-body-sm text-body-sm text-outline mt-1 font-medium">{sub}</p>}
      </div>
    </div>
  );
}
