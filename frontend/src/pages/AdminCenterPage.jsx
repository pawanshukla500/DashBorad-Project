import { useState, useEffect } from 'react';
import { fetchUsers, createUser, updateUserRole, deleteUser, fetchUploadStatus } from '../api/client';
import { useAuth } from '../context/AuthContext';

// ── DB Banner Component ────────────────────────────────────────────────────────
function DbBanner({ configured, dbConnected, counts, lastUploads, fkSettlementPeriod }) {
  const fmtDate = (v) => {
    if (!v) return null;
    return new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  };
  const fmtMon = (v) => {
    if (!v) return null;
    return new Date(v).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  };

  if (!configured) return (
    <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-5 py-4">
      <span className="text-xl">⚠️</span>
      <div>
        <p className="text-sm font-semibold text-amber-800">Database not configured</p>
        <p className="text-xs text-amber-600 mt-0.5">Add PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD to backend/.env and restart.</p>
      </div>
    </div>
  );

  if (dbConnected === false) return (
    <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl px-5 py-4">
      <span className="text-xl">⚠️</span>
      <div>
        <p className="text-sm font-semibold text-red-800">Database offline (ECONNREFUSED)</p>
        <p className="text-xs text-red-600 mt-0.5">The PostgreSQL server configured in .env is unreachable. Please check the connection.</p>
      </div>
    </div>
  );

  const types = [
    { key: 'orders',             logKey: 'orders',                label: 'Orders (FK)',        count: counts?.orders },
    { key: 'returns',            logKey: 'returns',               label: 'Returns (FK)',       count: counts?.returns },
    { key: 'fk-settlement',      logKey: 'fk_settlement_orders',  label: 'FK Settlement',      count: counts?.fk_settlement_orders },
    { key: 'amazon-sale-orders', logKey: 'amazon_sale_orders', label: 'Amazon Sale Orders', count: counts?.amazon_orders },
    { key: 'amazon-fba-returns',   logKey: 'amazon_fba_returns',   label: 'Amazon FBA Ret.',    count: counts?.amazon_fba_returns },
    { key: 'amazon-flex-returns',  logKey: 'amazon_flex_returns',  label: 'Amazon Flex Ret.',   count: counts?.amazon_flex_returns },
    { key: 'amazon-settlement',    logKey: 'amazon_settlement',    label: 'Amazon Settlement',  count: counts?.amazon_settlement_lines },
  ];

  return (
    <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-4 w-full">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm font-semibold text-emerald-800">PostgreSQL connected</span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {types.map(({ key, logKey, label, count }) => {
          const lastUp = lastUploads?.[logKey] || lastUploads?.[key];
          const isFK   = key === 'fk-settlement';
          const fkPeriodStr = isFK && fkSettlementPeriod?.period_start
            ? `${fmtMon(fkSettlementPeriod.period_start)} → ${fmtMon(fkSettlementPeriod.period_end)}`
            : null;
          return (
            <div key={key} className="bg-surface rounded-xl border border-emerald-100 px-3 py-2.5">
              <p className="text-[10px] font-semibold text-secondary uppercase tracking-widest">{label}</p>
              <p className="text-lg font-bold text-ink mt-0.5">{(count || 0).toLocaleString()}</p>
              {fkPeriodStr && (
                <p className="text-[10px] text-primary font-semibold mt-0.5">{fkPeriodStr}</p>
              )}
              {lastUp
                ? <p className="text-[10px] text-outline mt-0.5">Last upload: {fmtDate(lastUp)}</p>
                : <p className="text-[10px] text-outline mt-0.5">Not uploaded yet</p>
              }
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function AdminCenterPage() {
  const { user: currentUser, changePassword } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Form states
  const [newUsername, setNewUsername] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('viewer');
  const [createLoading, setCreateLoading] = useState(false);

  // Self password change state
  const [selfNewPassword, setSelfNewPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);

  // System status state
  const [dbStatus, setDbStatus] = useState(null);

  const [activeTab, setActiveTab] = useState('user');
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [emailNotifs, setEmailNotifs] = useState(true);
  const [twoFactor, setTwoFactor] = useState(true);
  const [weeklyReports, setWeeklyReports] = useState(false);

  useEffect(() => {
    loadUsers();
    loadDbStatus();
  }, []);

  const loadDbStatus = async () => {
    try { 
      const d = await fetchUploadStatus(); 
      setDbStatus(d); 
    } catch { 
      setDbStatus({ configured: false, logs: [], counts: {} }); 
    }
  };

  const loadUsers = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchUsers();
      setUsers(data);
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Failed to fetch users');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateUser = async (e) => {
    e.preventDefault();
    if (!newUsername || !newEmail || !newPassword || !newRole) {
      setError('Please fill in all required fields');
      return;
    }

    setCreateLoading(true);
    setError('');
    setSuccess('');

    try {
      await createUser({
        username: newUsername,
        email: newEmail,
        password: newPassword,
        role: newRole,
      });

      setSuccess(`User "${newUsername}" created successfully!`);
      setNewUsername('');
      setNewEmail('');
      setNewPassword('');
      setNewRole('viewer');
      setShowInviteModal(false);
      loadUsers(); // Reload table
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Failed to create user');
    } finally {
      setCreateLoading(false);
    }
  };

  const handleRoleChange = async (targetUser, role) => {
    if (targetUser.firebase_uid && targetUser.firebase_uid === currentUser.firebase_uid) {
      setError('You cannot modify your own administrator role.');
      return;
    }

    setError('');
    setSuccess('');
    try {
      await updateUserRole(targetUser.id, role);
      setSuccess(`Updated role for ${targetUser.username} to ${role}`);
      loadUsers();
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Failed to update user role');
    }
  };

  const handleDeleteUser = async (targetUser) => {
    if (targetUser.firebase_uid && targetUser.firebase_uid === currentUser.firebase_uid) {
      setError('You cannot delete your own account.');
      return;
    }

    if (!window.confirm(`Are you sure you want to permanently delete user "${targetUser.username}"?`)) {
      return;
    }

    setError('');
    setSuccess('');

    try {
      await deleteUser(targetUser.id);
      setSuccess(`User "${targetUser.username}" has been deleted.`);
      loadUsers();
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Failed to delete user');
    }
  };

  const handleSelfPasswordChange = async (e) => {
    e.preventDefault();
    if (!selfNewPassword || selfNewPassword.length < 6) {
      setError('Password must be at least 6 characters long');
      return;
    }

    setPasswordLoading(true);
    setError('');
    setSuccess('');

    try {
      await changePassword(selfNewPassword);
      setSuccess('Your Firebase password has been successfully updated.');
      setSelfNewPassword('');
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Failed to update password');
    } finally {
      setPasswordLoading(false);
    }
  };

  const TabButton = ({ id, label }) => {
    const active = activeTab === id;
    return (
      <button
        onClick={() => setActiveTab(id)}
        className={`pb-3 border-b-2 font-body-md font-medium shrink-0 transition-colors ${
          active ? 'border-primary text-primary font-bold' : 'border-transparent text-secondary hover:text-ink'
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-fade-in p-4 sm:p-6 lg:p-8 relative">
      {/* Page Header */}
      <div>
        <h1 className="font-headline-lg text-headline-lg font-bold text-ink mb-1">Admin Settings</h1>
        <p className="font-body-md text-body-md text-secondary">Manage users, organization profiles, and marketplace connections.</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border mb-8 gap-8 overflow-x-auto hide-scrollbar">
        <TabButton id="user" label="User Management" />
        <TabButton id="marketplace" label="Marketplace Connections" />
        <TabButton id="org" label="Organization Profile" />
        <TabButton id="security" label="Security & Audit" />
      </div>

      {/* Notifications */}
      {error && (
        <div className="flex gap-2.5 items-start bg-danger/10 border border-danger/20 text-danger text-sm rounded-xl p-4 mb-4">
          <span className="material-symbols-outlined shrink-0">error</span>
          <div>{error}</div>
        </div>
      )}
      {success && (
        <div className="flex gap-2.5 items-start bg-primary-fixed/20 border border-primary-fixed/40 text-primary font-medium text-sm rounded-xl p-4 mb-4">
          <span className="material-symbols-outlined shrink-0">check_circle</span>
          <div>{success}</div>
        </div>
      )}
      
      {/* DB Warning if not configured */}
      {dbStatus?.configured === false && (
        <div className="mb-6">
          <DbBanner configured={false} />
        </div>
      )}

      {/* TAB: USER MANAGEMENT */}
      {activeTab === 'user' && (
        <section className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden mb-8">
          <div className="p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="font-headline-md text-headline-md font-bold text-ink">Team Members</h2>
              <p className="font-body-sm text-body-sm text-secondary mt-1">Manage who has access to your organization.</p>
            </div>
            <button 
              onClick={() => setShowInviteModal(true)}
              className="bg-primary hover:bg-primary-dark text-on-primary font-label-md text-label-md py-2.5 px-4 rounded-DEFAULT transition-colors shadow-sm flex items-center gap-2 shrink-0"
            >
              <span className="material-symbols-outlined text-sm">add</span>
              Invite User
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-y border-border bg-surface-container-lowest text-[12px] font-bold text-secondary uppercase tracking-wider">
                  <th className="px-6 py-4">Name</th>
                  <th className="px-6 py-4">Email</th>
                  <th className="px-6 py-4">Role</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4 text-right">Last Login</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-sm">
                {users.length > 0 ? users.map((u) => {
                  const isMe = Boolean(u.firebase_uid && u.firebase_uid === currentUser?.firebase_uid);
                  return (
                    <tr key={u.id} className="hover:bg-surface-container-lowest transition-colors">
                      <td className="px-6 py-4 flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-primary-container text-on-primary flex items-center justify-center font-bold text-xs">
                          {u.username?.charAt(0).toUpperCase()}
                        </div>
                        <span className="font-semibold text-ink">
                          {u.username} {isMe && <span className="ml-1 text-[10px] text-outline font-normal">(You)</span>}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-secondary">{u.email}</td>
                      <td className="px-6 py-4">
                        <select
                          value={u.role === 'user' ? 'operator' : u.role}
                          onChange={event => handleRoleChange(u, event.target.value)}
                          disabled={isMe}
                          className="rounded border border-border bg-transparent px-2 py-1 text-sm font-medium text-ink focus:outline-none focus:border-primary disabled:opacity-50"
                        >
                          <option value="viewer">Viewer</option>
                          <option value="analyst">Analyst</option>
                          <option value="operator">Operator</option>
                          <option value="admin">Owner</option>
                        </select>
                      </td>
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <span className="material-symbols-outlined text-[14px]">check_circle</span> Active
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right text-secondary">
                        {isMe ? 'Today' : 'Yesterday'}
                      </td>
                    </tr>
                  );
                }) : (
                  <tr>
                    <td colSpan="5" className="px-6 py-12 text-center text-outline">
                      {loading ? 'Loading team members...' : 'No team members found.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TAB: MARKETPLACE CONNECTIONS */}
      {activeTab === 'marketplace' && (
        <section className="mb-8">
          <h2 className="font-headline-md text-headline-md font-bold text-ink mb-4">Marketplace Connections</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            
            {/* Amazon */}
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm flex flex-col">
              <div className="flex justify-between items-start mb-4">
                <div className="w-10 h-10 rounded bg-surface-container-low border border-border flex items-center justify-center">
                  <span className="material-symbols-outlined text-outline">shopping_bag</span>
                </div>
                <span className="px-2 py-0.5 rounded-sm bg-emerald-50 text-emerald-600 border border-emerald-100 text-[10px] font-bold tracking-wider uppercase">Connected</span>
              </div>
              <h3 className="font-bold text-ink">Amazon IN</h3>
              <p className="text-xs text-secondary mt-1 mb-5">Last sync: 10 mins ago</p>
              <button className="mt-auto w-full py-2 border border-border rounded font-bold text-sm text-secondary hover:text-ink hover:bg-surface-container transition-colors">Configure</button>
            </div>

            {/* Flipkart */}
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm flex flex-col">
              <div className="flex justify-between items-start mb-4">
                <div className="w-10 h-10 rounded bg-surface-container-low border border-border flex items-center justify-center">
                  <span className="material-symbols-outlined text-outline">shopping_bag</span>
                </div>
                <span className="px-2 py-0.5 rounded-sm bg-emerald-50 text-emerald-600 border border-emerald-100 text-[10px] font-bold tracking-wider uppercase">Connected</span>
              </div>
              <h3 className="font-bold text-ink">Flipkart</h3>
              <p className="text-xs text-secondary mt-1 mb-5">Last sync: 45 mins ago</p>
              <button className="mt-auto w-full py-2 border border-border rounded font-bold text-sm text-secondary hover:text-ink hover:bg-surface-container transition-colors">Configure</button>
            </div>

            {/* Myntra */}
            <div className="bg-[#FFF8F3] border border-[#FDBA74] rounded-xl p-5 shadow-sm flex flex-col">
              <div className="flex justify-between items-start mb-4">
                <div className="w-10 h-10 rounded bg-surface border border-[#FDBA74] flex items-center justify-center">
                  <span className="material-symbols-outlined text-[#F97316]">checkroom</span>
                </div>
                <span className="px-2 py-0.5 rounded-sm bg-[#FFEDD5] text-[#C2410C] border border-[#FDBA74] text-[10px] font-bold tracking-wider uppercase">Auth Req</span>
              </div>
              <h3 className="font-bold text-ink">Myntra</h3>
              <p className="text-xs text-[#C2410C] mt-1 mb-5">Token expired. Please re-auth.</p>
              <button className="mt-auto w-full py-2 bg-[#EA580C] text-white rounded font-bold text-sm hover:bg-[#C2410C] transition-colors">Re-authenticate</button>
            </div>

            {/* Meesho */}
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm flex flex-col opacity-75">
              <div className="flex justify-between items-start mb-4">
                <div className="w-10 h-10 rounded bg-surface-container-low border border-border flex items-center justify-center">
                  <span className="material-symbols-outlined text-outline">storefront</span>
                </div>
              </div>
              <h3 className="font-bold text-ink">Meesho</h3>
              <p className="text-xs text-secondary mt-1 mb-5">Not connected</p>
              <button className="mt-auto w-full py-2 bg-secondary text-white rounded font-bold text-sm hover:bg-primary transition-colors">Connect</button>
            </div>
          </div>
        </section>
      )}

      {/* TAB: ORGANIZATION PROFILE */}
      {activeTab === 'org' && (
        <section className="mb-8 max-w-2xl">
          <div className="bg-surface rounded-2xl border border-border shadow-sm p-6">
            <h2 className="font-headline-sm text-headline-sm font-bold text-ink mb-4">Your Account Details</h2>
            <div className="flex items-center gap-4 mb-5">
              <div className="w-16 h-16 rounded-full bg-primary-container flex items-center justify-center text-on-primary text-xl font-bold">
                {currentUser?.username?.charAt(0) || 'U'}
              </div>
              <div>
                <div className="font-bold text-ink text-lg">{currentUser?.username || 'User'}</div>
                <div className="text-secondary">{currentUser?.email}</div>
              </div>
            </div>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-primary-container border border-primary/20 rounded-full text-primary text-xs font-semibold capitalize">
              Role: {currentUser?.role || 'user'}
            </div>
          </div>
        </section>
      )}

      {/* TAB: SECURITY & AUDIT */}
      {activeTab === 'security' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <section>
            <h2 className="font-headline-md text-headline-md font-bold text-ink mb-4">System Settings</h2>
            <div className="bg-surface border border-border rounded-xl shadow-sm divide-y divide-border">
              <div className="p-6 flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-ink text-sm">Email Notifications</h3>
                  <p className="text-secondary text-xs mt-1">Receive daily digests and critical alerts via email.</p>
                </div>
                <button 
                  onClick={() => setEmailNotifs(!emailNotifs)}
                  className={`w-10 h-6 rounded-full relative transition-colors ${emailNotifs ? 'bg-primary' : 'bg-surface-container-high'}`}
                >
                  <span className={`absolute top-1 bg-surface w-4 h-4 rounded-full transition-all shadow-sm ${emailNotifs ? 'right-1' : 'left-1'}`}></span>
                </button>
              </div>
              <div className="p-6 flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-ink text-sm">Two-Factor Authentication (2FA)</h3>
                  <p className="text-secondary text-xs mt-1">Require a second form of authentication for all users.</p>
                </div>
                <button 
                  onClick={() => setTwoFactor(!twoFactor)}
                  className={`w-10 h-6 rounded-full relative transition-colors ${twoFactor ? 'bg-primary' : 'bg-surface-container-high'}`}
                >
                  <span className={`absolute top-1 bg-surface w-4 h-4 rounded-full transition-all shadow-sm ${twoFactor ? 'right-1' : 'left-1'}`}></span>
                </button>
              </div>
              <div className="p-6 flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-ink text-sm">Weekly Financial Reports</h3>
                  <p className="text-secondary text-xs mt-1">Automatically generate and email weekly P&L reports.</p>
                </div>
                <button 
                  onClick={() => setWeeklyReports(!weeklyReports)}
                  className={`w-10 h-6 rounded-full relative transition-colors ${weeklyReports ? 'bg-primary' : 'bg-surface-container-high'}`}
                >
                  <span className={`absolute top-1 bg-surface w-4 h-4 rounded-full transition-all shadow-sm ${weeklyReports ? 'right-1' : 'left-1'}`}></span>
                </button>
              </div>
            </div>
          </section>

          <section>
            <div className="bg-surface rounded-2xl border border-border shadow-sm p-6 mb-8">
              <h2 className="font-headline-sm text-headline-sm font-bold text-ink mb-2">Change Password</h2>
              <p className="text-xs text-secondary mb-4">Update your login security credentials. Changes sync in local database and Firebase Auth.</p>
              
              <form onSubmit={handleSelfPasswordChange} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-secondary uppercase mb-2">New Secure Password</label>
                  <input
                    type="password"
                    value={selfNewPassword}
                    onChange={(e) => setSelfNewPassword(e.target.value)}
                    placeholder="At least 6 characters"
                    className="w-full px-3.5 py-2.5 bg-surface-container-low border border-border rounded-xl text-ink focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 text-sm transition-all"
                    required
                  />
                </div>
                <button
                  type="submit"
                  disabled={passwordLoading}
                  className="w-full py-2.5 px-4 bg-ink hover:bg-ink/90 disabled:opacity-50 text-surface rounded-xl font-medium text-sm transition-colors flex items-center justify-center gap-2"
                >
                  {passwordLoading ? 'Updating...' : 'Update Password'}
                </button>
              </form>
            </div>
            
            <h2 className="font-headline-md text-headline-md font-bold text-ink mb-4">Database Health</h2>
            <DbBanner 
              configured={dbStatus?.configured} 
              dbConnected={dbStatus?.dbConnected}
              counts={dbStatus?.counts} 
              lastUploads={dbStatus?.lastUploads}
              fkSettlementPeriod={dbStatus?.fkSettlementPeriod}
            />
          </section>
        </div>
      )}

      {/* Invite User Modal */}
      {showInviteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/50 backdrop-blur-sm">
          <div className="bg-surface rounded-2xl border border-border shadow-lg w-full max-w-lg overflow-hidden animate-fade-in">
            <div className="p-6 border-b border-border flex items-center justify-between">
              <div>
                <h2 className="font-headline-sm text-headline-sm font-bold text-ink mb-1">Add Team Member</h2>
                <p className="font-body-sm text-body-sm text-secondary">Register a new team member.</p>
              </div>
              <button onClick={() => setShowInviteModal(false)} className="text-outline hover:text-ink">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <form onSubmit={handleCreateUser} className="p-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-secondary uppercase mb-1.5">Full Name</label>
                  <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="E.g. Pawan Shukla"
                    className="w-full px-3.5 py-2 bg-surface-container-low border border-border rounded-xl text-ink focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 text-sm transition-all"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-secondary uppercase mb-1.5">Email Address</label>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="user@example.com"
                    className="w-full px-3.5 py-2 bg-surface-container-low border border-border rounded-xl text-ink focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 text-sm transition-all"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-secondary uppercase mb-1.5">Initial Password</label>
                  <input
                    type="text"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Minimum 8 characters"
                    minLength={8}
                    required
                    className="w-full px-3.5 py-2 bg-surface-container-low border border-border rounded-xl text-ink focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 text-sm transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-secondary uppercase mb-1.5">Permission Role</label>
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value)}
                    className="w-full px-3.5 py-2 bg-surface-container-low border border-border rounded-xl text-ink focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 text-sm transition-all"
                  >
                    <option value="viewer">Viewer (Read only)</option>
                    <option value="analyst">Analyst (Reports and exports)</option>
                    <option value="operator">Operator (Uploads and operations)</option>
                    <option value="admin">Administrator (Configuration and users)</option>
                  </select>
                </div>
              </div>
              <div className="pt-4 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowInviteModal(false)}
                  className="py-2.5 px-5 hover:bg-surface-container-low text-secondary rounded-xl font-semibold text-sm transition-colors border border-border"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createLoading}
                  className="py-2.5 px-5 bg-primary hover:bg-primary/90 disabled:opacity-50 text-surface rounded-xl font-semibold text-sm shadow-sm transition-colors"
                >
                  {createLoading ? 'Registering...' : 'Invite Member'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
