/** Roles that can mutate data / open ops tools (legacy `user` maps to operator). */
export const OPS_ROLES = ['operator', 'admin'];

/** Roles that can export reports (analyst and above). */
export const EXPORT_ROLES = ['analyst', 'operator', 'admin'];

/**
 * Per-route filter contract — FilterBar only enables controls that apply.
 * marketplace: always shown when filtersShown
 * dates / groupBy / advanced: as listed
 */
export const ROUTE_FILTERS = {
  '/':                 { marketplace: true, dates: true, groupBy: true, advanced: true },
  '/sales':            { marketplace: true, dates: true, groupBy: true, advanced: true },
  '/returns':          { marketplace: true, dates: true, groupBy: true, advanced: true },
  '/return-tracking':  { marketplace: true, dates: false, groupBy: false, advanced: false },
  '/insights':         { marketplace: true, dates: true, groupBy: false, advanced: false },
  '/exceptions':       { marketplace: true, dates: true, groupBy: false, advanced: false },
  '/statement':        { marketplace: true, dates: false, groupBy: false, advanced: false },
  '/payments':         { marketplace: true, dates: true, groupBy: false, advanced: false },
  '/outstanding-payments': { marketplace: true, dates: true, groupBy: false, advanced: false },
  '/rate-audit':       { marketplace: true, dates: true, groupBy: false, advanced: false },
  '/amazon-reconciliation': { marketplace: false, dates: false, groupBy: false, advanced: false },
  '/unified-linkup':   { marketplace: true, dates: false, groupBy: false, advanced: false },
  '/profit-loss':      { marketplace: true, dates: true, groupBy: false, advanced: true },
  '/profit-analysis':  { marketplace: true, dates: true, groupBy: false, advanced: true },
  '/cash-flow':        { marketplace: true, dates: false, groupBy: false, advanced: false },
  '/calculator':       { marketplace: false, dates: false, groupBy: false, advanced: false },
  '/upload':           { marketplace: false, dates: false, groupBy: false, advanced: false },
  '/rate-card-config': { marketplace: false, dates: false, groupBy: false, advanced: false },
  '/admin-center':     { marketplace: false, dates: false, groupBy: false, advanced: false },
  '/charges':          { marketplace: false, dates: false, groupBy: false, advanced: false },
  '/audit-log':        { marketplace: false, dates: false, groupBy: false, advanced: false },
  '/settings/amazon-fc': { marketplace: false, dates: false, groupBy: false, advanced: false },
};

export function filtersForPath(pathname) {
  const exact = ROUTE_FILTERS[pathname];
  if (exact) return exact;
  const key = Object.keys(ROUTE_FILTERS).find(p => p !== '/' && pathname.startsWith(p));
  return ROUTE_FILTERS[key] || { marketplace: true, dates: true, groupBy: true, advanced: true };
}

export const WORKSPACES = [
  {
    key: 'overview',
    label: 'Control Center',
    description: 'Daily actions, alerts, and business health',
    job: 'Start with uploads, gaps, and payout health',
    path: '/',
    paths: ['/', '/insights', '/exceptions'],
    tabs: [
      { path: '/', label: 'Dashboard', end: true },
      { path: '/exceptions', label: 'Exception Inbox' },
      { path: '/insights', label: 'Seller Intelligence' },
    ],
  },
  {
    key: 'sales',
    label: 'Sales',
    description: 'What did I sell?',
    job: 'Orders and revenue by period',
    path: '/sales',
    paths: ['/sales'],
    tabs: [{ path: '/sales', label: 'Sales Analysis' }],
  },
  {
    key: 'returns',
    label: 'Returns',
    description: 'What came back?',
    job: 'Return analytics and warehouse tracking',
    path: '/returns',
    paths: ['/returns', '/return-tracking'],
    tabs: [
      { path: '/returns', label: 'Returns Analysis' },
      { path: '/return-tracking', label: 'Return Tracking', roles: OPS_ROLES },
    ],
  },
  {
    key: 'payouts',
    label: 'Reconciliation',
    description: 'What did I get paid and what was charged?',
    job: 'Sale → bank → fee reconciliation',
    path: '/payments',
    paths: ['/payments', '/outstanding-payments', '/statement', '/rate-audit', '/amazon-reconciliation', '/unified-linkup'],
    tabs: [
      { path: '/payments', label: 'Payment Check', aliases: ['/rate-audit', '/amazon-reconciliation'] },
      { path: '/outstanding-payments', label: 'Outstanding Payments' },
      { path: '/statement', label: 'Statements' },
      { path: '/unified-linkup', label: 'Order Linkup' },
    ],
  },
  {
    key: 'profitability',
    label: 'Analytics',
    description: 'Sales, margins, and cash analysis',
    job: 'Analyze profitability after reconciliation is complete',
    path: '/profit-loss',
    paths: ['/profit-loss', '/profit-analysis', '/cash-flow', '/calculator'],
    tabs: [
      { path: '/profit-loss', label: 'P&L Summary' },
      { path: '/profit-analysis', label: 'SKU Profitability' },
      { path: '/cash-flow', label: 'Cash Flow' },
      { path: '/calculator', label: 'Fee Calculator' },
    ],
  },
  {
    key: 'data',
    label: 'Data & Setup',
    description: 'Uploads, accounts, and rate cards',
    job: 'Keep marketplace data and charge rules correct',
    path: '/upload',
    roles: OPS_ROLES,
    paths: ['/upload', '/rate-card-config'],
    tabs: [
      { path: '/upload', label: 'Uploads' },
      { path: '/rate-card-config', label: 'Rate Cards', roles: ['admin'] },
    ],
  },
];

export const ADMIN_WORKSPACE = {
  key: 'admin',
  label: 'Administration',
  description: 'Users and financial settings',
  job: 'Users, charges, audit',
  path: '/admin-center',
  paths: ['/admin-center', '/charges', '/audit-log', '/settings/amazon-fc'],
  tabs: [
    { path: '/admin-center', label: 'Users & System' },
    { path: '/charges', label: 'Charges' },
    { path: '/settings/amazon-fc', label: 'Amazon FCs' },
    { path: '/audit-log', label: 'Audit History' },
  ],
};

function pathMatches(pathname, path) {
  return path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`);
}

export function workspaceForPath(pathname, isAdmin = false) {
  const workspaces = isAdmin ? [...WORKSPACES, ADMIN_WORKSPACE] : WORKSPACES;
  return workspaces.find(workspace =>
    workspace.paths.some(path => pathMatches(pathname, path))
  ) || WORKSPACES[0];
}

export function canAccessWorkspace(workspace, role) {
  return !workspace.roles || workspace.roles.includes(role);
}

export function isWorkspaceActive(pathname, workspace) {
  return workspace.paths.some(path => pathMatches(pathname, path));
}

export function isTabActive(pathname, tab) {
  return [tab.path, ...(tab.aliases || [])].some(path => pathMatches(pathname, path));
}

export function canAccessTab(tab, role) {
  return !tab.roles || tab.roles.includes(role);
}
