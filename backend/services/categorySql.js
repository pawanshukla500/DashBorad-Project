// The master product category used by every category breakdown, filter and
// report (AGENTS.md: category breakdowns must never fragment by marketplace
// taxonomy). One definition, two forms:
//
//  - MASTER_CATEGORY_SQL + MASTER_CATEGORY_JOINS for queries that group or
//    select by category (the joins each match at most one row:
//    sku_master is UNIQUE (marketplace, listing_sku) and vb_sku_master is
//    keyed by vb_export_sku, so they never fan out order rows);
//  - masterCategoryScalarSql(alias) for filters in queries that do not carry
//    those joins. It returns exactly the same value as scalar lookups.
//
// Filters used to compare a different expression
// (COALESCE(vb_export_category, category)) than the breakdowns, so clicking a
// category in a breakdown filtered other tiles to different counts and
// "Uncategorized" matched nothing.

export const MASTER_CATEGORY_JOINS = `
        LEFT JOIN sku_master sm_mp  ON sm_mp.listing_sku = o.sku AND sm_mp.marketplace = o.marketplace
        LEFT JOIN sku_master sm_all ON sm_all.listing_sku = o.sku AND sm_all.marketplace = 'all'
        LEFT JOIN vb_sku_master vsm ON vsm.vb_export_sku = COALESCE(sm_mp.master_sku, sm_all.master_sku, o.vb_export_sku)
`;

export const MASTER_CATEGORY_SQL = `COALESCE(vsm.category, sm_all.category, sm_mp.category, NULLIF(o.vb_export_category, ''), NULLIF(o.category, ''), 'Uncategorized')`;

export function masterCategoryScalarSql(alias = 'o') {
  const listing = marketplace => `FROM sku_master sm WHERE sm.listing_sku = ${alias}.sku AND sm.marketplace = ${marketplace}`;
  const masterSku = `COALESCE((SELECT sm.master_sku ${listing(`${alias}.marketplace`)}), (SELECT sm.master_sku ${listing("'all'")}), ${alias}.vb_export_sku)`;
  return `COALESCE(`
    + `(SELECT v.category FROM vb_sku_master v WHERE v.vb_export_sku = ${masterSku}), `
    + `(SELECT sm.category ${listing("'all'")}), `
    + `(SELECT sm.category ${listing(`${alias}.marketplace`)}), `
    + `NULLIF(${alias}.vb_export_category, ''), NULLIF(${alias}.category, ''), 'Uncategorized')`;
}
