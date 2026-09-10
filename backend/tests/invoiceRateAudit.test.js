import { describe, expect, it } from 'vitest';
import {
  auditInvoiceRow,
  invoiceSourceFingerprint,
  parseInvoiceUploadRow,
  validateMyntraInvoiceSellerIds,
} from '../routes/mpSettlement.js';

// Realistic Myntra payment-export row (VB layout, seller id 10708).
const VB_PAYMENT_FORWARD = {
  'NEFT_Ref': 'NFT-/XUTR/DEUTH02609241522X',
  'taxable_amount': '1100',
  'customer_paid_amt': '1155',
  'Commission': '313.467',
  'TDS': '1.1',
  'Shipping_Fee': '0',
  'pick_and_pack_fee': '0',
  'fixed_fee': '49',
  'Payment_Gateway_Fee': '0',
  'Logistics_Commission': '57.82',
  'Settled_Amount': '777.113',
  'NOD_Comment': '',
  'Store_Order_id': "'132509375680735653501",
  'Payment_Date': '4/2/26',
  'order_line_id': '11034187800',
  'Order_Type': 'Forward',
  'order_release_id': '9033908466',
  'Packet_Id': '9033908466',
  'Seller_Id': '10708',
};
const VB_PAYMENT_REVERSE = {
  ...VB_PAYMENT_FORWARD,
  'taxable_amount': '1108.57',
  'Settled_Amount': '-1236.031',
  'Order_Type': 'Reverse',
  'order_line_id': '11027241590',
  'order_release_id': '9026962269',
  'return_id': '11027241590',
};

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

  it('marks a paid Myntra reverse row as paid instead of pending', () => {
    const parsed = parseInvoiceUploadRow({
      'Invoice Number': 'INV-104',
      'Invoice Date': '2026-08-24',
      'Invoice Amount': '1000',
      'Net Payable': '-900',
      'Amount Received': '-900',
      'Order Type': 'Reverse',
    }, { marketplace: 'myntra', sellerAccount: 'myntra_vb', batch: 'batch-1' });

    expect(parsed.error).toBeUndefined();
    expect(parsed.values[20]).toBe('Paid');
  });

  it('links Myntra payment rows to the order by Order Release ID and parses M/D/YY dates', () => {
    const parsed = parseInvoiceUploadRow(VB_PAYMENT_FORWARD, {
      marketplace: 'myntra', sellerAccount: 'myntra_vb', batch: 'batch-1',
    });
    expect(parsed.error).toBeUndefined();

    // The invoice number is the Order Release ID, the same value the Order
    // upload stores as orders.order_id.
    expect(parsed.values[2]).toBe('9033908466');
    // "4/2/26" is 2 April 2026 in the Myntra payment export (M/D/YY).
    expect(parsed.values[3]).toBe('2026-04-02');
    expect(parsed.values[18]).toBe('2026-04-02');
    // Commission is GST-inclusive in the file: 313.467 = 265.65 ex-GST + 47.82
    // GST, so the rate audit can compare 265.65 / taxable 1100 against the
    // rate card.
    expect(parsed.values[12]).toBeCloseTo(265.65, 2);
    // Logistics_Commission 57.82 is the GST-inclusive total of fixed_fee 49
    // (49 ex-GST + 8.82 GST). Actual payout deductions besides commission/TDS:
    // TCS 0 + 57.82 = 57.82.
    expect(parsed.values[15]).toBeCloseTo(57.82, 2);
    expect(parsed.values[16]).toBe(777.113);
    expect(parsed.values[17]).toBe(777.113);
    expect(parsed.values[20]).toBe('Paid');
    // Order linkage identities are retained for reconciliation.
    expect(parsed.values[23]).toBe('9033908466');
    expect(parsed.values[24]).toBe('11034187800');
    expect(parsed.values[25]).toBeNull();
    // The settlement type feeds the unified_settlements Myntra branch.
    expect(parsed.values[26]).toBe('forward');
    // Itemized GST-free fee components.
    expect(parsed.values[27]).toBe(0);            // tcs_amount
    expect(parsed.values[28]).toBe(49);           // fixed_fee_amount (ex-GST)
    expect(parsed.values[29]).toBe(0);            // shipping_fee_amount
    expect(parsed.values[30]).toBe(0);            // pick_pack_fee_amount
    expect(parsed.values[31]).toBe(0);            // gateway_fee_amount
    expect(parsed.values[32]).toBeCloseTo(56.64, 2); // GST on commission + fees
  });

  it('keeps every settlement of one order distinct, including Forward + Reverse pairs', () => {
    const options = { marketplace: 'myntra', sellerAccount: 'myntra_vb', batch: 'batch-1' };
    const forward = parseInvoiceUploadRow(VB_PAYMENT_FORWARD, options);
    const reverse = parseInvoiceUploadRow(VB_PAYMENT_REVERSE, options);
    expect(forward.error).toBeUndefined();
    expect(reverse.error).toBeUndefined();
    expect(forward.fingerprint).not.toBe(reverse.fingerprint);

    // Two different order lines of the same release and NEFT must not be
    // treated as duplicate invoice lines within one file.
    const secondLine = parseInvoiceUploadRow(
      { ...VB_PAYMENT_FORWARD, 'order_line_id': '11099988877' },
      options,
    );
    expect(secondLine.fingerprint).not.toBe(forward.fingerprint);

    // Re-importing the very same settlement row stays idempotent.
    const again = parseInvoiceUploadRow(VB_PAYMENT_FORWARD, options);
    expect(again.fingerprint).toBe(forward.fingerprint);
  });

  it('treats a settled Myntra reverse refund row as a paid negative settlement', () => {
    const parsed = parseInvoiceUploadRow(VB_PAYMENT_REVERSE, {
      marketplace: 'myntra', sellerAccount: 'myntra_vb', batch: 'batch-1',
    });
    expect(parsed.error).toBeUndefined();
    // Reverse rows keep their negative settled amount and refund identity.
    expect(parsed.values[16]).toBe(-1236.031);
    expect(parsed.values[17]).toBe(-1236.031);
    expect(parsed.values[20]).toBe('Paid');
    expect(parsed.values[23]).toBe('9026962269');
    expect(parsed.values[24]).toBe('11027241590');
    expect(parsed.values[25]).toBe('11027241590');
    expect(parsed.values[26]).toBe('reverse');
    // Commission and TDS come back as credits (negative); reverse shipping and
    // its GST remain charges (positive).
    expect(parsed.values[12]).toBeCloseTo(-265.65, 2);
    expect(parsed.values[14]).toBeCloseTo(-1.1, 2);
    expect(parsed.values[28]).toBe(49);               // fixed_fee_amount
    expect(parsed.values[32]).toBeCloseTo(-39.0, 2);   // -47.82 GST refund + 8.82 fee GST
  });

  it('accepts NOD non-order deduction rows with their negative settled amounts', () => {
    const parsed = parseInvoiceUploadRow({
      'NEFT_Ref': 'NFT-/XUTR/DEUTH02611017239X',
      'Settled_Amount': '-208847',
      'NOD_Comment': 'SplitNOD16Apr20262891MI',
      'Payment_Date': '4/16/26',
      'Order_Type': 'NOD',
      'Seller_Id': '10708',
    }, { marketplace: 'myntra', sellerAccount: 'myntra_vb', batch: 'batch-1' });
    expect(parsed.error).toBeUndefined();
    // NOD rows carry no order linkage; the NOD reference identifies the line.
    expect(parsed.values[2]).toBe('SplitNOD16Apr20262891MI');
    expect(parsed.values[16]).toBe(-208847);
    expect(parsed.values[17]).toBe(-208847);
    expect(parsed.values[20]).toBe('Paid');
    expect(parsed.values[26]).toBe('nod');
  });

  it('accepts real Date cells from cellDates:true workbooks, not just text dates', () => {
    // The upload route reads Myntra payment workbooks with cellDates:true, so
    // date columns arrive as JS Date objects. MDY text parsing must not turn
    // them into "invoice date is empty or invalid" skips.
    const parsed = parseInvoiceUploadRow({
      ...VB_PAYMENT_FORWARD,
      'Invoice_Date': new Date(Date.UTC(2026, 3, 2, 6, 0, 0)), // Apr 2, 2026
      'Payment_Date': new Date(Date.UTC(2026, 3, 2, 6, 0, 0)),
    }, { marketplace: 'myntra', sellerAccount: 'myntra_vb', batch: 'batch-1' });
    expect(parsed.error).toBeUndefined();
    expect(parsed.values[3]).toBe('2026-04-02');
    expect(parsed.values[18]).toBe('2026-04-02');
  });

  it('rejects a VB payment file imported under the EJ account before any data is saved', () => {
    expect(() => validateMyntraInvoiceSellerIds([VB_PAYMENT_FORWARD], 'myntra_ej'))
      .toThrow('Wrong Myntra account selected');
    expect(() => validateMyntraInvoiceSellerIds([VB_PAYMENT_FORWARD], 'myntra_vb')).not.toThrow();
  });
});
