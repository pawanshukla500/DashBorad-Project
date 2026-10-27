import { useState, useEffect } from 'react';
import { 
  fetchUsers, 
  createUser, 
  updateUserRole, 
  deleteUser, 
  fetchUploadStatus,
  fetchMarketplaceCredentialAccounts,
  updateMarketplaceAccount,
  saveMarketplaceAccount,
  revealMarketplacePassword
} from '../api/client';
import { Link } from 'react-router-dom';
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
        <p className="text-xs text-amber-600 mt-0.5">Add the Hostinger PostgreSQL DATABASE_URL to backend/.env and restart.</p>
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

// Default Marketplace Configurations with Brandfetch CDN official logos
const DEFAULT_MARKETPLACE_CONFIGS = [
  {
    key: 'flipkart',
    marketplace: 'flipkart',
    account_id: 'default',
    label: 'Flipkart',
    portal_url: 'https://seller.flipkart.com/',
    logo_url: 'https://cdn.brandfetch.io/idWdImNSUt/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177459816idZyD0yYjDWqQ88x6B',
    matches: type => type.startsWith('fk_') || ['orders', 'returns', 'settlements'].includes(type),
  },
  {
    key: 'amazon',
    marketplace: 'amazon',
    account_id: 'default',
    label: 'Amazon IN',
    portal_url: 'https://sellercentral.amazon.in/',
    logo_url: 'https://cdn.brandfetch.io/idomDO5Jzv/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177472711idZyD0yYjDdIjVoG73',
    matches: type => type.startsWith('amazon_'),
  },
  {
    key: 'myntra_vb',
    marketplace: 'myntra',
    account_id: 'myntra_vb',
    label: 'Myntra (VB)',
    seller_id: '10708',
    portal_url: 'https://partners.myntra.com/',
    logo_url: 'https://cdn.brandfetch.io/idDW82Qwj2/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177484037idZyD0yYjDtAenWdeL',
    matches: type => type === 'myntra_vb' || type.includes('10708') || (type.startsWith('myntra_') && !type.includes('ej') && !type.includes('45833')),
  },
  {
    key: 'myntra_ej',
    marketplace: 'myntra',
    account_id: 'myntra_ej',
    label: 'Myntra (EJ)',
    seller_id: '45833',
    portal_url: 'https://partners.myntra.com/',
    logo_url: 'https://cdn.brandfetch.io/idDW82Qwj2/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177484037idZyD0yYjDtAenWdeL',
    matches: type => type === 'myntra_ej' || type.includes('45833') || type.includes('ej'),
  },
  {
    key: 'ajio',
    marketplace: 'ajio',
    account_id: 'default',
    label: 'Reliance Retail (AJIO)',
    portal_url: 'https://supplier.ajio.com/',
    logo_url: 'https://cdn.brandfetch.io/idr5xgDFc2/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177490710idZyD0yYjDeHmQHVu1',
    matches: type => type.startsWith('ajio_') || type.startsWith('mp_invoices'),
  },
  {
    key: 'meesho',
    marketplace: 'meesho',
    account_id: 'default',
    label: 'Meesho',
    portal_url: 'https://supplier.meesho.com/',
    logo_url: 'https://cdn.brandfetch.io/idyeTDctmi/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177498057idZyD0yYjDdWnJrl50',
    matches: type => type.startsWith('meesho_'),
  },
  {
    key: 'cocoblu',
    marketplace: 'cocoblu',
    account_id: 'default',
    label: 'Cocoblu Retails',
    portal_url: 'https://cocoblu.biz/',
    logo_url: 'https://cdn.brandfetch.io/iduQ6iAglk/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177520125idZyD0yYjDnFplzDd_',
    matches: type => type.startsWith('cocoblu_') || type.startsWith('sor_cocoblu'),
  },
  {
    key: 'shopify',
    marketplace: 'shopify',
    account_id: 'default',
    label: 'Shopify',
    portal_url: 'https://admin.shopify.com/',
    logo_url: 'https://cdn.brandfetch.io/idAgPm7IvG/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177511905idZyD0yYjDkUgFPWU1',
    matches: type => type.startsWith('shopify_'),
  },
];

function latestUploadFor(lastUploads, matches) {
  let latest = null;
  for (const [type, uploadedAt] of Object.entries(lastUploads || {})) {
    if (!uploadedAt || !matches(type)) continue;
    const time = new Date(uploadedAt);
    if (!Number.isNaN(time.getTime()) && (!latest || time > latest)) latest = time;
  }
  return latest;
}

function formatUploadTime(date) {
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  const ago = minutes < 60 ? `${Math.max(minutes, 0)} min ago`
    : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago`
      : `${Math.round(minutes / 1440)} days ago`;
  return `${date.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} (${ago})`;
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

  const [activeTab, setActiveTab] = useState('marketplace');
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [emailNotifs, setEmailNotifs] = useState(true);
  const [twoFactor, setTwoFactor] = useState(true);
  const [weeklyReports, setWeeklyReports] = useState(false);

  // Marketplace accounts & credentials state
  const [marketplaceAccounts, setMarketplaceAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [modalLoginId, setModalLoginId] = useState('');
  const [modalPassword, setModalPassword] = useState('');
  const [modalSellerId, setModalSellerId] = useState('');
  const [modalDisplayName, setModalDisplayName] = useState('');
  const [modalPortalUrl, setModalPortalUrl] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [revealingPassword, setRevealingPassword] = useState(false);
  const [savingAccount, setSavingAccount] = useState(false);

  useEffect(() => {
    loadUsers();
    loadDbStatus();
    loadMarketplaceAccounts();
  }, []);

  const loadMarketplaceAccounts = async () => {
    setAccountsLoading(true);
    try {
      const res = await fetchMarketplaceCredentialAccounts();
      if (res?.accounts) {
        setMarketplaceAccounts(res.accounts);
      }
    } catch (err) {
      console.error('Failed to load marketplace accounts:', err);
    } finally {
      setAccountsLoading(false);
    }
  };

  const handleOpenAccountModal = (acc) => {
    setSelectedAccount(acc);
    setModalDisplayName(acc.display_name || acc.label || '');
    setModalLoginId(acc.login_id || '');
    setModalPassword('');
    setModalSellerId(acc.seller_id || '');
    setModalPortalUrl(acc.portal_url || '');
    setShowPassword(false);
    setEditModalOpen(true);
  };

  const handleToggleRevealPassword = async () => {
    if (showPassword) {
      setShowPassword(false);
      return;
    }
    if (selectedAccount?.id && !modalPassword && selectedAccount.has_password) {
      setRevealingPassword(true);
      setError('');
      try {
        const res = await revealMarketplacePassword(selectedAccount.id);
        if (res?.password) {
          setModalPassword(res.password);
          setShowPassword(true);
        } else {
          setError('Failed to retrieve decrypted credential.');
        }
      } catch (err) {
        console.error('Failed to reveal password:', err);
        setError('Failed to decrypt credential. Please ensure you have operator/admin privileges.');
      } finally {
        setRevealingPassword(false);
      }
    } else {
      setShowPassword(true);
    }
  };

  const handleSaveAccount = async (e) => {
    e.preventDefault();
    if (!selectedAccount) return;
    setSavingAccount(true);
    setError('');
    setSuccess('');
    try {
      const payload = {
        marketplace: selectedAccount.marketplace,
        account_id: selectedAccount.account_id,
        display_name: modalDisplayName,
        seller_id: modalSellerId,
        login_id: modalLoginId,
        portal_url: modalPortalUrl,
      };
      if (modalPassword !== '') {
        payload.password = modalPassword;
      }
      if (selectedAccount.id) {
        await updateMarketplaceAccount(selectedAccount.id, payload);
      } else {
        await saveMarketplaceAccount(payload);
      }
      setSuccess(`Marketplace credentials for ${modalDisplayName} updated successfully!`);
      setEditModalOpen(false);
      await loadMarketplaceAccounts();
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Failed to update credentials');
    } finally {
      setSavingAccount(false);
    }
  };

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
        className={`pb-3 border-b-2 font-sans font-medium shrink-0 transition-colors ${
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
        <h1 className="font-display text-headline-lg font-bold text-ink mb-1">Admin Settings</h1>
        <p className="font-sans text-body-md text-secondary">Manage users, organization profiles, and marketplace connections.</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border mb-8 gap-8 overflow-x-auto hide-scrollbar">
        <TabButton id="user" label="User Management" />
        <TabButton id="marketplace" label="Marketplace Data" />
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
              <h2 className="font-display text-headline-md font-bold text-ink">Team Members</h2>
              <p className="font-sans text-body-sm text-secondary mt-1">Manage who has access to your organization.</p>
            </div>
            <button 
              onClick={() => setShowInviteModal(true)}
              className="bg-primary hover:bg-primary-dark text-on-primary font-sans text-label-md py-2.5 px-4 rounded-DEFAULT transition-colors shadow-sm flex items-center gap-2 shrink-0"
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
                  <th className="px-6 py-4 text-right">Added</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-sm">
                {users.length > 0 ? users.map((u) => {
                  const isMe = Boolean(u.firebase_uid && u.firebase_uid === currentUser?.firebase_uid);
                  return (
                    <tr key={u.id} className="hover:bg-surface-container-lowest transition-colors">
                      <td className="px-6 py-4 flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-primary-container text-on-primary-container flex items-center justify-center font-bold text-xs">
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
                        {/* Only what the directory records: a Firebase login is linked or not.
                            Every row used to say "Active" and "Today"/"Yesterday". */}
                        {u.firebase_uid ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <span className="material-symbols-outlined text-[14px]">check_circle</span> Login linked
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-surface-container-low text-secondary border border-border">
                            Not signed in yet
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right text-secondary">
                        {u.created_at ? new Date(u.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
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

      {/* TAB: MARKETPLACE CONNECTIONS & CREDENTIALS */}
      {activeTab === 'marketplace' && (
        <section className="mb-8 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-headline-md font-bold text-ink mb-1">
                Marketplace Credentials Center
              </h2>
              <p className="text-body-sm text-secondary">
                Configure official seller portals, merchant IDs, and encrypted credentials (AES-256-GCM) for automated scrapers, rate cards, and financial reconciliations.
              </p>
            </div>
            <button
              onClick={() => loadMarketplaceAccounts()}
              disabled={accountsLoading}
              className="self-start sm:self-auto px-3.5 py-2 border border-border bg-surface hover:bg-surface-container rounded-lg text-xs font-semibold text-secondary hover:text-ink flex items-center gap-1.5 transition-colors"
            >
              <span className={`material-symbols-outlined text-sm ${accountsLoading ? 'animate-spin' : ''}`}>refresh</span>
              {accountsLoading ? 'Refreshing...' : 'Refresh Accounts'}
            </button>
          </div>

          {/* Core Invariant Banner */}
          <div className="bg-primary-container/40 border border-primary/20 rounded-xl p-4 flex items-start gap-3">
            <span className="material-symbols-outlined text-primary text-xl mt-0.5">verified_user</span>
            <div className="text-xs space-y-1">
              <p className="font-bold text-ink">
                Accounting & Channel Separation Standards:
              </p>
              <p className="text-secondary">
                • <strong className="text-ink">Myntra VB (Seller ID 10708)</strong> and <strong className="text-ink">Myntra EJ (Seller ID 45833)</strong> operate as completely segregated financial ledgers. Mismatched uploads are rejected automatically.
              </p>
              <p className="text-secondary">
                • Passwords are stored in PostgreSQL using <strong className="text-ink">AES-256-GCM authenticated encryption</strong> with unique initialization vectors (IVs). Plaintext credentials are never logged or exposed.
              </p>
            </div>
          </div>

          {/* Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {DEFAULT_MARKETPLACE_CONFIGS.map(def => {
              const live = marketplaceAccounts.find(
                a => a.marketplace === def.marketplace && a.account_id === def.account_id
              );
              const card = {
                ...def,
                ...(live || {}),
                display_name: live?.display_name || def.label,
                seller_id: live?.seller_id || def.seller_id || '',
                portal_url: live?.portal_url || def.portal_url,
                logo_url: live?.logo_url || def.logo_url,
              };

              const lastUpload = latestUploadFor(dbStatus?.lastUploads, def.matches);
              const isConfigured = Boolean(card.login_id && card.has_password);

              return (
                <div 
                  key={def.key} 
                  className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col justify-between"
                >
                  <div>
                    {/* Header: Logo + Status Badge */}
                    <div className="flex justify-between items-start mb-3">
                      <div className="w-12 h-12 rounded-xl bg-surface border border-border flex items-center justify-center p-2 shadow-xs">
                        <img 
                          src={card.logo_url} 
                          alt={card.display_name} 
                          className="w-full h-full object-contain"
                          onError={(e) => {
                            e.target.onerror = null;
                            e.target.style.display = 'none';
                            e.target.nextSibling.style.display = 'block';
                          }}
                        />
                        <span className="material-symbols-outlined text-outline hidden text-2xl">storefront</span>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        {isConfigured ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-bold tracking-wider uppercase">
                            <span className="material-symbols-outlined text-[12px]">lock</span> Configured
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-bold tracking-wider uppercase">
                            <span className="material-symbols-outlined text-[12px]">key</span> Setup Needed
                          </span>
                        )}
                        {lastUpload ? (
                          <span className="px-1.5 py-0.5 rounded bg-surface-container-low text-secondary border border-border text-[9px] font-semibold">
                            Data loaded
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {/* Title & Seller ID */}
                    <div className="mb-3">
                      <h3 className="font-bold text-ink text-base flex items-center gap-1.5">
                        {card.display_name}
                      </h3>
                      {card.seller_id ? (
                        <div className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-md bg-surface-container-low border border-border text-[11px] font-mono text-secondary">
                          <span className="text-outline text-[10px] font-sans">Seller ID:</span>
                          <span className="font-bold text-ink">{card.seller_id}</span>
                        </div>
                      ) : (
                        <p className="text-[11px] text-outline mt-1 italic">Seller ID: Not configured</p>
                      )}
                    </div>

                    {/* Credential summary box */}
                    <div className="bg-surface-container-lowest border border-border/80 rounded-lg p-2.5 space-y-1.5 mb-4 text-xs font-sans">
                      <div className="flex justify-between items-center">
                        <span className="text-secondary text-[11px]">Login ID:</span>
                        <span className="font-mono text-ink text-[11px] truncate max-w-[130px]">
                          {card.login_id || <span className="text-outline italic">Empty</span>}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-secondary text-[11px]">Password:</span>
                        <span className="font-mono text-ink text-[11px]">
                          {card.has_password ? '••••••••' : <span className="text-outline italic">Not set</span>}
                        </span>
                      </div>
                      <div className="flex justify-between items-center pt-1 border-t border-border/50 text-[10px] text-secondary">
                        <span>Latest Upload:</span>
                        <span>{lastUpload ? formatUploadTime(lastUpload) : 'None'}</span>
                      </div>
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="space-y-2 mt-auto pt-2 border-t border-border">
                    <button
                      onClick={() => handleOpenAccountModal(card)}
                      className="w-full py-2 bg-primary hover:bg-primary-dark text-on-primary rounded-lg font-semibold text-xs flex items-center justify-center gap-1.5 shadow-xs transition-colors"
                    >
                      <span className="material-symbols-outlined text-sm">tune</span>
                      Configure Credentials
                    </button>
                    <div className="flex gap-2">
                      <a
                        href={card.portal_url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex-1 py-1.5 border border-border rounded-lg text-xs font-medium text-secondary hover:text-ink hover:bg-surface-container text-center transition-colors flex items-center justify-center gap-1"
                      >
                        <span className="material-symbols-outlined text-xs">open_in_new</span>
                        Portal
                      </a>
                      <Link
                        to="/upload"
                        className="flex-1 py-1.5 border border-border rounded-lg text-xs font-medium text-secondary hover:text-ink hover:bg-surface-container text-center transition-colors flex items-center justify-center gap-1"
                      >
                        <span className="material-symbols-outlined text-xs">upload</span>
                        Uploads
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* TAB: ORGANIZATION PROFILE */}
      {activeTab === 'org' && (
        <section className="mb-8 max-w-2xl">
          <div className="bg-surface rounded-xl border border-border shadow-sm p-6">
            <h2 className="font-display text-headline-sm font-bold text-ink mb-4">Your Account Details</h2>
            <div className="flex items-center gap-4 mb-5">
              <div className="w-16 h-16 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-xl font-bold">
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
            <h2 className="font-display text-headline-md font-bold text-ink mb-4">System Settings</h2>
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
            <div className="bg-surface rounded-xl border border-border shadow-sm p-6 mb-8">
              <h2 className="font-display text-headline-sm font-bold text-ink mb-2">Change Password</h2>
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
            
            <h2 className="font-display text-headline-md font-bold text-ink mb-4">Database Health</h2>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 modal-backdrop">
          <div className="bg-surface rounded-xl border border-border shadow-lg w-full max-w-lg overflow-hidden animate-fade-in">
            <div className="p-6 border-b border-border flex items-center justify-between">
              <div>
                <h2 className="font-display text-headline-sm font-bold text-ink mb-1">Add Team Member</h2>
                <p className="font-sans text-body-sm text-secondary">Register a new team member.</p>
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
      {/* MODAL: EDIT MARKETPLACE CREDENTIALS */}
      {editModalOpen && selectedAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 backdrop-blur-xs p-4 animate-fade-in">
          <div className="bg-surface rounded-2xl max-w-lg w-full p-6 border border-border shadow-xl space-y-5 animate-scale-up">
            <div className="flex items-center justify-between pb-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-surface border border-border flex items-center justify-center p-1.5 shadow-xs">
                  <img
                    src={selectedAccount.logo_url}
                    alt={selectedAccount.display_name}
                    className="w-full h-full object-contain"
                    onError={(e) => { e.target.style.display = 'none'; }}
                  />
                </div>
                <div>
                  <h3 className="font-display text-lg font-bold text-ink">
                    Configure {selectedAccount.display_name}
                  </h3>
                  <p className="text-xs text-secondary">
                    Channel Key: <span className="font-mono text-ink font-semibold">{selectedAccount.marketplace}</span> • Account: <span className="font-mono text-ink font-semibold">{selectedAccount.account_id}</span>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditModalOpen(false)}
                className="text-secondary hover:text-ink rounded-lg p-1.5 hover:bg-surface-container transition-colors"
              >
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            {/* Invariant Note */}
            {selectedAccount.marketplace === 'myntra' && (
              <div className="bg-primary-container/30 border border-primary/20 rounded-xl p-3 text-xs flex items-start gap-2">
                <span className="material-symbols-outlined text-primary text-base shrink-0 mt-0.5">info</span>
                <div className="text-ink">
                  <strong className="text-primary font-bold">Strict Myntra Invariant:</strong>
                  {selectedAccount.account_id === 'myntra_vb' && (
                    <span> Seller ID is strictly locked to <strong className="text-primary font-mono font-bold">10708</strong> for Myntra VB per accounting guidelines.</span>
                  )}
                  {selectedAccount.account_id === 'myntra_ej' && (
                    <span> Seller ID is strictly locked to <strong className="text-primary font-mono font-bold">45833</strong> for Myntra EJ per accounting guidelines.</span>
                  )}
                </div>
              </div>
            )}

            <form onSubmit={handleSaveAccount} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-secondary uppercase mb-1.5">
                  Display Name
                </label>
                <input
                  type="text"
                  value={modalDisplayName}
                  onChange={(e) => setModalDisplayName(e.target.value)}
                  className="w-full px-3.5 py-2 bg-surface-container-low border border-border rounded-xl text-ink focus:outline-none focus:border-primary text-sm font-medium"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-secondary uppercase mb-1.5">
                  Seller / Merchant ID
                </label>
                <input
                  type="text"
                  value={modalSellerId}
                  onChange={(e) => setModalSellerId(e.target.value)}
                  readOnly={selectedAccount.marketplace === 'myntra'}
                  placeholder="e.g. 10708, A21TJ6UNN4Z098"
                  className={`w-full px-3.5 py-2 bg-surface-container-low border border-border rounded-xl text-ink focus:outline-none focus:border-primary text-sm font-mono ${
                    selectedAccount.marketplace === 'myntra' ? 'bg-surface-container opacity-80 cursor-not-allowed' : ''
                  }`}
                />
                {selectedAccount.marketplace === 'myntra' && (
                  <p className="text-[11px] text-outline mt-1">Locked per Myntra legal entity accounting policy.</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-secondary uppercase mb-1.5">
                  Login ID / Username / Email
                </label>
                <input
                  type="text"
                  value={modalLoginId}
                  onChange={(e) => setModalLoginId(e.target.value)}
                  placeholder="seller@vbexports.co.in"
                  className="w-full px-3.5 py-2 bg-surface-container-low border border-border rounded-xl text-ink focus:outline-none focus:border-primary text-sm font-medium"
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs font-semibold text-secondary uppercase">
                    Portal Password / Token
                  </label>
                  {selectedAccount.has_password && (
                    <button
                      type="button"
                      onClick={handleToggleRevealPassword}
                      disabled={revealingPassword}
                      className="text-xs text-primary font-semibold hover:underline flex items-center gap-1"
                    >
                      <span className="material-symbols-outlined text-[14px]">
                        {showPassword ? 'visibility_off' : 'visibility'}
                      </span>
                      {revealingPassword ? 'Decrypting...' : showPassword ? 'Hide Password' : 'Show Current Password'}
                    </button>
                  )}
                </div>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={modalPassword}
                    onChange={(e) => setModalPassword(e.target.value)}
                    placeholder={selectedAccount.has_password ? 'Leave empty to keep existing encrypted password' : 'Enter portal password'}
                    className="w-full px-3.5 py-2 bg-surface-container-low border border-border rounded-xl text-ink focus:outline-none focus:border-primary text-sm font-mono"
                  />
                </div>
                <p className="text-[11px] text-outline mt-1">
                  Stored securely using AES-256-GCM with distinct IVs. Never exposed in logs.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-secondary uppercase mb-1.5">
                  Seller Portal URL
                </label>
                <input
                  type="url"
                  value={modalPortalUrl}
                  onChange={(e) => setModalPortalUrl(e.target.value)}
                  placeholder="https://sellercentral.amazon.in/"
                  className="w-full px-3.5 py-2 bg-surface-container-low border border-border rounded-xl text-ink focus:outline-none focus:border-primary text-sm font-medium"
                />
              </div>

              <div className="pt-4 flex justify-end gap-3 border-t border-border">
                <button
                  type="button"
                  onClick={() => setEditModalOpen(false)}
                  className="py-2.5 px-5 hover:bg-surface-container text-secondary rounded-xl font-semibold text-sm transition-colors border border-border"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingAccount}
                  className="py-2.5 px-5 bg-primary hover:bg-primary-dark disabled:opacity-50 text-on-primary rounded-xl font-semibold text-sm shadow-sm transition-colors flex items-center gap-2"
                >
                  <span className="material-symbols-outlined text-sm">lock</span>
                  {savingAccount ? 'Encrypting & Saving...' : 'Save Credentials'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
