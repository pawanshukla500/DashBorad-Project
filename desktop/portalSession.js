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
  if (Array.from(document.querySelectorAll('input[type="password"], input[name="username"], input[autocomplete="one-time-code"]')).some(visible)) return false;
  const controls = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter(visible);
  if (controls.some(el => /^(log\s*in|sign\s*in)$/i.test(el.innerText.trim()))) return false;
  const dashboard = location.pathname === '/index.html' && /^#dashboard(?:\/|$)/i.test(location.hash);
  const shell = controls.some(el => /^(log\s*out|sign\s*out|my profile)$/i.test(el.innerText.trim()) ||
    /#dashboard\/(?:orders|payments|listings)/i.test(el.getAttribute('href') || ''));
  return dashboard && shell;
}
