import { useEffect, useState } from 'react';
import { fetchOrderDetail } from '../api/client';
import { currencyFull, pct } from '../utils/format';

export default function OrderDetailDrawer({ orderItemId, onClose }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    if (!orderItemId) return;
    setLoading(true); setError(null); setData(null);
    fetchOrderDetail(orderItemId)
      .then(setData)
      .catch(e => setError(e?.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [orderItemId]);

  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  if (!orderItemId) return null;

  return (
    <>
      <button type="button" aria-label="Close order detail drawer" className="fixed inset-0 z-40 bg-primary/50 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed right-0 top-0 z-50 flex h-full w-full max-w-3xl flex-col overflow-hidden bg-surface shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="order-detail-title">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-surface-container-low shrink-0">
          <div>
            <p id="order-detail-title" className="text-xs text-secondary font-medium uppercase tracking-wider">Order Detail</p>
            <p className="text-sm font-mono text-ink mt-0.5 select-all">{orderItemId}</p>
          </div>
          <button type="button" aria-label="Close order detail drawer" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-outline transition-colors hover:bg-surface-container-high hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40">
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && <LoadingState />}
          {error   && <ErrorState msg={error} />}
          {data    && <DetailContent data={data} />}
        </div>
      </div>
    </>
  );
}

// ─── Clickable order item ID cell ────────────────────────────────────────────
export function OrderIdCell({ id, onOpen }) {
  if (!id) return <span className="text-outline">—</span>;
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      className="group rounded-sm text-left font-mono text-[10px] text-primary underline-offset-2 transition-colors hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-primary/40"
      title="Click to view full detail"
    >
      {id}
      <span className="material-symbols-outlined ml-1 align-middle text-[12px] opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true">open_in_new</span>
    </button>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────
function DetailContent({ data }) {
  const { order, returnInfo, settlementRows, bankReceived, refundAmount, settlementStatus, rcFees } = data;

  return (
    <div className="divide-y divide-slate-100">
      {/* Status Banner */}
      <div className={`px-6 py-3 flex items-center gap-2 ${STATUS_BG[settlementStatus] || 'bg-surface-container-low'}`}>
        <div className={`w-2 h-2 rounded-full ${STATUS_DOT[settlementStatus] || 'bg-surface-container-highest'}`} />
        <span className={`text-sm font-semibold ${STATUS_TEXT[settlementStatus] || 'text-secondary'}`}>
          {settlementStatus}
        </span>
        {bankReceived !== 0 && (
          <span className="ml-auto text-sm font-bold text-ink">
            Net: {bankReceived >= 0 ? '+' : ''}{currencyFull(bankReceived)}
          </span>
        )}
      </div>

      {/* Order Information */}
      <Section icon="inventory_2" title="Order Information">
        {order ? (
          <>
            <Grid2>
              <Field label="Order Date"    value={order.orderDate} />
              <Field label="Order ID"      value={order.orderId} mono />
              <Field label="Category"      value={<Tag color="indigo">{order.category}</Tag>} />
              <Field label="Fulfilment"    value={<Tag color="sky">{order.fulfilmentType}</Tag>} />
              <Field label="Channel"       value={order.sellingChannel} />
              <Field label="Status"        value={order.ordersStatus} />
              <Field label="State"         value={order.deliveryState} />
              <Field label="City"          value={order.deliveryCity} />
              <Field label="Pincode"       value={order.deliveryPincode} />
              <Field label="Quantity"      value={order.qty} />
              <Field label="Weight Slab"   value={order.weightSlab} />
              <Field label="Shipping Zone" value={order.shippingZone} />
              <Field label="SKU"           value={order.sku} mono />
              <Field label="Marketplace"   value={order.marketplace} />
            </Grid2>
            <div className="mt-4 grid grid-cols-3 gap-3">
              <AmountBox label="Sale Amount"     amount={+(order.finalInvoiceAmount || 0)} color="indigo" />
              <AmountBox label="My Share"        amount={+(order.myShare || 0)}            color="sky" />
              <AmountBox label="Settlement Recv" amount={bankReceived}                     color={bankReceived >= 0 ? 'emerald' : 'rose'} />
            </div>
          </>
        ) : (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-700">
            Order not found in orders table — this order may have been settled directly via FK settlement sheet.
            <div className="mt-2">
              <AmountBox label="Settlement Recv" amount={bankReceived} color={bankReceived >= 0 ? 'emerald' : 'rose'} />
            </div>
          </div>
        )}
      </Section>

      {/* NEFT Cycle Breakdown — FK-portal style */}
      {settlementRows.length > 0 && (
        <Section icon="account_balance" title="Settlement by NEFT Cycle">
          <NeftCycleTable rows={settlementRows} />
        </Section>
      )}

      {/* Return Details */}
      {returnInfo && (
        <Section icon="assignment_return" title="Return Details">
          <Grid2>
            <Field label="Return ID"      value={returnInfo.returnId} mono />
            <Field label="Return Type"    value={<Tag color={returnInfo.returnType?.includes('customer') ? 'orange' : 'purple'}>{(returnInfo.returnType || '').replace(/_/g, ' ')}</Tag>} />
            <Field label="Return Status"  value={<Tag color={returnInfo.returnStatus === 'completed' ? 'emerald' : returnInfo.returnStatus === 'cancelled' ? 'rose' : 'amber'}>{returnInfo.returnStatus}</Tag>} />
            <Field label="Result"         value={<Tag color={resultColor(returnInfo.returnResult)}>{returnInfo.returnResult}</Tag>} />
            <Field label="Return Reason"  value={(returnInfo.returnReason || '').replace(/_/g, ' ')} />
            <Field label="Sub-Reason"     value={(returnInfo.returnSubReason || '').replace(/_/g, ' ')} />
            <Field label="Requested"      value={returnInfo.returnRequestedDate} />
            <Field label="Approved"       value={returnInfo.returnApprovalDate} />
            <Field label="Completion"     value={(returnInfo.returnCompletionType || '').replace(/_/g, ' ')} />
            <Field label="Expectation"    value={(returnInfo.returnExpectation || '').replace(/_/g, ' ')} />
            <Field label="Qty Returned"   value={returnInfo.quantity} />
            {returnInfo.finalCondition && <Field label="Condition" value={returnInfo.finalCondition} />}
            {returnInfo.primaryPvOutput && <Field label="PV Output" value={returnInfo.primaryPvOutput} />}
          </Grid2>
          {refundAmount > 0 && (
            <div className="mt-3">
              <AmountBox label="Refund Debited from Account" amount={refundAmount} color="rose" />
            </div>
          )}
        </Section>
      )}

      {/* RC Fee Comparison */}
      {order && (
        <Section icon="calculate" title="FK Charged vs Our Rate Card">
          <RcFeeComparison rcFees={rcFees} settlementRows={settlementRows} order={order} />
        </Section>
      )}

      {/* No settlement note */}
      {settlementRows.length === 0 && (
        <Section icon="hourglass_empty" title="Settlement">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-center">
            <p className="text-amber-700 font-semibold text-sm">No settlement found for this order</p>
            <p className="text-amber-600 text-xs mt-1">This order has not yet been processed in any NEFT payment cycle by Flipkart.</p>
          </div>
        </Section>
      )}
    </div>
  );
}

// ─── RC Fee Comparison ────────────────────────────────────────────────────────
function RcFeeComparison({ rcFees, settlementRows, order }) {
  // FK actual fees: sum over forward settlement rows (bankSettlement > 0)
  const fwd = settlementRows.filter(r => +(r.bankSettlement || 0) > 0);
  const fkSum = key => fwd.reduce((s, r) => s + Math.abs(+(r[key] || 0)), 0);

  const fkComm    = fkSum('commission');
  const fkFixed   = fkSum('fixedFee');
  const fkColl    = fkSum('collectionFee');
  const fkPP      = fkSum('pickPackFee');
  const fkFranch  = fkSum('franchiseFee');
  const fkGst     = fkSum('gstOnMpFees');
  const fkTcs     = fkSum('tcs');
  const fkTds     = fkSum('tds');
  const fkTotal   = fkComm + fkFixed + fkColl + fkPP + fkFranch + fkGst + fkTcs + fkTds;

  const price     = +(order?.finalInvoiceAmount || 0);

  // When there are no forward settlement rows yet, FK actuals will all be 0
  const hasSettled = fwd.length > 0;

  if (!rcFees?.configured) {
    return (
      <div className="bg-surface-container-low border border-border rounded-xl p-4 text-center">
        <p className="text-secondary text-sm font-medium">Rate Card not configured</p>
        <p className="text-outline text-xs mt-1">Set up your Rate Card to see fee comparison.</p>
      </div>
    );
  }

  const rc = rcFees;
  const rcTotal = (rc.commission||0) + (rc.fixedFee||0) + (rc.collectionFee||0) + (rc.pickPack||0) + (rc.gstOnFees||0) + (rc.tcs||0) + (rc.tds||0);

  // Commission rate from settlement row (what FK reported)
  const fkCommRate = fwd.find(r => +(r.commissionRate||0) > 0)?.commissionRate;
  const fkCommRatePct = fkCommRate ? (+(fkCommRate) * 100).toFixed(1) : null;
  const rcCommRatePct = rc.commissionRate != null ? (rc.commissionRate * 100).toFixed(1) : null;

  const lines = [
    {
      label:   'Commission',
      fkLabel: fkCommRatePct   ? `FK rate ${fkCommRatePct}%`  : null,
      rcLabel: rcCommRatePct   ? `RC rate ${rcCommRatePct}%` : null,
      fk: fkComm,
      rc: rc.commission,
    },
    { label: 'Fixed Fee',      fk: fkFixed,  rc: rc.fixedFee      },
    { label: 'Collection Fee', fk: fkColl,   rc: rc.collectionFee },
    { label: 'Pick & Pack',    fk: fkPP,     rc: rc.pickPack      },
    { label: 'Franchise Fee',  fk: fkFranch, rc: rc.franchiseFee ?? null },
    { label: 'GST on Fees',    fk: fkGst,    rc: rc.gstOnFees     },
    { label: 'TCS (1%)',       fk: fkTcs,    rc: rc.tcs           },
    { label: 'TDS (0.1%)',     fk: fkTds,    rc: rc.tds           },
  ].filter(l => l.fk > 0.005 || (l.rc != null && l.rc > 0.005));

  const totalVariance = hasSettled ? fkTotal - rcTotal : null;

  const fmtAmt = v => v == null ? <span className="text-outline">—</span> : `₹${Math.abs(+v).toFixed(2)}`;
  const fmtVar = v => {
    if (v == null) return <span className="text-outline">—</span>;
    const abs = Math.abs(v);
    if (abs < 0.5) return <span className="text-emerald-600 font-semibold">✓ match</span>;
    if (v > 0) return <span className="text-rose-600 font-semibold">+₹{abs.toFixed(2)} ⚠</span>;
    return <span className="text-emerald-600 font-semibold">−₹{abs.toFixed(2)}</span>;
  };

  return (
    <div className="space-y-3">
      {!hasSettled && (
        <div className="text-[11px] text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
          Order not yet settled — FK column shows ₹0. RC column shows expected fees based on your rate card.
        </div>
      )}

      {/* Price context */}
      <div className="flex items-center gap-4 text-xs text-secondary bg-surface-container-low rounded-lg px-3 py-2">
        <span>Sale Price: <strong className="text-ink">₹{price.toFixed(2)}</strong></span>
        <span className="text-surface">|</span>
        <span>Category: <strong className="text-ink">{order.category || '—'}</strong></span>
        <span className="text-surface">|</span>
        <span>Type: <strong className="text-ink">{order.fulfilmentType || '—'}</strong></span>
      </div>

      {/* Comparison table */}
      <div className="rounded-xl border border-border overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-surface-container-low border-b border-border">
              <th className="text-left px-4 py-2.5 text-secondary font-semibold">Fee Line</th>
              <th className="text-right px-4 py-2.5 text-secondary font-semibold">FK Charged</th>
              <th className="text-right px-4 py-2.5 text-primary font-semibold">Our RC</th>
              <th className="text-right px-4 py-2.5 text-secondary font-semibold">Variance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {lines.map(l => {
              const variance = (hasSettled && l.rc != null) ? l.fk - l.rc : null;
              return (
                <tr key={l.label} className="hover:bg-surface-container-low/60 transition-colors">
                  <td className="px-4 py-2.5 text-secondary">
                    {l.label}
                    {(l.fkLabel || l.rcLabel) && (
                      <div className="flex gap-2 mt-0.5">
                        {l.fkLabel && <span className="text-[10px] text-outline">{l.fkLabel}</span>}
                        {l.rcLabel && <span className="text-[10px] text-indigo-400">{l.rcLabel}</span>}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-ink">{fmtAmt(l.fk)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-primary">{fmtAmt(l.rc)}</td>
                  <td className="px-4 py-2.5 text-right">{fmtVar(variance)}</td>
                </tr>
              );
            })}
          </tbody>
          {/* Total row */}
          <tfoot>
            <tr className="bg-surface-container border-t-2 border-border font-semibold text-[11px]">
              <td className="px-4 py-3 text-ink font-bold">Total Fees</td>
              <td className="px-4 py-3 text-right font-mono text-ink">{hasSettled ? `₹${fkTotal.toFixed(2)}` : '—'}</td>
              <td className="px-4 py-3 text-right font-mono text-primary">₹{rcTotal.toFixed(2)}</td>
              <td className="px-4 py-3 text-right">{fmtVar(totalVariance)}</td>
            </tr>
            <tr className="bg-surface-container-low border-t border-border text-[11px]">
              <td className="px-4 py-2.5 text-secondary">Net to Seller</td>
              <td className="px-4 py-2.5 text-right font-mono text-emerald-700">{hasSettled ? `₹${(price - fkTotal).toFixed(2)}` : '—'}</td>
              <td className="px-4 py-2.5 text-right font-mono text-primary">₹{(rc.netToSeller || 0).toFixed(2)}</td>
              <td className="px-4 py-2.5 text-right">
                {hasSettled && (() => {
                  const diff = (price - fkTotal) - (rc.netToSeller || 0);
                  return fmtVar(-diff); // net: negative variance in fees = positive for seller
                })()}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Verdict banner */}
      {hasSettled && totalVariance != null && (() => {
        const abs = Math.abs(totalVariance);
        if (abs < 0.5) {
          return (
            <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
              <span className="text-lg">✅</span>
              <div>
                <p className="text-emerald-700 font-semibold text-sm">Fees match our Rate Card</p>
                <p className="text-emerald-600 text-xs">Total variance &lt; ₹0.50 — within acceptable rounding tolerance.</p>
              </div>
            </div>
          );
        }
        if (totalVariance > 0) {
          return (
            <div className="flex items-center gap-2 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
              <span className="text-lg">⚠️</span>
              <div>
                <p className="text-rose-700 font-semibold text-sm">FK overcharged by ₹{abs.toFixed(2)}</p>
                <p className="text-rose-600 text-xs">FK deducted more than our Rate Card expects. Consider raising a dispute.</p>
              </div>
            </div>
          );
        }
        return (
          <div className="flex items-center gap-2 bg-sky-50 border border-sky-200 rounded-xl px-4 py-3">
            <span className="text-lg">ℹ️</span>
            <div>
              <p className="text-sky-700 font-semibold text-sm">FK charged ₹{abs.toFixed(2)} less than RC</p>
              <p className="text-sky-600 text-xs">FK deducted less than expected — could be a discount, promo, or rate card mismatch.</p>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ─── NEFT Cycle Breakdown Table (FK-portal style) ────────────────────────────
function NeftCycleTable({ rows }) {
  const n = rows.length;

  const any  = (...keys) => keys.some(k => rows.some(r => Math.abs(+(r[k] || 0)) > 0.001));
  const sum  = key => rows.reduce((s, r) => s + (+(r[key] || 0)), 0);
  const val  = (r, key) => +(r[key] || 0);

  // Fee lines use raw sign from DB: Forward = negative (deduction), Reverse = positive (credit back)
  const feeLines = [
    { key: 'commission',            label: 'Commission',      rateKey: 'commissionRate' },
    { key: 'fixedFee',              label: 'Fixed Fee' },
    { key: 'collectionFee',         label: 'Collection Fee' },
    { key: 'pickPackFee',           label: 'Pick & Pack Fee' },
    { key: 'shippingFee',           label: 'Shipping Fee' },
    { key: 'reverseShipping',       label: 'Reverse Shipping' },
    { key: 'noCostEmiFee',          label: 'No Cost EMI Fee' },
    { key: 'customerAddonRecovery', label: 'Customer Addon Recovery' },
    { key: 'franchiseFee',          label: 'Franchise Fee' },
    { key: 'shopsyMarketingFee',    label: 'Shopsy Marketing' },
    { key: 'cancellationFee',       label: 'Cancellation Fee' },
  ].filter(l => any(l.key));

  const taxLines = [
    { key: 'gstOnMpFees', label: 'GST on MP Fees' },
    { key: 'tcs',         label: 'TCS' },
    { key: 'tds',         label: 'TDS' },
  ].filter(l => any(l.key));

  // Group totals use raw sums (signs carry through correctly)
  const sellerPrice = r => val(r, 'saleAmount') + val(r, 'totalOfferAmount') + val(r, 'myShare');
  const mpFeeSum    = r => feeLines.reduce((s, f) => s + val(r, f.key), 0);
  const taxSum      = r => taxLines.reduce((s, t) => s + val(r, t.key), 0);

  // fmt: show "—" only when value is zero AND no cycle contributed to this row
  // fmtTotal: always show a value if any cycle was non-zero (shows ₹0.00 for nets)
  const fmtV = (v, inactive) => {
    if (Math.abs(v) < 0.005) return <span className={inactive ? 'text-surface' : 'text-outline'}>—</span>;
    const cls = v >= 0 ? 'text-emerald-700' : 'text-rose-600';
    return <span className={cls}>{v >= 0 ? '+' : '−'}₹{Math.abs(v).toFixed(2)}</span>;
  };
  const fmtTotal = (total, anyActive) => {
    if (!anyActive) return <span className="text-surface">—</span>;
    if (Math.abs(total) < 0.005) {
      return <span className="text-secondary font-semibold">+₹0.00</span>;
    }
    const cls = total >= 0 ? 'text-emerald-700 font-semibold' : 'text-rose-600 font-semibold';
    return <span className={cls}>{total >= 0 ? '+' : '−'}₹{Math.abs(total).toFixed(2)}</span>;
  };
  const fmtCredit = v => {
    if (Math.abs(v) < 0.005) return <span className="text-outline">—</span>;
    return <span className="text-secondary text-[10px]">{v >= 0 ? '' : '−'}₹{Math.abs(v).toFixed(3)}</span>;
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-xs border-collapse" style={{ minWidth: `${200 + n * 175}px` }}>
        <thead>
          <tr className="bg-primary text-white">
            <th className="text-left px-4 py-3 font-semibold min-w-[200px] border-r border-primary">Line Item</th>
            {rows.map((r, i) => (
              <th key={i} className="text-right px-3 py-2 font-semibold min-w-[160px] border-l border-primary">
                <div className="flex flex-col items-end gap-1">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide ${
                    (r.neftType || '').toLowerCase().includes('reverse') || (r.neftType || '').toLowerCase().includes('return')
                      ? 'bg-rose-500 text-white' : 'bg-emerald-600 text-white'
                  }`}>{r.neftType || 'Forward'}</span>
                  <span className="font-mono text-[10px] text-indigo-300 break-all">{r.neftId}</span>
                  <span className="text-[10px] text-outline">{r.paymentDate}</span>
                </div>
              </th>
            ))}
            {n > 1 && (
              <th className="text-right px-3 py-2 font-bold min-w-[130px] border-l border-primary bg-primary">
                Till Date
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {/* ── Seller Price ── */}
          <GroupRow label="Seller Price" icon="arrow_upward"
            values={rows.map(sellerPrice)} total={sum('saleAmount') + sum('totalOfferAmount') + sum('myShare')}
            n={n} green fmtV={fmtV} fmtTotal={fmtTotal}
          />
          <DataRow label="Sale Amount" indent
            values={rows.map(r => val(r, 'saleAmount'))} total={sum('saleAmount')}
            n={n} green fmtV={fmtV} fmtTotal={fmtTotal}
          />
          {any('totalOfferAmount') && (
            <DataRow label="Total Offer" indent
              values={rows.map(r => val(r, 'totalOfferAmount'))} total={sum('totalOfferAmount')}
              n={n} green fmtV={fmtV} fmtTotal={fmtTotal}
            />
          )}
          {any('myShare') && (
            <DataRow label="My Share (Discount)" indent
              values={rows.map(r => val(r, 'myShare'))} total={sum('myShare')}
              n={n} fmtV={fmtV} fmtTotal={fmtTotal}
            />
          )}

          {/* ── Customer Add-ons ── */}
          {any('customerAddons') && (
            <DataRow label="Customer Add-ons Amount"
              values={rows.map(r => val(r, 'customerAddons'))} total={sum('customerAddons')}
              n={n} fmtV={fmtV} fmtTotal={fmtTotal}
            />
          )}

          {/* ── Refund Amount ── */}
          {any('refund') && (
            <DataRow label="Refund Amount"
              values={rows.map(r => val(r, 'refund'))} total={sum('refund')}
              n={n} fmtV={fmtV} fmtTotal={fmtTotal}
            />
          )}

          {/* ── Marketplace Fees ── */}
          {feeLines.length > 0 && <>
            <GroupRow label="Marketplace Fees" icon="arrow_downward"
              values={rows.map(mpFeeSum)} total={feeLines.reduce((s, f) => s + sum(f.key), 0)}
              n={n} fmtV={fmtV} fmtTotal={fmtTotal}
            />
            {feeLines.map(f => {
              const rateRow = rows.find(r => +(r.commissionRate || 0) > 0);
              const rateLabel = f.rateKey && rateRow ? ` (${(+(rateRow.commissionRate) * 100).toFixed(1)}%)` : '';
              return (
                <DataRow key={f.key} label={f.label + rateLabel} indent
                  values={rows.map(r => val(r, f.key))} total={sum(f.key)}
                  n={n} fmtV={fmtV} fmtTotal={fmtTotal}
                />
              );
            })}
          </>}

          {/* ── Taxes ── */}
          {taxLines.length > 0 && <>
            <GroupRow label="Taxes" icon="arrow_downward"
              values={rows.map(taxSum)} total={taxLines.reduce((s, t) => s + sum(t.key), 0)}
              n={n} fmtV={fmtV} fmtTotal={fmtTotal}
            />
            {taxLines.map(t => (
              <DataRow key={t.key} label={t.label} indent
                values={rows.map(r => val(r, t.key))} total={sum(t.key)}
                n={n} fmtV={fmtV} fmtTotal={fmtTotal}
              />
            ))}
          </>}

          {/* ── Bank Settlement — always show value, even ₹0.00 ── */}
          <tr className="bg-primary text-white font-bold text-xs">
            <td className="px-4 py-3 border-r border-primary">Bank Settlement</td>
            {rows.map((r, i) => {
              const v = val(r, 'bankSettlement');
              return (
                <td key={i} className="px-3 py-3 text-right border-l border-primary">
                  <span className={v >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                    {v >= 0 ? '+' : '−'}₹{Math.abs(v).toFixed(2)}
                  </span>
                </td>
              );
            })}
            {n > 1 && (() => {
              const t = sum('bankSettlement');
              return (
                <td className="px-3 py-3 text-right border-l border-primary bg-primary">
                  <span className={t >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                    {t >= 0 ? '+' : '−'}₹{Math.abs(t).toFixed(2)}
                  </span>
                </td>
              );
            })()}
          </tr>

          {/* ── Input Credits ── */}
          {any('inputGstTcs') && (
            <tr className="bg-surface-container-low border-t border-border">
              <td className="px-4 py-2.5 text-secondary border-r border-border">
                Input GST Credits <span className="text-outline">(GST + TCS)</span>
              </td>
              {rows.map((r, i) => (
                <td key={i} className="px-3 py-2.5 text-right border-l border-border">
                  {fmtCredit(val(r, 'inputGstTcs'))}
                </td>
              ))}
              {n > 1 && (
                <td className="px-3 py-2.5 text-right border-l border-border bg-surface-container">
                  {fmtCredit(sum('inputGstTcs'))}
                </td>
              )}
            </tr>
          )}
          {any('incomeTaxCredits') && (
            <tr className="bg-surface-container-low">
              <td className="px-4 py-2.5 text-secondary border-r border-border">
                Input Tax Credits <span className="text-outline">(TDS)</span>
              </td>
              {rows.map((r, i) => (
                <td key={i} className="px-3 py-2.5 text-right border-l border-border">
                  {fmtCredit(val(r, 'incomeTaxCredits'))}
                </td>
              ))}
              {n > 1 && (
                <td className="px-3 py-2.5 text-right border-l border-border bg-surface-container">
                  {fmtCredit(sum('incomeTaxCredits'))}
                </td>
              )}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function GroupRow({ label, icon, values, total, n, green, fmtV, fmtTotal }) {
  const active = values.some(v => Math.abs(v) > 0.005);
  return (
    <tr className="bg-surface-container border-t-2 border-border">
      <td className="px-4 py-2.5 font-bold text-ink border-r border-border">
        <span className={`material-symbols-outlined mr-1.5 align-middle text-[14px] ${green ? 'text-emerald-600' : 'text-rose-500'}`} aria-hidden="true">{icon}</span>
        {label}
      </td>
      {values.map((v, i) => (
        <td key={i} className="px-3 py-2.5 text-right border-l border-border font-semibold">
          {fmtV(v, false)}
        </td>
      ))}
      {n > 1 && (
        <td className="px-3 py-2.5 text-right border-l border-border bg-surface-container-high font-bold">
          {fmtTotal(total, active)}
        </td>
      )}
    </tr>
  );
}

function DataRow({ label, values, total, n, fmtV, fmtTotal, indent }) {
  const active = values.some(v => Math.abs(v) > 0.005);
  return (
    <tr className="border-t border-slate-50 hover:bg-surface-container-low/60">
      <td className={`py-2 text-secondary border-r border-border ${indent ? 'px-8' : 'px-4'}`}>
        {label}
      </td>
      {values.map((v, i) => (
        <td key={i} className="px-3 py-2 text-right border-l border-slate-50">
          {fmtV(v, true)}
        </td>
      ))}
      {n > 1 && (
        <td className="px-3 py-2 text-right border-l border-border bg-surface-container-low">
          {fmtTotal(total, active)}
        </td>
      )}
    </tr>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function Section({ icon, title, children }) {
  return (
    <div className="px-6 py-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="material-symbols-outlined text-[18px] text-primary" aria-hidden="true">{icon}</span>
        <h3 className="text-sm font-bold text-ink uppercase tracking-wide">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function Grid2({ children }) {
  return <div className="grid grid-cols-2 gap-x-6 gap-y-3">{children}</div>;
}

function Field({ label, value, mono }) {
  return (
    <div>
      <p className="text-[10px] text-outline uppercase tracking-wide font-medium mb-0.5">{label}</p>
      <div className={`text-xs text-ink font-medium ${mono ? 'font-mono break-all' : ''}`}>
        {value != null && value !== '' ? value : <span className="text-outline">—</span>}
      </div>
    </div>
  );
}

function AmountBox({ label, amount, color }) {
  const cols = {
    indigo:  { bg: 'bg-primary-container',  text: 'text-primary',  val: 'text-primary'  },
    sky:     { bg: 'bg-sky-50',     text: 'text-sky-600',     val: 'text-sky-900'     },
    emerald: { bg: 'bg-emerald-50', text: 'text-emerald-600', val: 'text-emerald-900' },
    rose:    { bg: 'bg-rose-50',    text: 'text-rose-600',    val: 'text-rose-900'    },
    amber:   { bg: 'bg-amber-50',   text: 'text-amber-600',   val: 'text-amber-900'   },
  }[color] || { bg: 'bg-surface-container-low', text: 'text-secondary', val: 'text-ink' };
  return (
    <div className={`${cols.bg} rounded-xl p-3`}>
      <p className={`text-[10px] font-medium uppercase tracking-wide ${cols.text}`}>{label}</p>
      <p className={`text-base font-bold mt-1 ${cols.val}`}>{currencyFull(amount)}</p>
    </div>
  );
}

function Tag({ color, children }) {
  const cls = {
    indigo:  'bg-primary-container text-primary',
    sky:     'bg-sky-100 text-sky-700',
    emerald: 'bg-emerald-100 text-emerald-700',
    rose:    'bg-rose-100 text-rose-700',
    amber:   'bg-amber-100 text-amber-700',
    orange:  'bg-orange-100 text-orange-700',
    purple:  'bg-purple-100 text-purple-700',
  }[color] || 'bg-surface-container text-secondary';
  return <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${cls}`}>{children}</span>;
}

function resultColor(r) {
  return { Refund: 'rose', Exchange: 'sky', Replace: 'amber' }[r] || 'indigo';
}

const STATUS_BG   = { Settled: 'bg-emerald-50', Unsettled: 'bg-amber-50', 'Fully Returned': 'bg-rose-50', 'Partial Return': 'bg-orange-50', Clawback: 'bg-purple-50' };
const STATUS_DOT  = { Settled: 'bg-emerald-500', Unsettled: 'bg-amber-400', 'Fully Returned': 'bg-rose-500', 'Partial Return': 'bg-orange-400', Clawback: 'bg-purple-500' };
const STATUS_TEXT = { Settled: 'text-emerald-700', Unsettled: 'text-amber-700', 'Fully Returned': 'text-rose-700', 'Partial Return': 'text-orange-700', Clawback: 'text-purple-700' };

function LoadingState() {
  return (
    <div className="p-6 space-y-4 animate-pulse" role="status" aria-live="polite" aria-busy="true">
      <div className="h-10 bg-surface-container rounded-xl" />
      <div className="h-4 w-1/3 bg-surface-container rounded" />
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-8 bg-surface-container rounded" />)}
      </div>
      <div className="h-4 w-1/3 bg-surface-container rounded mt-4" />
      {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-8 bg-surface-container rounded" />)}
    </div>
  );
}

function ErrorState({ msg }) {
  return (
    <div className="m-6 bg-rose-50 border border-rose-200 rounded-xl p-5" role="alert">
      <p className="text-rose-700 font-semibold">Could not load order detail</p>
      <p className="text-rose-600 text-xs font-mono mt-1">{msg}</p>
    </div>
  );
}
