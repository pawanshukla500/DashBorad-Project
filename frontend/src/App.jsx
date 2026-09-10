import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import FilterBar from './components/FilterBar';
import WorkspaceNav from './components/WorkspaceNav';
import ErrorBoundary from './components/ErrorBoundary';
import FeeAlertBanner from './components/FeeAlertBanner';
import ServiceStatusBanner from './components/ServiceStatusBanner';
import { FilterProvider } from './context/FilterContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { OPS_ROLES, workspaceForPath } from './navigation';
import { hasRole } from './utils/roles';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const SalesPage = lazy(() => import('./pages/SalesPage'));
const ReturnsPage = lazy(() => import('./pages/ReturnsPage'));
const ReturnTrackingPage = lazy(() => import('./pages/ReturnTrackingPage'));
const ProfitLossPage = lazy(() => import('./pages/ProfitLossPage'));
const ProfitAnalysisPage = lazy(() => import('./pages/ProfitAnalysisPage'));
const CashFlowPage = lazy(() => import('./pages/CashFlowPage'));
const CalculatorPage = lazy(() => import('./pages/CalculatorPage'));
const StatementPage = lazy(() => import('./pages/StatementPage'));
const OrderLifecyclePage = lazy(() => import('./pages/OrderLifecyclePage'));
const PaymentReconciliationPage = lazy(() => import('./pages/PaymentReconciliationPage'));
const RateAuditPage = lazy(() => import('./pages/RateAuditPage'));
const AmazonReconciliationPage = lazy(() => import('./pages/AmazonReconciliationPage'));
const UploadPage = lazy(() => import('./pages/UploadPage'));
const RateCardConfigPage = lazy(() => import('./pages/RateCardConfigPage'));
const AmazonFcSettingsPage = lazy(() => import('./pages/AmazonFcSettings'));
const InsightsPage = lazy(() => import('./pages/InsightsPage'));
const ExceptionInboxPage = lazy(() => import('./pages/ExceptionInboxPage'));
const ChargesConfigPage = lazy(() => import('./pages/ChargesConfigPage'));
const AdminCenterPage = lazy(() => import('./pages/AdminCenterPage'));
const AuditLogPage = lazy(() => import('./pages/AuditLogPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));

function FullScreenLoader() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-on-surface">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary/20 border-t-primary" />
      <div className="text-center">
        <p className="text-sm font-semibold">ReconCentral</p>
        <p className="mt-1 text-xs text-outline">Loading Workspace…</p>
      </div>
    </div>
  );
}

function PageLoader() {
  return (
    <div className="flex min-h-[45vh] items-center justify-center">
      <div className="flex items-center gap-3 rounded-xl border border-outline-variant bg-surface-container-lowest px-4 py-3 text-xs font-semibold text-secondary shadow-sm">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-outline-variant border-t-primary" />
        Loading workspace…
      </div>
    </div>
  );
}

function UserMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-surface-container-low"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary font-sans text-body-sm font-semibold">
          {user?.username?.charAt(0).toUpperCase() || 'U'}
        </div>
        <div className="hidden md:block text-left">
          <p className="font-sans text-body-sm font-medium text-ink leading-4">{user?.username || 'User'}</p>
          <p className="font-sans text-[11px] capitalize text-outline leading-4">{user?.role || 'viewer'}</p>
        </div>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-border bg-surface py-1"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onLogout(); }}
            className="w-full px-3 py-2 text-left font-sans text-body-sm font-medium text-secondary hover:bg-surface-container-low hover:text-ink"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

function AppChrome({ onOpenSidebar, user, onLogout }) {
  const { pathname } = useLocation();
  const workspace = workspaceForPath(pathname, user?.role === 'admin');

  return (
    <header className="sticky top-0 z-30 bg-surface/95 backdrop-blur-md border-b border-border">
      <div className="flex h-[52px] items-center gap-3 px-4 md:px-6">
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="Open navigation"
          className="lg:hidden rounded-lg p-2 text-secondary hover:bg-surface-container-low"
        >
          <span className="material-symbols-outlined">menu</span>
        </button>

        <h2 className="hidden sm:block shrink-0 font-display text-headline-md font-semibold text-ink">
          {workspace.label}
        </h2>

        <WorkspaceNav />

        <div className="ml-auto shrink-0">
          <UserMenu user={user} onLogout={onLogout} />
        </div>
      </div>
      <FilterBar />
    </header>
  );
}

function AppRoutes({ user }) {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/sales" element={<SalesPage />} />
      <Route path="/returns" element={<ReturnsPage />} />
      <Route
        path="/return-tracking"
        element={hasRole(user.role, OPS_ROLES) ? <ReturnTrackingPage /> : <Navigate to="/returns" replace />}
      />
      <Route path="/profit-loss" element={<ProfitLossPage />} />
      <Route path="/profit-analysis" element={<ProfitAnalysisPage />} />
      <Route path="/cash-flow" element={<CashFlowPage />} />
      <Route path="/calculator" element={<CalculatorPage />} />
      <Route path="/payments" element={<PaymentReconciliationPage />} />
      <Route path="/statement" element={<StatementPage />} />
      <Route path="/unified-linkup" element={<OrderLifecyclePage />} />
      <Route path="/rate-audit" element={<RateAuditPage />} />
      <Route path="/amazon-reconciliation" element={<AmazonReconciliationPage />} />
      <Route
        path="/upload"
        element={hasRole(user.role, OPS_ROLES) ? <UploadPage /> : <Navigate to="/" replace />}
      />
      <Route
        path="/rate-card-config"
        element={user.role === 'admin' ? <RateCardConfigPage /> : <Navigate to="/upload" replace />}
      />
      <Route path="/insights" element={<InsightsPage />} />
      <Route path="/exceptions" element={<ExceptionInboxPage />} />
      <Route
        path="/charges"
        element={user.role === 'admin' ? <ChargesConfigPage /> : <Navigate to="/" replace />}
      />
      <Route
        path="/settings/amazon-fc"
        element={user.role === 'admin' ? <AmazonFcSettingsPage /> : <Navigate to="/" replace />}
      />
      <Route
        path="/admin-center"
        element={user.role === 'admin' ? <AdminCenterPage /> : <Navigate to="/" replace />}
      />
      <Route
        path="/audit-log"
        element={user.role === 'admin' ? <AuditLogPage /> : <Navigate to="/" replace />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function AppContent() {
  const { user, loading, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  if (loading) return <FullScreenLoader />;

  if (!user) {
    return (
      <Suspense fallback={<FullScreenLoader />}>
        <LoginPage />
      </Suspense>
    );
  }

  return (
    <div className="bg-canvas text-ink h-screen flex overflow-hidden font-sans selection:bg-primary-container selection:text-on-primary">
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />

      <div className="flex-1 flex flex-col min-h-0 relative w-full lg:w-[calc(100%-16rem)]">
        <AppChrome
          onOpenSidebar={() => setSidebarOpen(true)}
          user={user}
          onLogout={logout}
        />
        <ServiceStatusBanner />
        <FeeAlertBanner />

        <main className="flex-1 pt-5 px-4 md:px-6 lg:px-container-padding pb-container-padding bg-transparent overflow-y-auto">
          <ErrorBoundary>
            <Suspense fallback={<PageLoader />}>
              <AppRoutes user={user} />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <FilterProvider>
        <AppContent />
      </FilterProvider>
    </AuthProvider>
  );
}
