import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { auth, sendPasswordResetEmail } from '../api/firebase';
import { formatAuthError } from '../utils/authErrors';

const REMEMBER_EMAIL_KEY = 'vb_remember_email';


function Alert({ children, tone = 'error', id }) {
  const success = tone === 'success';
  return (
    <div
      id={id}
      role={success ? 'status' : 'alert'}
      className={`mb-4 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm ${
        success
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-rose-200 bg-rose-50 text-rose-700 animate-shake'
      }`}
    >
      <span className="material-symbols-outlined mt-0.5 shrink-0 text-[18px]" aria-hidden="true">
        {success ? 'check_circle' : 'error'}
      </span>
      <span className="font-medium leading-5">{children}</span>
    </div>
  );
}

function SubmitButton({ loading, children, loadingLabel }) {
  return (
    <button
      type="submit"
      disabled={loading}
      aria-busy={loading}
      className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 font-sans text-body-md font-semibold text-on-primary transition-colors hover:bg-indigo-dark disabled:cursor-wait disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2"
    >
      {loading ? (
        <>
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" />
          {loadingLabel}
        </>
      ) : (
        <>
          {children}
        </>
      )}
    </button>
  );
}

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState(() => localStorage.getItem(REMEMBER_EMAIL_KEY) || '');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(() => !!localStorage.getItem(REMEMBER_EMAIL_KEY));
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetSuccess, setResetSuccess] = useState('');
  const [resetLoading, setResetLoading] = useState(false);

  const handleSubmit = async event => {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter your work email and password.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await login(email.trim(), password);
      if (rememberMe) localStorage.setItem(REMEMBER_EMAIL_KEY, email.trim());
      else localStorage.removeItem(REMEMBER_EMAIL_KEY);
    } catch (err) {
      setError(err.message || 'Authentication failed. Please verify your credentials.');
    } finally {
      setLoading(false);
    }
  };

  const openPasswordReset = () => {
    setResetEmail(email.trim());
    setError('');
    setResetSuccess('');
    setIsForgotPassword(true);
  };

  const handleForgotPasswordSubmit = async event => {
    event.preventDefault();
    if (!resetEmail.trim()) {
      setError('Enter your work email.');
      return;
    }
    setError('');
    setResetSuccess('');
    setResetLoading(true);
    try {
      await sendPasswordResetEmail(auth, resetEmail.trim());
      setResetSuccess('Recovery instructions were sent. Check your inbox to continue.');
    } catch (err) {
      setError(formatAuthError(err));
    } finally {
      setResetLoading(false);
    }
  };

  const returnToSignIn = () => {
    setIsForgotPassword(false);
    setError('');
    setResetSuccess('');
  };

  return (
    <div className="bg-canvas text-on-surface min-h-screen flex font-sans selection:bg-primary-container selection:text-on-primary">
      <div className="flex w-full min-h-screen">
        
        <div className="hidden lg:flex w-[45%] bg-primary-container flex-col justify-between p-12 lg:p-16 relative overflow-hidden">
          <div className="z-10 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-white p-1 flex items-center justify-center shadow-sm">
              <img src="/logo.png" alt="ReconCentral Logo" className="h-7 w-7 object-contain" />
            </div>
            <span className="font-display text-headline-md font-semibold text-on-primary">ReconCentral</span>
          </div>
          <div className="z-10 mt-auto pb-12">
            <div className="mb-10 max-w-md rounded-xl border border-white/15 bg-white/10 p-4 text-on-primary shadow-2xl backdrop-blur" aria-hidden="true">
              <div className="flex items-center justify-between border-b border-white/15 pb-3">
                <span className="text-xs font-semibold text-on-primary-container">September payout</span>
                <span className="rounded-full bg-emerald-400/20 px-2 py-0.5 text-[11px] font-semibold text-emerald-100">Live</span>
              </div>
              <div className="grid grid-cols-2 gap-4 py-4">
                <div>
                  <p className="text-[11px] text-on-primary-container">Net received</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">₹28.4L</p>
                </div>
                <div>
                  <p className="text-[11px] text-on-primary-container">Open exceptions</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">17</p>
                </div>
              </div>
              <div className="space-y-2">
                {[72, 48, 84, 62].map((width, index) => (
                  <div key={index} className="h-2 rounded-full bg-white/10">
                    <div className="h-2 rounded-full bg-white" style={{ width: `${width}%` }} />
                  </div>
                ))}
              </div>
            </div>
            <h1 className="font-display text-display-lg text-on-primary mb-4 max-w-md">Every payout, clearly accounted for.</h1>
            <p className="font-sans text-body-lg text-on-primary-container mb-10 max-w-md opacity-90">
                The financial control room designed specifically for Indian marketplace sellers. Take command of your cash flow with absolute precision.
            </p>
            <ul className="space-y-4">
              <li className="flex items-start gap-3">
                <div className="bg-white/10 rounded-full p-1 mt-0.5">
                  <span className="material-symbols-outlined text-on-primary text-sm" aria-hidden="true">check</span>
                </div>
                <span className="font-sans text-body-md text-on-primary opacity-90">Multi-marketplace visibility</span>
              </li>
              <li className="flex items-start gap-3">
                <div className="bg-white/10 rounded-full p-1 mt-0.5">
                  <span className="material-symbols-outlined text-on-primary text-sm" aria-hidden="true">check</span>
                </div>
                <span className="font-sans text-body-md text-on-primary opacity-90">Faster reconciliation</span>
              </li>
              <li className="flex items-start gap-3">
                <div className="bg-white/10 rounded-full p-1 mt-0.5">
                  <span className="material-symbols-outlined text-on-primary text-sm" aria-hidden="true">check</span>
                </div>
                <span className="font-sans text-body-md text-on-primary opacity-90">Profit clarity</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="w-full lg:w-[55%] flex flex-col justify-center items-center p-6 sm:p-12 bg-surface">
          <div className="lg:hidden flex items-center gap-2.5 mb-12 self-start w-full max-w-[440px] mx-auto">
            <img src="/logo.png" alt="ReconCentral Logo" className="h-8 w-8 object-contain" />
            <span className="font-display text-headline-md font-semibold text-ink">ReconCentral</span>
          </div>

          <div className="w-full max-w-[440px]">
            {!isForgotPassword ? (
              <>
                <div className="mb-10">
                  <h2 className="font-display text-headline-lg text-ink mb-2">Welcome back</h2>
                  <p className="font-sans text-body-md text-secondary">Sign in to continue to your dashboard.</p>
                </div>

                {error && <Alert id="login-error">{error}</Alert>}

                <form onSubmit={handleSubmit} className="space-y-6">
                  <div className="space-y-2">
                    <label className="block font-sans text-body-sm font-medium text-ink" htmlFor="email">Work email</label>
                    <input
                      className="w-full px-4 py-3 rounded-DEFAULT border border-border bg-surface text-ink focus:border-primary focus:ring-2 focus:ring-primary/20 transition-shadow outline-none placeholder-outline-variant font-sans"
                      id="email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={event => setEmail(event.target.value)}
                      placeholder="name@company.com"
                      aria-invalid={!!error}
                      aria-describedby={error ? 'login-error' : undefined}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="block font-sans text-body-sm font-medium text-ink" htmlFor="password">Password</label>
                      <button type="button" onClick={openPasswordReset} className="rounded-md font-sans text-body-sm font-medium text-primary transition-colors hover:text-indigo-dark focus-visible:ring-2 focus-visible:ring-primary/40">
                        Forgot password?
                      </button>
                    </div>
                    <div className="relative">
                      <input
                        className="w-full px-4 py-3 pr-10 rounded-DEFAULT border border-border bg-surface text-ink focus:border-primary focus:ring-2 focus:ring-primary/20 transition-shadow outline-none placeholder-outline-variant font-sans"
                        id="password"
                        name="password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        value={password}
                        onChange={event => setPassword(event.target.value)}
                        placeholder="••••••••"
                        aria-invalid={!!error}
                        aria-describedby={error ? 'login-error' : undefined}
                        required
                      />
                      <button
                        className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-md text-outline transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40"
                        type="button"
                        onClick={() => setShowPassword(value => !value)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        aria-pressed={showPassword}
                      >
                        <span className="material-symbols-outlined text-xl" aria-hidden="true">{showPassword ? 'visibility_off' : 'visibility'}</span>
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      className="w-4 h-4 rounded border-border text-primary focus:ring-primary/20 cursor-pointer"
                      id="remember"
                      type="checkbox"
                      checked={rememberMe}
                      onChange={event => setRememberMe(event.target.checked)}
                    />
                    <label className="font-sans text-body-sm text-secondary cursor-pointer select-none" htmlFor="remember">Remember me</label>
                  </div>

                  <div className="pt-2">
                    <SubmitButton loading={loading} loadingLabel="Signing in…">Sign in</SubmitButton>
                  </div>
                </form>
              </>
            ) : (
              <>
                <button type="button" onClick={returnToSignIn} className="mb-6 inline-flex items-center gap-2 rounded-md font-sans text-body-sm font-medium text-secondary hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40">
                  <span className="material-symbols-outlined text-[18px]" aria-hidden="true">arrow_back</span>
                  Back to sign in
                </button>

                <div className="mb-10">
                  <h2 className="font-display text-headline-lg text-ink mb-2">Reset password</h2>
                  <p className="font-sans text-body-md text-secondary">We’ll send recovery instructions to your work email.</p>
                </div>

                {error && <Alert id="reset-error">{error}</Alert>}
                {resetSuccess && <Alert tone="success">{resetSuccess}</Alert>}

                <form onSubmit={handleForgotPasswordSubmit} className="space-y-6">
                  <div className="space-y-2">
                    <label className="block font-sans text-body-sm font-medium text-ink" htmlFor="reset-email">Work email</label>
                    <input
                      className="w-full px-4 py-3 rounded-DEFAULT border border-border bg-surface text-ink focus:border-primary focus:ring-2 focus:ring-primary/20 transition-shadow outline-none placeholder-outline-variant font-sans"
                      id="reset-email"
                      name="reset-email"
                      type="email"
                      autoComplete="email"
                      value={resetEmail}
                      onChange={event => setResetEmail(event.target.value)}
                      placeholder="name@company.com"
                      aria-invalid={!!error}
                      aria-describedby={error ? 'reset-error' : undefined}
                      required
                    />
                  </div>
                  <div className="pt-2">
                    <SubmitButton loading={resetLoading} loadingLabel="Sending…">Send recovery link</SubmitButton>
                  </div>
                </form>
              </>
            )}

            <div className="mt-12 text-center flex flex-col sm:flex-row items-center justify-center gap-2 font-sans text-body-sm text-outline">
              <div className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm" aria-hidden="true">lock</span>
                <span>Your financial data is encrypted and protected.</span>
              </div>
              <span className="hidden sm:inline text-border">•</span>
              <a className="rounded-md text-primary transition-colors hover:text-indigo-dark font-medium focus-visible:ring-2 focus-visible:ring-primary/40" href="mailto:payments@youthnic.shop">Contact support</a>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
