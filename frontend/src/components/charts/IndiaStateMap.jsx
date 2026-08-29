import { useState, useMemo } from 'react';
import IndiaData from '@svg-maps/india';

// ── State name normalisation ──────────────────────────────────────────────────
// Maps common DB spellings / abbreviations → package location id
const ALIAS_TO_ID = {
  // J&K variants (covers POK + Aksai Chin in the official SVG)
  'jammu & kashmir':          'jk',
  'jammu and kashmir':        'jk',
  'jammu & kashmir (ut)':     'jk',
  'j&k':                      'jk',
  'j & k':                    'jk',
  'ladakh':                   'jk',  // carved out 2019; package shows combined
  // Legacy / alternate spellings
  'orissa':                   'or',
  'uttaranchal':              'ut',
  'chattisgarh':              'ct',
  'pondicherry':              'py',
  'daman & diu':              'dd',
  'daman and diu':            'dd',
  'dadra & nagar haveli':     'dn',
  'dadra and nagar haveli':   'dn',
  'dadra and nagar haveli and daman and diu': 'dn',
  'andaman & nicobar':        'an',
  'andaman & nicobar islands':'an',
  'andaman and nicobar islands': 'an',
};

// Build id → location lookup
const LOCATIONS = IndiaData.locations;
const ID_MAP = Object.fromEntries(LOCATIONS.map(l => [l.id, l]));

function normKey(s) {
  return (s || '').toLowerCase().replace(/[.']/g, '').replace(/\s+/g, ' ').trim();
}

function stateToId(stateName) {
  const k = normKey(stateName);
  if (ALIAS_TO_ID[k]) return ALIAS_TO_ID[k];
  // Try matching package location names directly
  for (const loc of LOCATIONS) {
    if (normKey(loc.name) === k) return loc.id;
  }
  return null;
}

// ── Heat colour scale ─────────────────────────────────────────────────────────
function heatFill(rate, hasData) {
  if (!hasData) return '#e2e8f0';       // slate-200 = no delivery data
  const r = +rate || 0;
  if (r === 0)  return '#dcfce7';       // green-100 = 0% returns
  if (r < 5)    return '#4ade80';       // green-400
  if (r < 10)   return '#a3e635';       // lime-400
  if (r < 15)   return '#facc15';       // yellow-400
  if (r < 20)   return '#fb923c';       // orange-400
  if (r < 30)   return '#ef4444';       // red-500
  return '#7f1d1d';                     // red-900 (critical)
}

const LEGEND = [
  { fill: '#dcfce7', label: '0%'       },
  { fill: '#4ade80', label: '< 5%'     },
  { fill: '#a3e635', label: '5 – 10%'  },
  { fill: '#facc15', label: '10 – 15%' },
  { fill: '#fb923c', label: '15 – 20%' },
  { fill: '#ef4444', label: '20 – 30%' },
  { fill: '#7f1d1d', label: '≥ 30%',   textLight: true },
  { fill: '#e2e8f0', label: 'No data'  },
];

// ── Component ─────────────────────────────────────────────────────────────────
export default function IndiaStateMap({ data = [], title, sub }) {
  const [hovered, setHovered] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  // Build id → data row
  const dataById = useMemo(() => {
    const map = {};
    for (const row of data) {
      const id = stateToId(row.state);
      if (id) {
        // Merge if multiple rows map to same id (e.g. J&K + Ladakh)
        if (map[id]) {
          const existing = map[id];
          const totalOrders  = +existing.orders  + +row.orders;
          const totalReturns = +existing.returns + +row.returns;
          map[id] = {
            ...existing,
            orders:      totalOrders,
            returns:     totalReturns,
            return_rate: totalOrders ? +((totalReturns / totalOrders) * 100).toFixed(1) : 0,
          };
        } else {
          map[id] = { ...row, orders: +row.orders, returns: +row.returns };
        }
      }
    }
    return map;
  }, [data]);

  function handleMouseEnter(e, id) {
    setHovered(id);
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }
  function handleMouseMove(e) {
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }

  const hoveredRow  = hovered ? dataById[hovered]  : null;
  const hoveredName = hovered ? ID_MAP[hovered]?.name : null;

  return (
    <div className="relative w-full select-none">
      {(title || sub) && (
        <div className="mb-3">
          {title && <h3 className="text-sm font-bold text-ink">{title}</h3>}
          {sub   && <p  className="text-xs text-outline mt-0.5">{sub}</p>}
        </div>
      )}

      {/* SVG India Map */}
      <svg
        viewBox={IndiaData.viewBox}
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-auto drop-shadow-sm"
        aria-label="India return rate heatmap"
      >
        {LOCATIONS.map(loc => {
          const row     = dataById[loc.id];
          const fill    = heatFill(row?.return_rate, !!row);
          const isHover = hovered === loc.id;

          return (
            <path
              key={loc.id}
              d={loc.path}
              fill={fill}
              stroke="#ffffff"
              strokeWidth={0.6}
              strokeLinejoin="round"
              style={{
                filter:  isHover ? 'brightness(0.88)' : 'none',
                cursor:  'pointer',
                transition: 'filter 0.1s ease',
              }}
              onMouseEnter={e => handleMouseEnter(e, loc.id)}
              onMouseMove={handleMouseMove}
              onMouseLeave={() => setHovered(null)}
            />
          );
        })}
      </svg>

      {/* Tooltip — fixed so it follows cursor outside SVG bounds */}
      {hovered && (
        <div
          className="fixed z-[9999] pointer-events-none"
          style={{ left: tooltipPos.x + 14, top: tooltipPos.y - 52 }}
        >
          <div className="bg-primary/95 backdrop-blur-sm text-white text-xs px-3.5 py-2.5 rounded-xl shadow-2xl border border-primary/60 min-w-[160px]">
            <p className="font-bold text-sm text-white mb-1.5 leading-tight">{hoveredName}</p>
            {hoveredRow ? (
              <div className="space-y-0.5">
                <div className="flex justify-between gap-4">
                  <span className="text-outline">Return Rate</span>
                  <span className={`font-bold ${+hoveredRow.return_rate >= 20 ? 'text-red-400' : +hoveredRow.return_rate >= 10 ? 'text-amber-400' : 'text-green-400'}`}>
                    {(+hoveredRow.return_rate).toFixed(1)}%
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-outline">Returns</span>
                  <span className="text-white font-medium">{(+hoveredRow.returns).toLocaleString('en-IN')}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-outline">Orders</span>
                  <span className="text-white font-medium">{(+hoveredRow.orders).toLocaleString('en-IN')}</span>
                </div>
              </div>
            ) : (
              <p className="text-outline">No delivery data</p>
            )}
          </div>
          {/* Tooltip arrow */}
          <div className="w-0 h-0 ml-3 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-slate-800/95" />
        </div>
      )}

      {/* Colour legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 justify-center mt-4 px-2">
        {LEGEND.map(({ fill, label, textLight }) => (
          <div key={label} className="flex items-center gap-1.5">
            <span
              className="h-3.5 w-3.5 rounded-sm shrink-0 border border-border/60"
              style={{ background: fill }}
            />
            <span className="text-[11px] text-secondary">{label}</span>
          </div>
        ))}
      </div>

      {/* Territory note */}
      <p className="text-[10px] text-outline text-center mt-2.5 italic">
        Map shows India's official territorial claim including Jammu & Kashmir (with POK), Ladakh (with Aksai Chin)
      </p>
    </div>
  );
}
