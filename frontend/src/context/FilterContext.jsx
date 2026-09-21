import { createContext, useContext, useState, useCallback } from 'react';

const FilterContext = createContext(null);
const SAVED_VIEWS_KEY = 'vb_saved_filter_views';
const DEFAULT_FILTERS = {
  startDate: '',
  endDate: '',
  category: '',
  region: '',
  status: '',
  groupBy: 'month',
  marketplace: '',
  brand: '',
};

export function FilterProvider({ children }) {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [savedViews, setSavedViews] = useState(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(SAVED_VIEWS_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [refreshKey, setRefreshKey] = useState(0);

  const updateFilter = useCallback((key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  }, []);

  const resetFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
  }, []);

  // A timestamp rather than a counter: the API client honours each refresh
  // token once, so tokens must not repeat across pages or sessions.
  const triggerRefresh = useCallback(() => setRefreshKey(k => Math.max(Date.now(), k + 1)), []);

  const saveView = useCallback((name) => {
    const cleanName = name?.trim();
    if (!cleanName) return null;
    const view = { id: `${Date.now()}`, name: cleanName, filters: { ...filters } };
    setSavedViews(previous => {
      const next = [...previous.filter(item => item.name.toLowerCase() !== cleanName.toLowerCase()), view];
      localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(next));
      return next;
    });
    return view;
  }, [filters]);

  const applyView = useCallback((id) => {
    const view = savedViews.find(item => item.id === id);
    if (view) setFilters({ ...DEFAULT_FILTERS, ...view.filters });
  }, [savedViews]);

  const deleteView = useCallback((id) => {
    setSavedViews(previous => {
      const next = previous.filter(item => item.id !== id);
      localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return (
    <FilterContext.Provider value={{
      filters,
      updateFilter,
      resetFilters,
      refreshKey,
      triggerRefresh,
      savedViews,
      saveView,
      applyView,
      deleteView,
    }}>
      {children}
    </FilterContext.Provider>
  );
}

export function useFilters() { return useContext(FilterContext); }
