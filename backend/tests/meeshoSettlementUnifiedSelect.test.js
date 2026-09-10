import { describe, expect, it } from 'vitest';
import { meeshoSettlementUnifiedSelect } from '../services/meeshoSettlementReportingRollups.js';

function countSelectColumns(sql) {
  const selectList = sql.slice(sql.indexOf('SELECT') + 6, sql.indexOf('FROM meesho_settlement_items'));
  let depth = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  const parts = [];
  let current = '';
  for (let i = 0; i < selectList.length; i++) {
    const char = selectList[i];
    const next = selectList[i + 1];
    if (inLineComment) { if (char === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (char === '*' && next === '/') { inBlockComment = false; i++; } continue; }
    if (char === '-' && next === '-') { inLineComment = true; continue; }
    if (char === '/' && next === '*') { inBlockComment = true; continue; }
    if (char === "'") { inString = !inString; continue; }
    if (inString) continue;
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += char;
  }
  parts.push(current);
  return parts.filter(part => part.trim() !== '').length;
}

describe('Meesho unified_settlements branch', () => {
  const sql = meeshoSettlementUnifiedSelect();

  it('matches the unified_settlements column list exactly (68 columns)', () => {
    expect(countSelectColumns(sql)).toBe(68);
  });

  it('contains expected Meesho mappings and columns', () => {
    expect(sql).toContain("m.order_item_id");
    expect(sql).toContain("'meesho'::text AS marketplace");
    expect(sql).toContain("ABS(COALESCE(m.commission_fee, 0)) AS commission");
    expect(sql).toContain("ABS(COALESCE(m.fixed_fee, 0)) AS fixed_fee");
    expect(sql).toContain("ABS(COALESCE(m.shipping_fee, 0)) AS shipping_fee");
    expect(sql).toContain("ABS(COALESCE(m.reverse_shipping, 0)) AS reverse_shipping");
  });
});
