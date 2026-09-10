import { describe, expect, it } from 'vitest';
import { classifyMyntraNod, summarizeMyntraNod } from '../services/myntraNodClassification.js';

describe('Myntra NOD Classification and Categorization', () => {
  it('classifies SPF and claims reimbursement as spf category (credit)', () => {
    const c1 = classifyMyntraNod('100075606098', 'ForwardAutoSPF', 149.25);
    expect(c1.category).toBe('spf');
    expect(c1.isCredit).toBe(true);

    const c2 = classifyMyntraNod('131842582298502000000', 'spf_rbnr', 1122.23);
    expect(c2.category).toBe('spf');
    expect(c2.isCredit).toBe(true);

    const c3 = classifyMyntraNod('PPMP26RNRAPR2SPF', 'PPMP26RNRAPR2SPF', 21153.79);
    expect(c3.category).toBe('spf');
    expect(c3.isCredit).toBe(true);
  });

  it('classifies Credit Notes (M27KACN) as credit_note category (credit)', () => {
    const cn = classifyMyntraNod('M27KACN019496250526', 'M27KACN019496250526', 92.50);
    expect(cn.category).toBe('credit_note');
    expect(cn.isCredit).toBe(true);
  });

  it('classifies Tax Invoices (M27KAIN) as service_tax_invoice category (debit)', () => {
    const inv = classifyMyntraNod('M27KAIN267980210726', 'M27KAIN267980210726', -185636.42);
    expect(inv.category).toBe('service_tax_invoice');
    expect(inv.isCredit).toBe(false);
  });

  it('classifies Split NOD remittance rows as split_nod category (debit)', () => {
    const split = classifyMyntraNod('SplitNOD17Jun20263358MI', 'SplitNOD17Jun20263358MI', -706114.00);
    expect(split.category).toBe('split_nod');
    expect(split.isCredit).toBe(false);
  });

  it('classifies Marketing and Incentive deductions as marketing category', () => {
    const mkt = classifyMyntraNod('MKT-INV-2026', 'Marketing promotion and seller ad spend incentive', -50000);
    expect(mkt.category).toBe('marketing');
    expect(mkt.isCredit).toBe(false);
  });

  it('classifies Myntra Fashion Brand deductions as mfb category', () => {
    const mfb = classifyMyntraNod('MFB-FEES-JUN', 'Myntra Fashion Brand franchise fee royalty', -75000);
    expect(mfb.category).toBe('mfb');
    expect(mfb.isCredit).toBe(false);
  });

  it('classifies First Mile logistics reimbursement as logistics_reimb category (credit)', () => {
    const fm = classifyMyntraNod('FMReimb0526FM', 'FMReimb0526FM', 7023.00);
    expect(fm.category).toBe('logistics_reimb');
    expect(fm.isCredit).toBe(true);
  });

  it('computes structured summary with summarizeMyntraNod', () => {
    const rows = [
      { invoice_number: '1001', notes: 'ForwardAutoSPF', amount_received: 200 },
      { invoice_number: 'M27KACN001', notes: '', amount_received: 500 },
      { invoice_number: 'M27KAIN001', notes: '', amount_received: -1000 },
      { invoice_number: 'SplitNOD01', notes: '', amount_received: -2000 },
      { invoice_number: 'MKT01', notes: 'marketing campaign fee', amount_received: -400 },
      { invoice_number: 'MFB01', notes: 'mfb brand royalty fee', amount_received: -300 },
    ];

    const summary = summarizeMyntraNod(rows);
    expect(summary.totalRows).toBe(6);
    expect(summary.totalCredits).toBe(700);
    expect(summary.totalDebits).toBe(3700);
    expect(summary.netTotal).toBe(-3000);
    expect(summary.spfCount).toBe(1);
    expect(summary.spfTotal).toBe(200);
    expect(summary.creditNotesCount).toBe(1);
    expect(summary.creditNotesTotal).toBe(500);
    expect(summary.serviceInvoicesCount).toBe(1);
    expect(summary.serviceInvoicesTotal).toBe(-1000);
    expect(summary.splitNodCount).toBe(1);
    expect(summary.splitNodTotal).toBe(-2000);
    expect(summary.marketingCount).toBe(1);
    expect(summary.marketingTotal).toBe(-400);
    expect(summary.mfbCount).toBe(1);
    expect(summary.mfbTotal).toBe(-300);
  });
});
