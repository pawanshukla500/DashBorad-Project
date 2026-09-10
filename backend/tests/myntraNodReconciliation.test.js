import { describe, expect, it } from 'vitest';
import { parseInvoiceUploadRow } from '../routes/mpSettlement.js';

describe('Myntra NOD (Non-Order Deduction / Credit) parsing', () => {
  const options = { marketplace: 'myntra', sellerAccount: 'myntra_vb', batch: 'batch-test' };

  it('accepts negative NOD deduction rows when NOD_Comment is present', () => {
    const nodRow = {
      'NEFT_Ref': 'NFT-/XUTR/DEUTH02609241522X',
      'taxable_amount': '0',
      'customer_paid_amt': '0',
      'Commission': '0',
      'TDS': '0',
      'Shipping_Fee': '0',
      'pick_and_pack_fee': '0',
      'fixed_fee': '0',
      'Payment_Gateway_Fee': '0',
      'Logistics_Commission': '0',
      'Settled_Amount': '-450.50',
      'NOD_Comment': 'Penalty for late dispatch - SplitNOD',
      'Store_Order_id': '',
      'Payment_Date': '4/2/26',
      'order_line_id': '',
      'Order_Type': '',
      'order_release_id': '',
      'Seller_Id': '10708',
    };

    const parsed = parseInvoiceUploadRow(nodRow, options);
    expect(parsed.error).toBeUndefined();
    // In parsed.values:
    // index 2: invoice_number should use NOD_Comment or generated
    expect(parsed.values[2]).toBe('Penalty for late dispatch - SplitNOD');
    // index 17: amount_received should be -450.50
    expect(parsed.values[17]).toBe(-450.50);
    // index 21: notes should contain NOD_Comment
    expect(parsed.values[21]).toBe('Penalty for late dispatch - SplitNOD');
    // index 26: order_type should be 'nod'
    expect(parsed.values[26]).toBe('nod');
  });

  it('accepts positive NOD credit rows', () => {
    const creditRow = {
      'NEFT_Ref': 'NFT-/XUTR/CREDIT12345',
      'taxable_amount': '0',
      'customer_paid_amt': '0',
      'Settled_Amount': '1200.00',
      'NOD_Comment': 'Lost in transit claim reimbursement',
      'Payment_Date': '4/2/26',
      'Seller_Id': '10708',
    };

    const parsed = parseInvoiceUploadRow(creditRow, options);
    expect(parsed.error).toBeUndefined();
    expect(parsed.values[17]).toBe(1200);
    expect(parsed.values[21]).toBe('Lost in transit claim reimbursement');
    expect(parsed.values[26]).toBe('nod');
  });
});
