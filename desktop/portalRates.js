// Parsed only from the observed /orchestrator/graphql settlement contract.
// Every monetary value remains tied to its request and original response.
const AGREEMENT_PARAMETERS = new Set([
  'fixedRate', 'prepaid', 'postpaid', 'startSlab', 'incrementalSlab', 'localFee', 'zonalFee', 'nationalFee',
  'localAdditionalCharges', 'zonalAdditionalCharges', 'nationalAdditionalCharges'
]);

// Fail closed if Seller Hub adds a field so a fee is never silently dropped.
function assertSupportedAgreementParameters(fees) {
  const unsupported = new Set();
  const visit = value => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'agreementParameters')) {
      const parameters = value.agreementParameters;
      if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
        throw new Error('Malformed Seller Hub agreementParameters object.');
      }
      for (const name of Object.keys(parameters)) {
        if (!AGREEMENT_PARAMETERS.has(name)) unsupported.add(name);
      }
    }
    for (const [key, nested] of Object.entries(value)) {
      if (key !== 'agreementParameters') visit(nested);
    }
  };

  visit(fees);
  if (unsupported.size) {
    throw new Error(`Unsupported Seller Hub agreement parameter(s): ${[...unsupported].sort().join(', ')}.`);
  }
}

const amount = (value, unit) => {
  const text = String(value ?? '').replace(/,/g, '').trim();
  const expression = unit === 'kg' ? /^(\d+(?:\.\d+)?)kg$/ : unit === '%' ? /^(\d+(?:\.\d+)?)%$/ : /^₹(\d+(?:\.\d+)?)$/;
  const match = text.match(expression);
  if (!match) throw new Error(`Invalid ${unit} value in Seller Hub rate response.`);
  return Number(match[1]);
};
const price = slab => ({ price_min: amount(slab.start, '₹'), price_max: amount(slab.end, '₹') });
const payment = value => String(value).endsWith('%')
  ? { value: amount(value, '%') / 100, type: 'pct' } : { value: amount(value, '₹'), type: 'flat' };

function shipping(fee, fulfilment, allPrices = false) {
  if (!Array.isArray(fee?.slabs?.shippingSlab) || !fee.slabs.shippingSlab.length) throw new Error('Missing shipping weight slabs.');
  return fee.slabs.shippingSlab.flatMap(weight => {
    const weight_min = amount(weight.start, 'kg'), weight_max = amount(weight.end, 'kg');
    if (weight_max <= weight_min) throw new Error('Invalid shipping weight range.');
    const asps = allPrices ? [{ agreementParameters: weight.agreementParameters }] : weight.asp;
    if (!Array.isArray(asps) || !asps.length) throw new Error('Missing shipping price slabs.');
    return asps.map(slab => {
      const p = slab.agreementParameters;
      return { ...(allPrices ? { price_min: 0, price_max: 999999, price_scope: 'all' } : price(slab)),
        fulfilment_type: fulfilment, weight_min, weight_max, weight_slab: `${weight_min}kg-${weight_max}kg`,
        base_weight: amount(p.startSlab, 'kg'), increment_weight: amount(p.incrementalSlab, 'kg'),
        local_fee: amount(p.localFee, '₹'), zonal_fee: amount(p.zonalFee, '₹'), national_fee: amount(p.nationalFee, '₹'),
        local_additional_fee: amount(p.localAdditionalCharges, '₹'), zonal_additional_fee: amount(p.zonalAdditionalCharges, '₹'),
        national_additional_fee: amount(p.nationalAdditionalCharges, '₹') };
    });
  });
}

export function parsePortalRateSnapshot(snapshot, { vertical, marketplace, fulfilment, effectiveDate, portalVertical, brand, fsn, sku, orderCount, sellerAccount = 'default' }) {
  if (snapshot.missing.length) throw new Error(`Incomplete rate response: ${snapshot.missing.join(', ')}.`);
  const normalizedSellerAccount = String(sellerAccount || 'default').trim() || 'default';
  const { fees } = snapshot;
  assertSupportedAgreementParameters(fees);
  const asps = key => {
    const rows = fees[key]?.slabs?.asp;
    if (!Array.isArray(rows) || !rows.length) throw new Error(`Missing ${key} price slabs.`);
    return rows;
  };
  const card = { marketplace, vertical, category: vertical, brand, seller_account: normalizedSellerAccount, sample_fsn: fsn, sample_sku: sku, order_count: orderCount, effectiveDate, fulfilment_type: fulfilment,
    commissions: asps('platformFee').map(row => ({ ...price(row), rate: amount(row.agreementParameters.fixedRate, '%') / 100 })),
    fixedFees: asps('closingFee').map(row => ({ ...price(row), rate: amount(row.agreementParameters.fixedRate, '₹'), fulfilment_type: fulfilment })),
    collectionFees: asps('collectionFee').map(row => {
      const prepaid = payment(row.agreementParameters.prepaid), postpaid = payment(row.agreementParameters.postpaid);
      return { ...price(row), prepaid: prepaid.value, postpaid: postpaid.value, prepaid_type: prepaid.type, postpaid_type: postpaid.type, fulfilment_type: 'ALL' };
    }),
    reverseShipping: shipping(fees.reverseShippingFee, 'ALL'),
    pickPackFees: fulfilment === 'FBF' ? shipping(fees.pickAndPackFee, 'FBF', true) : [],
    portalEvidence: { portalVertical, fsn, sellerTier: snapshot.sellerTier, fulfilment, fees }
  };
  for (const field of ['commissions','fixedFees','collectionFees','reverseShipping','pickPackFees']) {
    if (card[field].some(row => row.price_max < row.price_min)) throw new Error(`Reversed ${field} price range.`);
  }
  return card;
}
