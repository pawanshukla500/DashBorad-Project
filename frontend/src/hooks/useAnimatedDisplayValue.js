import { useEffect, useMemo, useRef, useState } from 'react';

export function parseDisplayValue(value) {
  const raw = value == null ? '—' : String(value);
  // Keep the report's established ₹, %, K/L/Cr, and decimal formatting while
  // isolating its numeric portion for animation.
  const match = raw.match(/^(.*?)([-+]?\d[\d,]*(?:\.\d+)?)(.*)$/);
  if (!match) return { raw, numeric: null };

  const numeric = Number(match[2].replace(/,/g, ''));
  if (!Number.isFinite(numeric)) return { raw, numeric: null };
  const decimals = (match[2].split('.')[1] || '').length;
  const zeroAtPrecision = 0.5 * 10 ** -decimals;
  const [, prefix, , suffix] = match;
  return {
    raw,
    numeric,
    signature: `${prefix}|${suffix}|${decimals}`,
    // Never flash a misleading −0 while a negative monetary value begins
    // its animation from zero.
    format: number => `${prefix}${(Math.abs(number) < zeroAtPrecision ? 0 : number).toLocaleString('en-IN', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}${suffix}`,
  };
}

export function useAnimatedDisplayValue(value, duration = 560) {
  const parsed = useMemo(() => parseDisplayValue(value), [value]);
  const [display, setDisplay] = useState(parsed.raw);
  const previous = useRef(null);

  useEffect(() => {
    if (parsed.numeric == null || typeof window === 'undefined') {
      previous.current = null;
      setDisplay(parsed.raw);
      return undefined;
    }

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const prior = previous.current;
    // When a unit changes (₹999 → ₹1.0K), restart rather than animate across
    // incomparable display units.
    const start = prior?.signature === parsed.signature ? prior.numeric : 0;
    previous.current = { numeric: parsed.numeric, signature: parsed.signature };

    if (reduceMotion || start === parsed.numeric) {
      setDisplay(parsed.raw);
      return undefined;
    }

    let frameId;
    let startedAt;
    const tick = now => {
      startedAt ??= now;
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      setDisplay(parsed.format(start + (parsed.numeric - start) * eased));
      if (progress < 1) frameId = window.requestAnimationFrame(tick);
      else setDisplay(parsed.raw);
    };
    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [parsed, duration]);

  return display;
}

export default useAnimatedDisplayValue;
