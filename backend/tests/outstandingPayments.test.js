import { describe, expect, it } from 'vitest';
import express from 'express';
import reconcileRouter from '../routes/reconcile.js';

describe('Outstanding Payments Endpoints', () => {
  const app = express();
  app.use('/reconcile', reconcileRouter);

  it('GET /reconcile/outstanding/summary returns valid summary shape', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/reconcile/outstanding/summary`);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data).toHaveProperty('configured');
      if (data.configured) {
        expect(typeof data.total_outstanding_amount).toBe('number');
        expect(typeof data.total_unsettled_orders).toBe('number');
        expect(typeof data.total_unsettled_amount).toBe('number');
        expect(data).toHaveProperty('aging');
        expect(data.aging).toHaveProperty('0-15 days');
        expect(data.aging).toHaveProperty('16-30 days');
        expect(data.aging).toHaveProperty('31-60 days');
        expect(data.aging).toHaveProperty('60+ days');
        expect(Array.isArray(data.by_marketplace)).toBe(true);
      }
    } finally {
      server.close();
    }
  });

  it('GET /reconcile/outstanding/orders supports pagination and aging buckets', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/reconcile/outstanding/orders?pageSize=10&page=1`);
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json).toHaveProperty('data');
      expect(Array.isArray(json.data)).toBe(true);
      expect(json).toHaveProperty('total');
      expect(json).toHaveProperty('page', 1);
      expect(json).toHaveProperty('pageSize', 10);

      if (json.data.length > 0) {
        const order = json.data[0];
        expect(order).toHaveProperty('order_id');
        expect(order).toHaveProperty('order_item_id');
        expect(order).toHaveProperty('marketplace');
        expect(order).toHaveProperty('aging_bucket');
        expect(['0-15 days', '16-30 days', '31-60 days', '60+ days']).toContain(order.aging_bucket);
      }
    } finally {
      server.close();
    }
  });

  it('GET /reconcile/outstanding/orders filters by marketplace', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/reconcile/outstanding/orders?marketplace=flipkart&pageSize=5`);
      expect(res.status).toBe(200);
      const json = await res.json();

      if (json.data?.length > 0) {
        for (const o of json.data) {
          expect(o.marketplace).toBe('flipkart');
        }
      }
    } finally {
      server.close();
    }
  });

  it('GET /reconcile/outstanding/invoices returns paginated pending invoices', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/reconcile/outstanding/invoices?pageSize=10`);
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json).toHaveProperty('data');
      expect(Array.isArray(json.data)).toBe(true);
      expect(json).toHaveProperty('total');
    } finally {
      server.close();
    }
  });

  it('GET /reconcile/outstanding/summary returns B2C channels, Myntra accounts, and D2C vendors', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/reconcile/outstanding/summary`);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data).toHaveProperty('configured');
      if (data.configured) {
        expect(data).toHaveProperty('kpis');
        expect(typeof data.kpis.unsettled).toBe('number');
        expect(typeof data.kpis.settled_not_paid).toBe('number');
        expect(typeof data.kpis.settled_adjusted).toBe('number');
        expect(typeof data.kpis.cashback).toBe('number');
        expect(typeof data.kpis.total_outstanding).toBe('number');

        expect(data).toHaveProperty('b2c');
        expect(Array.isArray(data.b2c.channels)).toBe(true);
        expect(data.b2c.channels.length).toBeGreaterThan(0);

        // Verify Myntra accounts hierarchy
        const myntra = data.b2c.channels.find(c => c.channel_key === 'myntra');
        expect(myntra).toBeDefined();
        expect(myntra.has_accounts).toBe(true);
        expect(Array.isArray(myntra.accounts)).toBe(true);
        expect(myntra.accounts.length).toBe(2);

        const ej = myntra.accounts.find(a => a.seller_id === '45833' || a.account_key === 'myntra_ej');
        const vb = myntra.accounts.find(a => a.seller_id === '10708' || a.account_key === 'myntra_vb');
        expect(ej).toBeDefined();
        expect(vb).toBeDefined();
        expect(ej.unsettled).toBeGreaterThan(0);
        expect(vb.unsettled).toBeGreaterThan(0);

        // Verify D2C section
        expect(data).toHaveProperty('d2c');
        expect(Array.isArray(data.d2c.vendors)).toBe(true);
        expect(data.d2c.vendors.length).toBeGreaterThanOrEqual(7);

        const phonePe = data.d2c.vendors.find(v => v.vendor_key === 'phonepe');
        expect(phonePe).toBeDefined();
        expect(phonePe.vendor_name).toBe('PhonePe');
      }
    } finally {
      server.close();
    }
  });

  it('GET /reconcile/outstanding/config returns channel configs and PUT updates config', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const getRes = await fetch(`http://127.0.0.1:${port}/reconcile/outstanding/config`);
      expect(getRes.status).toBe(200);
      const configJson = await getRes.json();
      if (configJson.configured !== false) {
        expect(configJson.success).toBe(true);
        expect(Array.isArray(configJson.data)).toBe(true);
        expect(configJson.data.length).toBeGreaterThan(0);

        const myntraCfg = configJson.data.find(c => c.channel_key === 'myntra');
        expect(myntraCfg).toBeDefined();
        expect(myntraCfg.grace_period_days).toBeDefined();

        const putRes = await fetch(`http://127.0.0.1:${port}/reconcile/outstanding/config/myntra`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grace_period_days: 16 }),
        });
        expect(putRes.status).toBe(200);
        const putJson = await putRes.json();
        expect(putJson.success).toBe(true);
        expect(putJson.data.grace_period_days).toBe(16);

        // Verify 404 for unknown channel
        const notFoundRes = await fetch(`http://127.0.0.1:${port}/reconcile/outstanding/config/unknown_nonexistent_channel`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grace_period_days: 20 }),
        });
        expect(notFoundRes.status).toBe(404);
        const notFoundJson = await notFoundRes.json();
        expect(notFoundJson.error).toContain('not found');

        // Revert back
        await fetch(`http://127.0.0.1:${port}/reconcile/outstanding/config/myntra`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grace_period_days: 15 }),
        });
      }
    } finally {
      server.close();
    }
  });
});
