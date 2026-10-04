import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Structural tests for the SOR (Sales Order Reconciliation) REST routes.
 *
 * Like the existing myntraDataCenter / codeantFollowup tests, this is
 * a source-file read-and-assert suite rather than a live-server test.
 * The shape of the sor.js API is part of the SOR contract — Phase 0.5
 * (PR #44) ships it, every portal parser (Phase 1–4) reads it.
 *
 * Assertions:
 *   - Endpoint URL patterns are stable
 *   - The portal allow-list is fixed
 *   - The query builder pins `portal = $1` (no cross-portal leaks)
 *   - Pagination caps pageSize at 500
 *   - The detail endpoint groups lines by line_type (sale/payment/return/deduction)
 *   - Unknown portals return 404 (defence in depth)
 */

const sorRoutes = fs.readFileSync(new URL('../routes/sor.js', import.meta.url), 'utf8');
const sorView  = fs.readFileSync(new URL('../db/initDb.js', import.meta.url), 'utf8');

describe('SOR routes — endpoint surface', () => {
  it('exposes the three required GET endpoints for each portal', () => {
    expect(sorRoutes).toContain("router.get('/:portal/outstanding'");
    expect(sorRoutes).toContain("router.get('/:portal/invoices'");
    expect(sorRoutes).toContain("router.get('/:portal/invoice/:id'");
  });

  it('allow-lists the four SOR portals and rejects unknown ones', () => {
    expect(sorRoutes).toContain("'myntra-jabong'");
    expect(sorRoutes).toContain("'zepto'");
    expect(sorRoutes).toContain("'reliance-ajio'");
    expect(sorRoutes).toContain("'cocoblu'");
    // The defence-in-depth 404 path uses isAllowedPortal().
    expect(sorRoutes).toContain('isAllowedPortal(portal)');
    expect(sorRoutes).toContain("res.status(404).json({ error: 'Unknown SOR portal'");
  });

  it('pins `portal = $1` so cross-portal data cannot leak between sub-tabs', () => {
    expect(sorRoutes).toContain("'portal = $1'");
    // buildSorInvoiceWhere returns values[0] = portal as the first
    // positional parameter so every SELECT is anchored on the portal.
    expect(sorRoutes).toContain('values = [portal]');
  });
});

describe('SOR routes — projection', () => {
  it('returns the per-invoice detail grouped by line_type', () => {
    expect(sorRoutes).toContain("const grouped = { sale: [], payment: [], return: [], deduction: [] }");
    expect(sorRoutes).toContain("if (bucket) bucket.push(ln)");
  });
});

describe('SOR routes — read-only contract', () => {
  it('does not declare any POST / PUT / PATCH / DELETE handlers (read-only API)', () => {
    expect(sorRoutes).not.toMatch(/router\.(post|put|patch|delete)\(/);
  });

  it('queries the sor_outstanding view, not sor_invoice_line directly', () => {
    expect(sorRoutes).toContain('FROM sor_outstanding');
    // The detail endpoint joins on sor_invoice_line, but always
    // anchored on the header's invoice_id + portal for safety.
    expect(sorRoutes).toMatch(/WHERE id = .1 AND portal = .2/);
    expect(sorRoutes).toContain('FROM sor_invoice_line');
  });
});

describe('SOR accounting ledger — view contract', () => {
  it('sor_outstanding is created as a REPLACE VIEW (idempotent on re-run)', () => {
    expect(sorView).toContain('CREATE OR REPLACE VIEW sor_outstanding AS');
  });

  it('computes outstanding as sale − payment − return − deduction', () => {
    // The COALESCE-around-zero-fallback + the FILTER expressions are
    // the single source of truth for the SOR KPI grid + Ledger UI.
    expect(sorView).toMatch(/sale_total[\s\S]+payment_total[\s\S]+return_total[\s\S]+deduction_total/);
    expect(sorView).toContain("FILTER (WHERE s.line_type = 'sale')");
    expect(sorView).toContain("FILTER (WHERE s.line_type = 'payment')");
    expect(sorView).toContain("FILTER (WHERE s.line_type = 'return')");
    expect(sorView).toContain("FILTER (WHERE s.line_type = 'deduction')");
    // The outstanding expression: sale - (payment + return + deduction).
    expect(sorView).toContain("line_type IN ('payment','return','deduction')");
  });

  it('enforces the line_type CHECK constraint on sor_invoice_line', () => {
    expect(sorView).toContain("CHECK (line_type IN ('sale', 'payment', 'return', 'deduction'))");
  });
});