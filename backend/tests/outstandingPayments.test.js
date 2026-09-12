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
});
