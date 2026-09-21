import { useCallback, useState } from 'react';

// A page number that returns to 1 whenever `resetKey` changes (for example the
// serialized filters). The reset happens in the same render, so no request is
// ever sent for the previous page with the new filters, which used to land
// users on an empty page ("No returns found") after narrowing a filter.
export default function useResettingPage(resetKey) {
  const [state, setState] = useState({ key: resetKey, page: 1 });
  const page = state.key === resetKey ? state.page : 1;
  const setPage = useCallback((next) => {
    setState(previous => {
      const current = previous.key === resetKey ? previous.page : 1;
      return { key: resetKey, page: typeof next === 'function' ? next(current) : next };
    });
  }, [resetKey]);
  return [page, setPage];
}
