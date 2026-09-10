/**
 * Classification and categorization utility for Myntra Non-Order Deductions (NOD).
 * Classifies deductions and credits into structured categories:
 * - Marketing & Incentive Deductions
 * - Myntra Fashion Brand (MFB) / Franchise Fee Deductions
 * - Myntra Service / Tax Invoices (Debit Invoices)
 * - Split NOD Remittance Deductions
 * - Seller Protection Fund (SPF) Claim Credits
 * - Credit Notes (CN) / Fee Adjustments
 * - Logistics / First Mile Reimbursements
 * - Other Non-Order Adjustments
 */

export function classifyMyntraNod(invoiceNumber = '', notes = '', amountReceived = 0) {
  const inv = String(invoiceNumber || '').trim();
  const note = String(notes || '').trim();
  const text = `${inv} ${note}`.toLowerCase();
  const val = Number(amountReceived || 0);

  // SPF / Protection Fund / Lost or Damaged Product Claims (Credits)
  if (text.includes('spf') || text.includes('rbnr') || text.includes('safe-t')) {
    return {
      category: 'spf',
      categoryLabel: 'SPF Claim / Protection Reimbursement',
      isCredit: val > 0,
      description: note || inv || 'SPF Reimbursement',
    };
  }

  // First Mile / Logistics Reimbursements (Credits)
  if (text.includes('fmreimb') || text.includes('first mile') || text.includes('reimb')) {
    return {
      category: 'logistics_reimb',
      categoryLabel: 'Logistics / First Mile Reimbursement',
      isCredit: val > 0,
      description: note || inv || 'Logistics Reimbursement',
    };
  }

  // Credit Notes (CN) - adjustments credited back to seller
  if (inv.startsWith('M27KACN') || (val > 0 && (inv.includes('CN') || note.includes('CN')))) {
    return {
      category: 'credit_note',
      categoryLabel: 'Credit Note (CN)',
      isCredit: true,
      description: note || inv || 'Credit Note Adjustment',
    };
  }

  // Marketing, Promotions, Incentives, Ads spend
  if (
    text.includes('market') ||
    text.includes('ad_spend') ||
    text.includes('advertising') ||
    text.includes('campaign') ||
    text.includes('promo') ||
    text.includes('incentive')
  ) {
    return {
      category: 'marketing',
      categoryLabel: 'Marketing & Incentive Deduction',
      isCredit: val > 0,
      description: note || inv || 'Marketing & Incentive Deduction',
    };
  }

  // Myntra Fashion Brand (MFB) / Brand / Royalty / Franchise Fees
  if (
    text.includes('mfb') ||
    text.includes('brand') ||
    text.includes('franchise') ||
    text.includes('royalty')
  ) {
    return {
      category: 'mfb',
      categoryLabel: 'Myntra Fashion Brand (MFB) Fee',
      isCredit: val > 0,
      description: note || inv || 'Myntra Fashion Brand (MFB) Fee',
    };
  }

  // Myntra Tax Invoices (Debit Invoices e.g. M27KAIN...)
  // In Myntra settlement exports, M27KAIN represents tax invoices issued by Myntra Karnataka
  // for platform fees, marketing retainers, and MFB brand services.
  if (inv.startsWith('M27KAIN')) {
    return {
      category: 'service_tax_invoice',
      categoryLabel: 'Myntra Platform / MFB / Service Invoice',
      isCredit: val > 0,
      description: note || inv || 'Myntra Service Tax Invoice (Debit)',
    };
  }

  // Split NOD Remittance Deductions (SplitNOD...)
  if (inv.startsWith('SplitNOD') || note.startsWith('SplitNOD') || text.includes('splitnod')) {
    return {
      category: 'split_nod',
      categoryLabel: 'Split NOD Remittance Deduction',
      isCredit: val > 0,
      description: note || inv || 'Split NOD Deduction',
    };
  }

  // Penalties / SLA Breaches / Cancellation fines
  if (text.includes('penalty') || text.includes('sla') || text.includes('breach')) {
    return {
      category: 'penalty',
      categoryLabel: 'Penalty / SLA Breach',
      isCredit: val > 0,
      description: note || inv || 'Penalty / SLA Deduction',
    };
  }

  // Logistics adjustments / Other
  if (text.includes('logistic')) {
    return {
      category: 'logistics_fee',
      categoryLabel: 'Logistics Adjustment',
      isCredit: val > 0,
      description: note || inv || 'Logistics Fee Adjustment',
    };
  }

  return {
    category: 'other_nod',
    categoryLabel: 'Other Non-Order Deduction',
    isCredit: val > 0,
    description: note || inv || 'Non-Order Deduction',
  };
}

export function summarizeMyntraNod(rows = []) {
  const summary = {
    totalRows: 0,
    netTotal: 0,
    totalCredits: 0,
    totalDebits: 0,
    marketingTotal: 0,
    marketingCount: 0,
    mfbTotal: 0,
    mfbCount: 0,
    serviceInvoicesTotal: 0,
    serviceInvoicesCount: 0,
    splitNodTotal: 0,
    splitNodCount: 0,
    spfTotal: 0,
    spfCount: 0,
    creditNotesTotal: 0,
    creditNotesCount: 0,
    logisticsReimbTotal: 0,
    logisticsReimbCount: 0,
    otherTotal: 0,
    otherCount: 0,
  };

  for (const r of rows) {
    const val = Number(r.settlement_value || r.amount_received || 0);
    const classification = classifyMyntraNod(r.invoice_number, r.description || r.notes, val);
    summary.totalRows++;
    summary.netTotal += val;

    if (val >= 0) {
      summary.totalCredits += val;
    } else {
      summary.totalDebits += Math.abs(val);
    }

    switch (classification.category) {
      case 'marketing':
        summary.marketingCount++;
        summary.marketingTotal += val;
        break;
      case 'mfb':
        summary.mfbCount++;
        summary.mfbTotal += val;
        break;
      case 'service_tax_invoice':
        summary.serviceInvoicesCount++;
        summary.serviceInvoicesTotal += val;
        break;
      case 'split_nod':
        summary.splitNodCount++;
        summary.splitNodTotal += val;
        break;
      case 'spf':
        summary.spfCount++;
        summary.spfTotal += val;
        break;
      case 'credit_note':
        summary.creditNotesCount++;
        summary.creditNotesTotal += val;
        break;
      case 'logistics_reimb':
        summary.logisticsReimbCount++;
        summary.logisticsReimbTotal += val;
        break;
      default:
        summary.otherCount++;
        summary.otherTotal += val;
        break;
    }
  }

  // Round all totals to 2 decimal places
  for (const k of Object.keys(summary)) {
    if (typeof summary[k] === 'number' && !k.endsWith('Count') && !k.endsWith('Rows')) {
      summary[k] = Math.round(summary[k] * 100) / 100;
    }
  }

  return summary;
}
