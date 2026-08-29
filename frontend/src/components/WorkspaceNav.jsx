import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { canAccessTab, isTabActive, workspaceForPath } from '../navigation';

export default function WorkspaceNav() {
  const location = useLocation();
  const { user } = useAuth();
  const workspace = workspaceForPath(location.pathname, user?.role === 'admin');
  const tabs = workspace?.tabs.filter(tab => canAccessTab(tab, user?.role)) || [];

  if (!workspace || tabs.length <= 1) return null;

  return (
    <div className="shrink-0 border-b border-border bg-surface px-4 md:px-6">
      <div className="flex items-center gap-1 overflow-x-auto py-2" aria-label={`${workspace.label} sections`}>
        <span className="mr-2 hidden shrink-0 font-label-md text-label-md text-outline lg:inline">
          {workspace.label}
        </span>
        {tabs.map(tab => {
          const active = isTabActive(location.pathname, tab);
          return (
            <Link
              key={tab.path}
              to={tab.path}
              aria-current={active ? 'page' : undefined}
              className={`relative shrink-0 rounded-lg px-3.5 py-2 font-body-sm text-body-sm font-bold transition-all ${
                active
                  ? 'bg-surface-container-low text-primary shadow-sm'
                  : 'text-secondary hover:bg-surface-container hover:text-ink'
              }`}
            >
              {tab.label}
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-3 -bottom-[9px] h-0.5 rounded-full bg-primary"
                />
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
