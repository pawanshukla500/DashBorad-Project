import { useState, useEffect, useRef, useCallback } from 'react';
import { invalidateApiReadCache } from '../api/client';
import { notifyRefreshingStarted } from '../components/RefreshingBanner';

// A visibility change notifies every mounted hook at once. Clearing the shared
// client cache from each listener would also clear its in-flight map repeatedly
// and turn one return-to-tab refresh into many duplicate report requests.
let lastFocusCacheInvalidationAt = 0;
const FOCUS_INVALIDATION_WINDOW_MS = 250;

function invalidateCacheOnceForFocus(now) {
  if (now - lastFocusCacheInvalidationAt < FOCUS_INVALIDATION_WINDOW_MS) return;
  lastFocusCacheInvalidationAt = now;
  invalidateApiReadCache();
}

// options.refetchOnFocus  — re-fetch when the browser tab becomes visible again
// options.focusThresholdMs — minimum ms since last fetch before a focus re-fetch fires (default 30 s)
// options.enabled — defer the request until the containing UI tab is active
export default function useFetch(fetchFn, deps, options = {}) {
  const { enabled = true, refetchOnFocus = true, focusThresholdMs = 30_000 } = options;

  // `loading`   — first render / no cached data yet. Pages show skeletons.
  // `refreshing` — we already have a verified result but a new request is in
  //                flight (deps changed, tab focus re-fetch, manual refetch).
  //                Pages keep showing the existing data and may overlay a
  //                global "Refreshing…" pill instead of unmounting the table.
  //                This removes the empty-table flash on every tab navigation.
  const [state, setState] = useState({ data: null, loading: true, refreshing: false, error: null });
  const [extra, setExtra] = useState(0);          // bumped to force a manual / focus re-fetch
  const lastFetchAt = useRef(0);

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      // A hidden tab keeps its verified result, but never starts an expensive
      // request merely because another tab mounted or refreshed.
      setState(previous => previous.loading ? { ...previous, loading: false } : previous);
      return () => { cancelled = true; };
    }
    // Decide up-front whether this is a first-paint load or a stale-while-
    // revalidate refresh. The decision drives both the loading flag and the
    // global banner subscription so we don't double-fire the notifications.
    const previousDataAvailable = stateRef.current.data != null;
    setState(previous => previous.data == null
      ? { ...previous, loading: true, error: null }
      : { ...previous, refreshing: true, error: null });
    lastFetchAt.current = Date.now();
    // Only the stale-while-revalidate phase surfaces the global banner; first
    // paint already has the route-level skeleton fallback covering the gap.
    const releaseBanner = previousDataAvailable ? notifyRefreshingStarted() : undefined;
    fetchFn()
      .then(data => {
        if (cancelled) { releaseBanner?.(); return; }
        setState({ data, loading: false, refreshing: false, error: null });
        releaseBanner?.();
      })
      .catch(err => {
        if (cancelled) { releaseBanner?.(); return; }
        // Keep the last verified result visible while a transient network
        // error is shown. Financial tabs remain usable instead of flashing
        // empty tables/charts during a retry or brief backend restart.
        setState(previous => ({
          ...previous,
          loading: false,
          refreshing: false,
          error: err.response?.data?.error || err.message,
        }));
        releaseBanner?.();
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...(deps || []), extra, enabled]);

  // Mirror state into a ref so the effect above can read it without re-running.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!enabled || !refetchOnFocus) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastFetchAt.current > focusThresholdMs) {
        invalidateCacheOnceForFocus(Date.now());
        setExtra(n => n + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled, refetchOnFocus, focusThresholdMs]);

  const refetch = useCallback(() => {
    // An explicit refresh must not be fulfilled by the short-lived read cache.
    // The affected hook will fetch again on the next render; mutation responses
    // also use this same invalidation path automatically.
    invalidateApiReadCache();
    setExtra(n => n + 1);
  }, []);

  return { ...state, refetch };
}
