// Parsed only from the observed /orchestrator/graphql settlement contract.
// Every monetary value remains tied to its request and original response.
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

export function parsePortalRateSnapshot(snapshot, { vertical, marketplace, fulfilment, effectiveDate, portalVertical, brand, fsn, sku, orderCount }) {
  if (snapshot.missing.length) throw new Error(`Incomplete rate response: ${snapshot.missing.join(', ')}.`);
  const { fees } = snapshot;
  const asps = key => {
    const rows = fees[key]?.slabs?.asp;
    if (!Array.isArray(rows) || !rows.length) throw new Error(`Missing ${key} price slabs.`);
    return rows;
  };
  const card = { marketplace, vertical, brand, sample_fsn: fsn, sample_sku: sku, order_count: orderCount, effectiveDate, fulfilment_type: fulfilment,
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
