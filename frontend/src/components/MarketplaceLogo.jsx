import { useState } from 'react';

/**
 * Verified Official Marketplace Logos via Brandfetch CDN & Fallback Badges
 */
export const MARKETPLACE_LOGOS = {
  flipkart: {
    name: 'Flipkart',
    logo: 'https://cdn.brandfetch.io/idWdImNSUt/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177459816idZyD0yYjDWqQ88x6B',
    bgColor: '#2874F0',
    textColor: '#FFFFFF',
    short: 'FK',
  },
  amazon: {
    name: 'Amazon',
    logo: 'https://cdn.brandfetch.io/idomDO5Jzv/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177472711idZyD0yYjDdIjVoG73',
    bgColor: '#232F3E',
    textColor: '#FF9900',
    short: 'AMZ',
  },
  myntra: {
    name: 'Myntra',
    logo: 'https://cdn.brandfetch.io/idDW82Qwj2/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177484037idZyD0yYjDtAenWdeL',
    bgColor: '#F13AB1',
    textColor: '#FFFFFF',
    short: 'MYN',
  },
  myntra_vb: {
    name: 'Myntra (VB)',
    logo: 'https://cdn.brandfetch.io/idDW82Qwj2/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177484037idZyD0yYjDtAenWdeL',
    bgColor: '#F13AB1',
    textColor: '#FFFFFF',
    short: 'VB',
  },
  myntra_ej: {
    name: 'Myntra (EJ)',
    logo: 'https://cdn.brandfetch.io/idDW82Qwj2/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177484037idZyD0yYjDtAenWdeL',
    bgColor: '#BE185D',
    textColor: '#FFFFFF',
    short: 'EJ',
  },
  meesho: {
    name: 'Meesho',
    logo: 'https://cdn.brandfetch.io/idyeTDctmi/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177498057idZyD0yYjDdWnJrl50',
    bgColor: '#570844',
    textColor: '#FFFFFF',
    short: 'MSH',
  },
  ajio: {
    name: 'Reliance Retail (AJIO)',
    logo: 'https://cdn.brandfetch.io/idr5xgDFc2/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177490710idZyD0yYjDeHmQHVu1',
    bgColor: '#2C4152',
    textColor: '#FFFFFF',
    short: 'AJIO',
  },
  cocoblu: {
    name: 'Cocoblu Retails',
    logo: 'https://cdn.brandfetch.io/iduQ6iAglk/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177520125idZyD0yYjDnFplzDd_',
    bgColor: '#0052CC',
    textColor: '#FFFFFF',
    short: 'CBL',
  },
  shopify: {
    name: 'Shopify',
    logo: 'https://cdn.brandfetch.io/idAgPm7IvG/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177511905idZyD0yYjDkUgFPWU1',
    bgColor: '#96BF48',
    textColor: '#000000',
    short: 'SHOP',
  },
  shopsy: {
    name: 'Shopsy',
    logo: 'https://cdn.brandfetch.io/idWdImNSUt/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1793177459816idZyD0yYjDWqQ88x6B',
    bgColor: '#FF5722',
    textColor: '#FFFFFF',
    short: 'SHP',
  },
  zepto: {
    name: 'Zepto',
    bgColor: '#52006A',
    textColor: '#FFC107',
    short: 'ZEP',
  },
};

/**
 * Standard sizes for MarketplaceLogo
 */
const SIZE_CLASSES = {
  xs: { container: 'w-5 h-5 min-w-[20px] rounded', text: 'text-[9px]', img: 'w-3.5 h-3.5' },
  sm: { container: 'w-6 h-6 min-w-[24px] rounded-md', text: 'text-[10px]', img: 'w-4 h-4' },
  md: { container: 'w-8 h-8 min-w-[32px] rounded-lg', text: 'text-xs', img: 'w-5 h-5' },
  lg: { container: 'w-10 h-10 min-w-[40px] rounded-xl', text: 'text-sm', img: 'w-7 h-7' },
  xl: { container: 'w-12 h-12 min-w-[48px] rounded-xl', text: 'text-base', img: 'w-8 h-8' },
};

/**
 * Normalizes marketplace keys (e.g. 'Amazon-India' -> 'amazon', 'myntra_vb' -> 'myntra_vb')
 */
export function normalizeMarketplaceKey(key = '') {
  const k = String(key || '').toLowerCase().trim();
  if (k.includes('myntra_vb') || k.includes('10708')) return 'myntra_vb';
  if (k.includes('myntra_ej') || k.includes('45833')) return 'myntra_ej';
  if (k.includes('myntra')) return 'myntra';
  if (k.includes('flipkart') || k.startsWith('fk')) return 'flipkart';
  if (k.includes('amazon') || k.startsWith('amz')) return 'amazon';
  if (k.includes('meesho')) return 'meesho';
  if (k.includes('ajio') || k.includes('reliance')) return 'ajio';
  if (k.includes('cocoblu')) return 'cocoblu';
  if (k.includes('shopsy')) return 'shopsy';
  if (k.includes('shopify')) return 'shopify';
  if (k.includes('zepto')) return 'zepto';
  return k;
}

/**
 * MarketplaceLogo Component
 * Renders official SVG/WebP Brandfetch CDN logo with a crisp fallback badge.
 */
export default function MarketplaceLogo({
  marketplace,
  account,
  size = 'md',
  showAccountBadge = false,
  className = '',
  alt,
}) {
  const [imgError, setImgError] = useState(false);

  // Normalize channel
  const effectiveKey = account ? normalizeMarketplaceKey(account) : normalizeMarketplaceKey(marketplace);
  const config = MARKETPLACE_LOGOS[effectiveKey] || MARKETPLACE_LOGOS[normalizeMarketplaceKey(marketplace)] || {
    name: marketplace || 'Portal',
    bgColor: '#902A4A',
    textColor: '#FFFFFF',
    short: String(marketplace || 'P').slice(0, 3).toUpperCase(),
  };

  const sz = SIZE_CLASSES[size] || SIZE_CLASSES.md;
  const logoUrl = !imgError ? config.logo : null;

  return (
    <div
      className={`relative inline-flex items-center justify-center shrink-0 border border-border/80 bg-surface shadow-2xs overflow-hidden transition-transform duration-150 ${sz.container} ${className}`}
      style={{ backgroundColor: logoUrl ? '#FFFFFF' : config.bgColor }}
      title={config.name}
    >
      {logoUrl ? (
        <img
          src={logoUrl}
          alt={alt || config.name}
          className={`${sz.img} object-contain`}
          onError={() => setImgError(true)}
          loading="lazy"
        />
      ) : (
        <span
          className={`font-mono font-bold tracking-tight select-none ${sz.text}`}
          style={{ color: config.textColor }}
        >
          {config.short}
        </span>
      )}

      {showAccountBadge && (
        <span className="absolute -bottom-0.5 -right-0.5 rounded bg-ink px-0.5 text-[8px] font-mono text-white leading-none">
          {effectiveKey.includes('ej') ? 'EJ' : effectiveKey.includes('vb') ? 'VB' : ''}
        </span>
      )}
    </div>
  );
}
