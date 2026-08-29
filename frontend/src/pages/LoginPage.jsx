import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { auth, sendPasswordResetEmail } from '../api/firebase';
import { formatAuthError } from '../utils/authErrors';

const REMEMBER_EMAIL_KEY = 'vb_remember_email';


function Alert({ children, tone = 'error' }) {
  const success = tone === 'success';
  return (
    <div
      role={success ? 'status' : 'alert'}
      className={`mb-4 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm ${
        success
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-rose-200 bg-rose-50 text-rose-700 animate-shake'
      }`}
    >
      <svg className="mt-0.5 h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        {success ? (
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3m0 4h.01M10.3 4.5L2.8 18a2 2 0 001.7 3h15a2 2 0 001.7-3L13.7 4.5a2 2 0 00-3.4 0z" />
        )}
      </svg>
      <span className="font-medium leading-5">{children}</span>
    </div>
  );
}

function SubmitButton({ loading, children, loadingLabel }) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="w-full flex justify-center items-center gap-2 bg-primary hover:bg-indigo-dark text-on-primary font-label-md text-label-md py-3 px-4 rounded-DEFAULT transition-colors shadow-sm active:shadow-inner disabled:cursor-wait disabled:opacity-70"
    >
      {loading ? (
        <>
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
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
    <div className="bg-canvas text-on-surface min-h-screen flex font-body-md selection:bg-primary-container selection:text-on-primary">
      <div className="flex w-full min-h-screen">
        
        {/* Left Side: Graphic Area */}
        <div className="hidden lg:flex w-[45%] bg-primary-container flex-col justify-between p-12 lg:p-16 relative overflow-hidden">
          <div className="absolute inset-0 opacity-10 pointer-events-none" style={{ backgroundImage: "radial-gradient(circle at 100% 0%, white 0%, transparent 50%)" }}></div>
          <div className="z-10 flex items-center gap-2">
            <span className="material-symbols-outlined text-on-primary text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>dashboard_customize</span>
            <span className="font-headline-md text-headline-md font-bold text-on-primary tracking-tight">ReconCentral</span>
          </div>
          <div className="z-10 mt-auto pb-12">
            <img alt="Abstract representation of financial data" className="w-full max-w-md h-auto mb-10 rounded-xl shadow-2xl border border-white/10 opacity-90 object-cover" src="https://lh3.googleusercontent.com/aida-public/AB6AXuAmz4KnhVlMA66MOmTzuXXN_EKKQ_MPXH_j9C2cjhNq4pJwU55y9bzZ-gus75wfY2HrOzfprz6_od6nTvyi9QV_kBOwWba3v8ed3fkFL-SinPAt3o943MLV1V2m53uUsyH5ubpF7HYYvpstfpwrfet6vxC7yk4STmB_f6pQMT6zO1TXJJnY4g28VbD8r7eK72H8GOEsgGIU2eKxBXRPD_WaHHpKdp5ktdT01uC19bxlB1_7fVsG2CUz"/>
            <h1 className="font-display-lg text-display-lg text-on-primary mb-4 max-w-md">Every payout, clearly accounted for.</h1>
            <p className="font-body-lg text-body-lg text-on-primary-container mb-10 max-w-md opacity-90">
                The financial control room designed specifically for Indian marketplace sellers. Take command of your cash flow with absolute precision.
            </p>
            <ul className="space-y-4">
              <li className="flex items-start gap-3">
                <div className="bg-white/10 rounded-full p-1 mt-0.5">
                  <span className="material-symbols-outlined text-on-primary text-sm">check</span>
                </div>
                <span className="font-body-md text-body-md text-on-primary opacity-90">Multi-marketplace visibility</span>
              </li>
              <li className="flex items-start gap-3">
                <div className="bg-white/10 rounded-full p-1 mt-0.5">
                  <span className="material-symbols-outlined text-on-primary text-sm">check</span>
                </div>
                <span className="font-body-md text-body-md text-on-primary opacity-90">Faster reconciliation</span>
              </li>
              <li className="flex items-start gap-3">
                <div className="bg-white/10 rounded-full p-1 mt-0.5">
                  <span className="material-symbols-outlined text-on-primary text-sm">check</span>
                </div>
                <span className="font-body-md text-body-md text-on-primary opacity-90">Profit clarity</span>
              </li>
            </ul>
          </div>
        </div>

        {/* Right Side: Login Form Area */}
        <div className="w-full lg:w-[55%] flex flex-col justify-center items-center p-6 sm:p-12 bg-surface">
          <div className="lg:hidden flex items-center gap-2 mb-12 self-start w-full max-w-[440px] mx-auto">
            <span className="material-symbols-outlined text-primary text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>dashboard_customize</span>
            <span className="font-headline-md text-headline-md font-bold text-ink tracking-tight">ReconCentral</span>
          </div>

          <div className="w-full max-w-[440px]">
            {!isForgotPassword ? (
              <>
                <div className="mb-10">
                  <h2 className="font-headline-lg text-headline-lg text-ink mb-2">Welcome back</h2>
                  <p className="font-body-md text-body-md text-secondary">Sign in to continue to your dashboard.</p>
                </div>

                {error && <Alert>{error}</Alert>}

                <form onSubmit={handleSubmit} className="space-y-6">
                  <div className="space-y-2">
                    <label className="block font-body-sm text-body-sm font-bold text-ink" htmlFor="email">Work email</label>
                    <input
                      className="w-full px-4 py-3 rounded-DEFAULT border border-border bg-surface text-ink focus:border-primary focus:ring-2 focus:ring-primary/20 transition-shadow outline-none placeholder-outline-variant font-body-md"
                      id="email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={event => setEmail(event.target.value)}
                      placeholder="name@company.com"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="block font-body-sm text-body-sm font-bold text-ink" htmlFor="password">Password</label>
                      <button type="button" onClick={openPasswordReset} className="font-body-sm text-body-sm text-primary hover:text-indigo-dark font-medium transition-colors focus:outline-none">
                        Forgot password?
                      </button>
                    </div>
                    <div className="relative">
                      <input
                        className="w-full px-4 py-3 pr-10 rounded-DEFAULT border border-border bg-surface text-ink focus:border-primary focus:ring-2 focus:ring-primary/20 transition-shadow outline-none placeholder-outline-variant font-body-md"
                        id="password"
                        name="password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        value={password}
                        onChange={event => setPassword(event.target.value)}
                        placeholder="••••••••"
                        required
                      />
                      <button
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-outline hover:text-ink transition-colors flex items-center justify-center"
                        type="button"
                        onClick={() => setShowPassword(value => !value)}
                      >
                        <span className="material-symbols-outlined text-xl">{showPassword ? 'visibility_off' : 'visibility'}</span>
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
                    <label className="font-body-sm text-body-sm text-secondary cursor-pointer select-none" htmlFor="remember">Remember me</label>
                  </div>

                  <div className="pt-2">
                    <SubmitButton loading={loading} loadingLabel="Signing in…">Sign in</SubmitButton>
                  </div>
                </form>
              </>
            ) : (
              <>
                <button type="button" onClick={returnToSignIn} className="mb-6 inline-flex items-center gap-2 font-body-sm font-bold text-secondary hover:text-ink">
                  <span className="material-symbols-outlined text-[18px]">arrow_back</span>
                  Back to sign in
                </button>

                <div className="mb-10">
                  <h2 className="font-headline-lg text-headline-lg text-ink mb-2">Reset password</h2>
                  <p className="font-body-md text-body-md text-secondary">We’ll send recovery instructions to your work email.</p>
                </div>

                {error && <Alert>{error}</Alert>}
                {resetSuccess && <Alert tone="success">{resetSuccess}</Alert>}

                <form onSubmit={handleForgotPasswordSubmit} className="space-y-6">
                  <div className="space-y-2">
                    <label className="block font-body-sm text-body-sm font-bold text-ink" htmlFor="reset-email">Work email</label>
                    <input
                      className="w-full px-4 py-3 rounded-DEFAULT border border-border bg-surface text-ink focus:border-primary focus:ring-2 focus:ring-primary/20 transition-shadow outline-none placeholder-outline-variant font-body-md"
                      id="reset-email"
                      name="reset-email"
                      type="email"
                      autoComplete="email"
                      value={resetEmail}
                      onChange={event => setResetEmail(event.target.value)}
                      placeholder="name@company.com"
                      required
                    />
                  </div>
                  <div className="pt-2">
                    <SubmitButton loading={resetLoading} loadingLabel="Sending…">Send recovery link</SubmitButton>
                  </div>
                </form>
              </>
            )}

            <div className="mt-12 text-center flex flex-col sm:flex-row items-center justify-center gap-2 font-body-sm text-body-sm text-outline">
              <div className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">lock</span>
                <span>Your financial data is encrypted and protected.</span>
              </div>
              <span className="hidden sm:inline text-border">•</span>
              <a className="text-primary hover:text-indigo-dark transition-colors font-medium" href="#">Contact support</a>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
