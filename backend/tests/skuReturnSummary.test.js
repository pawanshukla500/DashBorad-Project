import { describe, expect, it } from 'vitest';
import { buildSkuReturnSummaryQuery } from '../routes/data.js';

describe('sku-return-summary query builder', () => {
  it.each(['listing', 'master', 'both'])(
    'builds valid SQL with matching SELECT and GROUP BY expressions for skuView="%s"',
    (skuView) => {
      const { sql, selectSku, groupBySku, skuJoin } = buildSkuReturnSummaryQuery(skuView, 'AND o.marketplace = $1');

      expect(sql).toContain('SELECT');
      expect(sql).toContain('GROUP BY');
      expect(sql).toContain('ORDER BY');

      if (skuView === 'master') {
        expect(selectSku).toContain("COALESCE(sm_mp.master_sku, sm_all.master_sku, o.sku, 'Unknown') AS sku");
        expect(groupBySku).toBe("COALESCE(sm_mp.master_sku, sm_all.master_sku, o.sku, 'Unknown')");
        expect(skuJoin).toContain('LEFT JOIN sku_master sm_mp');
        expect(skuJoin).toContain("sm_all.marketplace = 'all'");
        expect(skuJoin).not.toMatch(/ OR /);
      } else if (skuView === 'both') {
        expect(selectSku).toContain("COALESCE(sm_mp.master_sku, sm_all.master_sku, o.sku, 'Unknown') AS master_sku");
        expect(selectSku).toContain("COALESCE(o.sku, 'Unknown') AS sku");
        expect(groupBySku).toContain("COALESCE(sm_mp.master_sku, sm_all.master_sku, o.sku, 'Unknown')");
        expect(groupBySku).toContain("COALESCE(o.sku, 'Unknown')");
        expect(skuJoin).toContain('LEFT JOIN sku_master sm_mp');
        expect(skuJoin).toContain("sm_all.marketplace = 'all'");
        expect(skuJoin).not.toMatch(/ OR /);
      } else {
        expect(selectSku).toContain("COALESCE(o.sku, 'Unknown') AS sku");
        expect(groupBySku).toBe("COALESCE(o.sku, 'Unknown')");
        expect(skuJoin).toBe('');
      }

      // Crucial PostgreSQL requirement: every non-aggregate expression in selectSku
      // must be properly matched in groupBySku
      if (skuView === 'master' || skuView === 'both') {
        expect(sql).toMatch(
          /GROUP BY\s+COALESCE\(sm_mp\.master_sku,\s*sm_all\.master_sku,\s*o\.sku,\s*'Unknown'\)/,
        );
      }
    },
  );
});
