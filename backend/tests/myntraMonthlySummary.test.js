import { describe, expect, it } from 'vitest';
import express from 'express';
import mpSettlementRoutes from '../routes/mpSettlement.js';

describe('Myntra Monthly Settlement Summary Route', () => {
  it('registers /monthly-summary and /invoices/monthly-summary routes', () => {
    const routes = mpSettlementRoutes.stack
      .filter(r => r.route)
      .map(r => ({
        path: r.route.path,
        method: Object.keys(r.route.methods)[0],
      }));

    const hasMonthly = routes.some(r => r.path === '/monthly-summary' && r.method === 'get');
    const hasInvoicesMonthly = routes.some(r => r.path === '/invoices/monthly-summary' && r.method === 'get');

    expect(hasMonthly).toBe(true);
    expect(hasInvoicesMonthly).toBe(true);
  });
});
