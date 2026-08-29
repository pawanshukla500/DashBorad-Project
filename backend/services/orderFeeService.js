import { getRateCard, calculateFees } from './rateCard.js';

/**
 * Computes fees for a batch of order rows based on rate cards.
 * @param {Array} orders - Array of order objects.
 * @returns {Promise<Array>} - Array of orders with attached fee properties.
 */
export async function attachRcFees(orders) {
  if (!orders || orders.length === 0) return orders;

  // Collect unique marketplace+account combos
  const keys = [...new Set(orders.map(o => `${o.marketplace || 'flipkart'}:${o.sellerAccount || o.seller_account || 'default'}`))];

  // Load each rate card (cached internally — fast)
  const rcMap = {};
  await Promise.all(keys.map(async key => {
    const [mp, acct] = key.split(':');
    rcMap[key] = await getRateCard(mp, acct).catch(() => null);
  }));

  return orders.map(o => {
    const mp   = o.marketplace || 'flipkart';
    const acct = o.sellerAccount || o.seller_account || 'default';
    const rc   = rcMap[`${mp}:${acct}`];
    if (!rc) return { ...o, rcFees: null };

    const fees = calculateFees(rc, {
      category:      o.category,
      price:         mp === 'myntra' ? (parseFloat(o.totalShareAmount || o.total_share_amount) || 0) : (parseFloat(o.finalInvoiceAmount || o.invoiceAmount || o.final_invoice_amount) || 0),
      fulfilmentType:o.fulfilmentType || o.fulfilment_type,
      zone:          o.shippingZone   || o.shipping_zone || 'national',
      paymentType:   o.orderType      || o.order_type || 'prepaid',
      orderDate:     o.orderDate      || o.order_date,
      isReturn:      false,
    });

    const cogs         = parseFloat(o.cogs) || 0;
    const rcTotalFees  = fees.totalFees || 0;
    const price        = fees.price || 0;
    const rcProfit     = +(price - rcTotalFees - cogs).toFixed(2);
    const rcMarginPct  = price > 0 ? +((rcProfit / price) * 100).toFixed(2) : 0;

    return {
      ...o,
      rcCommission:    fees.commission,
      rcFixedFee:      fees.fixedFee,
      rcCollectionFee: fees.collectionFee,
      rcPickPack:      fees.pickPack,
      rcGstOnFees:     fees.gstOnFees,
      rcTotalFees:     +rcTotalFees.toFixed(2),
      rcNetToSeller:   fees.netToSeller,
      rcProfit,
      rcMarginPct,
      rcCommissionRate: fees.commissionRate,
    };
  });
}
