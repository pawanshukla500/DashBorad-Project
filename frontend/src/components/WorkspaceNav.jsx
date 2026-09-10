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
    <nav className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto" aria-label={`${workspace.label} sections`}>
      {tabs.map(tab => {
        const active = isTabActive(location.pathname, tab);
        return (
          <Link
            key={tab.path}
            to={tab.path}
            aria-current={active ? 'page' : undefined}
            className={`relative flex shrink-0 items-center px-3 font-sans text-body-sm transition-colors ${
              active
                ? 'font-semibold text-primary'
                : 'font-medium text-secondary hover:text-ink'
            }`}
          >
            {tab.label}
            {active && (
              <span
                aria-hidden="true"
                className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
