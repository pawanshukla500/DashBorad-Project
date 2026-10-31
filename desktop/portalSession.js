export const FLIPKART_MANUAL_LOGIN_URL = 'https://seller.flipkart.com/';
export const FLIPKART_DASHBOARD_URL = 'https://seller.flipkart.com/index.html#dashboard/home-page';

// One Seller Hub session for login, Flipkart and Shopsy. Their rates remain
// separate; their authentication storage belongs to the same portal account.
export function portalPartition(channel) {
  const id = ['both', 'flipkart', 'shopsy', 'flipkart_shopsy'].includes(channel)
    ? 'flipkart_shopsy' : channel;
  return `persist:marketplace-${id}`;
}

// This function is serialized into the portal renderer. Keep it self-contained.
// Marketing copy, a saved cookie, or a requested dashboard URL is not login proof.
export function isFlipkartAuthenticated() {
  if (location.hostname !== 'seller.flipkart.com') return false;
  const visible = el => el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const visibleInputs = Array.from(document.querySelectorAll('input')).filter(visible);
  const inputHints = el => [el.name, el.id, el.placeholder, el.getAttribute?.('aria-label')].join(' ');
  if (visibleInputs.some(el => String(el.type || '').toLowerCase() === 'password' ||
      String(el.name || '').toLowerCase() === 'username' ||
      String(el.autocomplete || '').toLowerCase() === 'one-time-code' ||
      /(?:^|[_\s-])otp(?:$|[_\s-])/i.test(String(el.name || '') + ' ' + String(el.id || '')) ||
      /captcha|recaptcha/i.test(inputHints(el)))) return false;
  if (Array.from(document.querySelectorAll('iframe')).some(el => visible(el) && /captcha|recaptcha/i.test(String(el.src || el.getAttribute('src') || '')))) return false;
  const controls = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(visible);
  if (controls.some(el => /^(log\s*in|sign\s*in)$/i.test(el.innerText.trim()))) return false;
  const dashboard = location.pathname === '/index.html' && /^#dashboard(?:\/|$)/i.test(location.hash);
  const shell = controls.some(el => /^(log\s*out|sign\s*out|my profile)$/i.test(el.innerText.trim()) ||
    /#dashboard\/(?:orders|payments|listings)/i.test(el.getAttribute('href') || ''));
  // The authenticated home layout uses dropdowns for Orders/Payments, so
  // those anchors do not exist until opened. Require the observed dashboard
  // home + advertising + assistance navigation rather than marketing text.
  const routes = controls.map(el => el.getAttribute('href') || '');
  const homeShell = ['#dashboard/home-page', '#dashboard/ads/home', '#dashboard/assistance/'].every(route => routes.some(href => href.startsWith(route)));
  return dashboard && (shell || homeShell);
}

// Keep this self-contained: it is serialized into Chromium by Puppeteer.
// The public Seller Hub login is a two-step form (username, then password), so
// the worker needs to distinguish a pending form from a completed return to
// the public landing page without reading field values or broad page copy.
export function inspectFlipkartLoginState() {
  const host = location.hostname;
  const flipkartHost = host === 'flipkart.com' || host.endsWith('.flipkart.com');
  const visible = el => el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  if (!flipkartHost) {
    return {
      surface: 'other', host, path: location.pathname, stage: 'other',
      authenticated: false, loginFormVisible: false, challengeVisible: false, captchaInputVisible: false, publicLanding: false
    };
  }

  const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
  const passwordVisible = inputs.some(el => String(el.type || '').toLowerCase() === 'password');
  const usernameVisible = inputs.some(el => String(el.name || '').toLowerCase() === 'username' ||
    String(el.autocomplete || '').toLowerCase() === 'username');
  const otpVisible = inputs.some(el => String(el.autocomplete || '').toLowerCase() === 'one-time-code' ||
    /(?:^|[_\s-])otp(?:$|[_\s-])/i.test(String(el.name || '') + ' ' + String(el.id || '')));
  const captchaInputVisible = inputs.some(el =>
    /captcha|recaptcha/i.test([el.name, el.id, el.placeholder, el.getAttribute?.('aria-label')].join(' ')));
  const captchaWidgetVisible = Array.from(document.querySelectorAll('iframe')).some(el =>
    visible(el) && /captcha|recaptcha/i.test(String(el.src || el.getAttribute('src') || '')));
  const modalText = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], .form-modal'))
    .filter(visible).map(el => String(el.innerText || '').toLowerCase()).join(' ');
  const challengeCopyVisible = /verify you are human|one[ -]?time password|verification code|captcha/i.test(modalText);
  const challengeVisible = otpVisible || captchaInputVisible || captchaWidgetVisible || challengeCopyVisible;
  const controls = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(visible);
  const hasLoginControl = controls.some(el => /^(log\s*in|sign\s*in)$/i.test(String(el.innerText || '').trim()));
  const dashboard = host === 'seller.flipkart.com' && location.pathname === '/index.html' &&
    /^#dashboard(?:\/|$)/i.test(location.hash);
  const shell = controls.some(el => /^(log\s*out|sign\s*out|my profile)$/i.test(String(el.innerText || '').trim()) ||
    /#dashboard\/(?:orders|payments|listings)/i.test(el.getAttribute('href') || ''));
  const routes = controls.map(el => el.getAttribute('href') || '');
  const homeShell = ['#dashboard/home-page', '#dashboard/ads/home', '#dashboard/assistance/']
    .every(route => routes.some(href => href.startsWith(route)));
  const authenticated = dashboard && (shell || homeShell) && !hasLoginControl &&
    !passwordVisible && !usernameVisible && !challengeVisible;
  const loginFormVisible = passwordVisible || usernameVisible;
  const publicLanding = host === 'seller.flipkart.com' && location.pathname === '/' &&
    hasLoginControl && !loginFormVisible && !challengeVisible;
  const stage = authenticated ? 'authenticated' : challengeVisible ? 'challenge' :
    passwordVisible ? 'password' : usernameVisible ? 'username' : publicLanding ? 'public' : 'portal';

  return {
    surface: 'flipkart', host, path: location.pathname, stage, authenticated,
    loginFormVisible, usernameVisible, passwordVisible, captchaInputVisible, challengeVisible, publicLanding
  };
}
