export default function ChartEmpty({ message = 'No data for selected filters', icon = 'chart' }) {
  const iconName = icon === 'pie' ? 'pie_chart' : 'bar_chart';

  return (
    <div className="flex h-64 flex-col items-center justify-center gap-3 text-outline" role="status" aria-live="polite">
      <span className="material-symbols-outlined text-5xl opacity-25" aria-hidden="true">{iconName}</span>
      <p className="text-sm font-medium">{message}</p>
    </div>
  );
}
