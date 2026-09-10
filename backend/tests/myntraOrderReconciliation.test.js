import { describe, expect, it } from 'vitest';
import { parseInvoiceUploadRow } from '../routes/mpSettlement.js';

describe('Myntra VB & EJ Order Reconciliation & Fee Logic', () => {
  const forwardRow = {
    'Order_Release_Id': '100013851148',
    'Order_Line_Id': '11068579958',
    'Customer_Paid_Amt': '1507',
    'Taxable_Amount': '1435.24',
    'Commission': '283.919',
    'IGST_TCS': '7.176',
    'TDS': '1.435',
    'Pick_and_Pack_Fee': '0',
    'Fixed_Fee': '45',
    'Logistics_Commission': '53.1',
    'Settled_Amount': '1161.37',
    'Order_Type': 'Forward',
    'Payment_Date': '2026-03-15',
    'Payment_Status': 'Paid',
    'NEFT_Ref': 'NEFT12345',
  };

  const reverseRow = {
    'Order_Release_Id': '100013851148',
    'Order_Line_Id': '11068579958',
    'Customer_Paid_Amt': '1507',
    'Taxable_Amount': '1435.24',
    'Commission': '283.919',
    'IGST_TCS': '7.176',
    'TDS': '1.435',
    'Shipping_Fee': '167',
    'Logistics_Commission': '197.06',
    'Settled_Amount': '-1411.53',
    'Order_Type': 'Reverse',
    'Payment_Date': '2026-03-20',
    'Payment_Status': 'Paid',
    'NEFT_Ref': 'NEFT67890',
  };

  it('correctly parses and calculates forward sale order fees and payout', () => {
    const parsed = parseInvoiceUploadRow(forwardRow, {
      marketplace: 'myntra',
      sellerAccount: 'myntra_vb',
      batch: 'b1',
    });

    expect(parsed.error).toBeUndefined();
    // Gross invoice amount matches customer paid amount
    expect(parsed.values[10]).toBe(1507);
    // Commission is ex-GST (283.919 / 1.18 = 240.61)
    expect(parsed.values[12]).toBeCloseTo(240.61, 2);
    // TDS
    expect(parsed.values[14]).toBeCloseTo(1.44, 2);
    // Amount received / forward payout
    expect(parsed.values[17]).toBe(1161.37);
    // TCS
    expect(parsed.values[27]).toBeCloseTo(7.18, 2);
    // Fixed fee (ex-GST)
    expect(parsed.values[28]).toBe(45);
    // Shipping fee (forward PPMP is 0)
    expect(parsed.values[29]).toBe(0);
    // Pick & pack (0 for PPMP)
    expect(parsed.values[30]).toBe(0);
    // GST on MP fees: 18% on commission (43.31) + 18% on fixed fee (8.10) = 51.41
    expect(parsed.values[32]).toBeCloseTo(51.41, 2);
  });

  it('correctly parses and reverses fees on return order', () => {
    const parsed = parseInvoiceUploadRow(reverseRow, {
      marketplace: 'myntra',
      sellerAccount: 'myntra_vb',
      batch: 'b1',
    });

    expect(parsed.error).toBeUndefined();
    // Invoice amount is reversed / negative customer refund
    expect(parsed.values[10]).toBe(-1507);
    // Commission refunded (negative)
    expect(parsed.values[12]).toBeCloseTo(-240.61, 2);
    // TDS refunded (negative)
    expect(parsed.values[14]).toBeCloseTo(-1.44, 2);
    // Reverse settlement payout
    expect(parsed.values[17]).toBe(-1411.53);
    // TCS refunded (negative)
    expect(parsed.values[27]).toBeCloseTo(-7.18, 2);
    // Return shipping fee (167 ex-GST, 197.06 with 18% GST)
    expect(parsed.values[29]).toBe(167);
    // GST: -43.31 commission GST refunded + 30.06 return shipping GST = -13.25
    expect(parsed.values[32]).toBeCloseTo(-13.25, 2);
  });

  it('accurately nets forward + reverse to exact payout of -250.16', () => {
    const fwd = parseInvoiceUploadRow(forwardRow, { marketplace: 'myntra', sellerAccount: 'myntra_vb', batch: 'b1' });
    const rev = parseInvoiceUploadRow(reverseRow, { marketplace: 'myntra', sellerAccount: 'myntra_vb', batch: 'b1' });

    const netBank = Math.round((fwd.values[17] + rev.values[17]) * 100) / 100;
    const netCommission = Math.round((fwd.values[12] + rev.values[12]) * 100) / 100;
    const netTcs = Math.round((fwd.values[27] + rev.values[27]) * 100) / 100;
    const netTds = Math.round((fwd.values[14] + rev.values[14]) * 100) / 100;
    const fixedFee = fwd.values[28];
    const reverseShipping = rev.values[29];
    const netGst = Math.round((fwd.values[32] + rev.values[32]) * 100) / 100;

    // Net bank payout must equal -250.16
    expect(netBank).toBe(-250.16);
    // Commission, TCS, TDS net to 0
    expect(netCommission).toBe(0);
    expect(netTcs).toBe(0);
    expect(netTds).toBe(0);
    // Incurred fees: fixed fee 45, reverse shipping 167, and net GST 38.16
    expect(fixedFee).toBe(45);
    expect(reverseShipping).toBe(167);
    expect(netGst).toBe(38.16);

    // Sum of expenses equals exactly 250.16
    const totalExpense = Math.round((fixedFee + reverseShipping + netGst) * 100) / 100;
    expect(totalExpense).toBe(250.16);
    expect(netBank).toBe(-totalExpense);
  });
});
