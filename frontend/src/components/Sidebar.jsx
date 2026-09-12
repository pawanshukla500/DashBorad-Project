import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ADMIN_WORKSPACE, WORKSPACES, canAccessWorkspace, isWorkspaceActive } from '../navigation';

const ICONS = {
  overview: 'dashboard',
  sales: 'monitoring',
  returns: 'keyboard_return',
  payouts: 'payments',
  profitability: 'analytics',
  data: 'database',
  admin: 'admin_panel_settings',
};

function WorkspaceIcon({ name, filled }) {
  return (
    <span
      className="material-symbols-outlined text-[20px]"
      aria-hidden="true"
      style={filled ? { fontVariationSettings: "'FILL' 1" } : undefined}
    >
      {ICONS[name] || 'circle'}
    </span>
  );
}

function Brand() {
  return (
    <div className="flex items-center px-6 mb-6 gap-2.5">
      <img src="/logo.png" alt="ReconCentral Logo" className="h-8 w-8 object-contain" />
      <span className="font-display text-headline-md font-semibold text-ink">ReconCentral</span>
    </div>
  );
}

export default function Sidebar({ open = false, onClose }) {
  const location = useLocation();
  const { user } = useAuth();

  useEffect(() => {
    onClose?.();
  }, [location.pathname, onClose]);

  const workspaces = (user?.role === 'admin' ? [...WORKSPACES, ADMIN_WORKSPACE] : WORKSPACES)
    .filter(workspace => canAccessWorkspace(workspace, user?.role));

  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-ink/40 lg:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-sidebar-width shrink-0 flex-col bg-surface border-r border-border py-6 transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-label="Primary navigation"
      >
        <Brand />

        <nav className="flex-1 overflow-y-auto px-4 space-y-0.5">
          {workspaces.map(workspace => {
            const active = isWorkspaceActive(location.pathname, workspace);
            const showTabs = active && workspace.tabs && workspace.tabs.length > 1;
            return (
              <div key={workspace.key} className="space-y-0.5">
                <Link
                  to={workspace.path}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-primary/40 ${
                    active
                      ? 'text-primary font-semibold bg-surface-container-low'
                      : 'text-secondary font-medium hover:text-ink hover:bg-surface-container-low'
                  }`}
                >
                  <WorkspaceIcon name={workspace.key} filled={active} />
                  <span className="min-w-0 truncate text-[14px]">{workspace.label}</span>
                </Link>

                {showTabs && (
                  <div className="pl-4 pr-1 py-0.5 space-y-0.5 border-l-2 border-primary/25 ml-5 my-0.5">
                    {workspace.tabs.map(tab => {
                      const tabActive = location.pathname === tab.path || (tab.aliases && tab.aliases.includes(location.pathname));
                      return (
                        <Link
                          key={tab.path}
                          to={tab.path}
                          aria-current={tabActive ? 'page' : undefined}
                          className={`flex items-center px-2.5 py-1.5 rounded-md text-[13px] transition-colors ${
                            tabActive
                              ? 'text-primary font-semibold bg-primary/10'
                              : 'text-secondary hover:text-ink hover:bg-surface-container-low'
                          }`}
                        >
                          <span className="truncate">{tab.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
