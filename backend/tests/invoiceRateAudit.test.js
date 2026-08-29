import { describe, expect, it } from 'vitest';
import {
  auditInvoiceRow,
  invoiceSourceFingerprint,
  parseInvoiceUploadRow,
} from '../routes/mpSettlement.js';

describe('invoice rate card auditing', () => {
  it('returns not_configured when no rate card rules exist', () => {
    const invoice = {
      invoice_amount: 1000,
      quantity: 1,
      selling_price: 1000,
      commission_pct: 28,
      commission_amount: 280,
    };
    const result = auditInvoiceRow(invoice, null);
    expect(result.rate_card_status).toBe('not_configured');
    expect(result.expected_commission_pct).toBeNull();
  });

  it('detects matched rate card commission', () => {
    const invoice = {
      invoice_amount: 1000,
      quantity: 1,
      selling_price: 1000,
      commission_pct: 28,
      commission_amount: 280,
      invoice_date: '2026-08-15',
    };
    const rc = {
      commission: [
        { priceMin: 0, priceMax: 999999, rate: 0.28, startDate: '2026-01-01', endDate: null },
      ],
    };
    const result = auditInvoiceRow(invoice, rc);
    expect(result.rate_card_status).toBe('matched');
    expect(result.expected_commission_pct).toBe(28);
    expect(result.expected_commission_amount).toBe(280);
    expect(result.commission_variance).toBe(0);
  });

  it('detects commission overcharge when actual fee exceeds rate card', () => {
    const invoice = {
      invoice_amount: 1000,
      quantity: 1,
      selling_price: 1000,
      commission_pct: 35,
      commission_amount: 350,
      invoice_date: '2026-08-15',
    };
    const rc = {
      commission: [
        { priceMin: 0, priceMax: 999999, rate: 0.28, startDate: '2026-01-01', endDate: null },
      ],
    };
    const result = auditInvoiceRow(invoice, rc);
    expect(result.rate_card_status).toBe('overcharged');
    expect(result.expected_commission_pct).toBe(28);
    expect(result.expected_commission_amount).toBe(280);
    expect(result.commission_variance).toBe(70);
  });

  it('detects commission undercharge when actual fee is below rate card', () => {
    const invoice = {
      invoice_amount: 1000,
      quantity: 1,
      selling_price: 1000,
      commission_pct: 20,
      commission_amount: 200,
      invoice_date: '2026-08-15',
    };
    const rc = {
      commission: [
        { priceMin: 0, priceMax: 999999, rate: 0.28, startDate: '2026-01-01', endDate: null },
      ],
    };
    const result = auditInvoiceRow(invoice, rc);
    expect(result.rate_card_status).toBe('undercharged');
    expect(result.expected_commission_pct).toBe(28);
    expect(result.expected_commission_amount).toBe(280);
    expect(result.commission_variance).toBe(-80);
  });

  it('keeps an explicit zero commission as evidence instead of deriving a fee', () => {
    const result = auditInvoiceRow({
      invoice_amount: 1000,
      quantity: 1,
      selling_price: 1000,
      commission_pct: 28,
      commission_amount: 0,
      invoice_date: '2026-08-15',
    }, {
      commission: [{ priceMin: 0, priceMax: 999999, rate: 0.28, startDate: '2026-01-01', endDate: null }],
    });

    expect(result.rate_card_status).toBe('undercharged');
    expect(result.commission_variance).toBe(-280);
  });

  it('validates invoice cells before import and preserves explicit zero deductions', () => {
    const parsed = parseInvoiceUploadRow({
      'Invoice Number': 'INV-101',
      'Invoice Date': '24/08/2026',
      SKU: 'SKU-1',
      Quantity: '2',
      'Invoice Amount': '₹1,000.00',
      'Commission %': '10',
      'Commission Amount': '0',
      'Payment Reference': 'NEFT-1',
    }, { marketplace: 'myntra', sellerAccount: 'myntra_vb', batch: 'batch-1' });

    expect(parsed.error).toBeUndefined();
    expect(parsed.values[3]).toBe('2026-08-24');
    expect(parsed.values[7]).toBe(2);
    expect(parsed.values[10]).toBe(1000);
    expect(parsed.values[12]).toBe(0);
    expect(parsed.fingerprint).toBe(invoiceSourceFingerprint({
      marketplace: 'myntra', sellerAccount: 'myntra_vb', invoiceNumber: 'INV-101',
      invoiceDate: '2026-08-24', sku: 'SKU-1', paymentReference: 'NEFT-1',
    }));

    expect(parseInvoiceUploadRow({
      'Invoice Number': 'INV-102',
      'Invoice Date': '2026-08-24',
      'Invoice Amount': 'not-a-number',
    }, { marketplace: 'myntra', sellerAccount: 'myntra_vb', batch: 'batch-1' }).error)
      .toContain('invalid invoice amount');
  });

  it('rejects impossible money and payment-status combinations', () => {
    const base = {
      'Invoice Number': 'INV-103',
      'Invoice Date': '2026-08-24',
      'Invoice Amount': '1000',
    };
    const options = { marketplace: 'myntra', sellerAccount: 'myntra_vb', batch: 'batch-1' };

    expect(parseInvoiceUploadRow({ ...base, 'Amount Received': '-1' }, options).error)
      .toContain('amount received cannot be negative');
    expect(parseInvoiceUploadRow({ ...base, Status: 'Paid' }, options).error)
      .toContain('does not match amount received');
    expect(parseInvoiceUploadRow({ ...base, Status: 'Unknown status' }, options).error)
      .toContain('invalid payment status');
  });
});
