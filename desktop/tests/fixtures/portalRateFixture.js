// Synthetic amounts in the exact structure observed on 2026-10-30. These are
// test data, never policy defaults or a source of production fees.
export function rateFixture(mode = 'NON_FBF') {
  const asp = parameters => ({ start: '₹0', end: '₹10000000', agreementParameters: parameters });
  const shipping = { localFee: '₹11', zonalFee: '₹22', nationalFee: '₹33',
    localAdditionalCharges: '₹2', zonalAdditionalCharges: '₹3', nationalAdditionalCharges: '₹4', startSlab: '0kg', incrementalSlab: '0.5kg' };
  const fees = {
    platformFee: { serviceProfile: mode, slabs: { asp: [asp({ fixedRate: '12.3456%' })] } },
    closingFee: { serviceProfile: mode, slabs: { asp: [asp({ fixedRate: '₹7' })] } },
    collectionFee: { serviceProfile: mode, slabs: { asp: [asp({ prepaid: '0.3456%', postpaid: '₹8' })] } },
    reverseShippingFee: { serviceProfile: mode, slabs: { shippingSlab: [{ start: '0kg', end: '0.5kg', asp: [asp(shipping)] }] } }
  };
  if (mode === 'FBF') fees.pickAndPackFee = { serviceProfile: mode, slabs: { shippingSlab: [{ start: '0kg', end: '50000kg', agreementParameters: shipping }] } };
  return { fees, sellerTier: 'fixture', missing: [] };
}
