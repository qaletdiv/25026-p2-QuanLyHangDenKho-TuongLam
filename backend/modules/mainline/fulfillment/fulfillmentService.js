'use strict';

// Three-way match (per the schema's Fulfillment Architecture):
//   ordered   (po_order_lines, NetSuite)   — size-level SKU
//   allocated (mainline_po_leg_lines, WIP)  — size-level SKU
//   shipped   (mainline_ci_line_items where the CI is confirmed) — style-color SKU (coarser)
//   received  (3PL/NetSuite, future)        — placeholder 0
//
// CI SKUs are coarser than PO SKUs (style-color vs style-color-size), so ordered &
// allocated are grouped up to the CI SKU they belong to — exact match, else the
// longest CI SKU that is a prefix — exactly as the legacy /fulfillment endpoint did.

function compute(trn, { orders, orderLines, legs, legLines, invoices, ciLines }) {
  const poNumbers = new Set(orders.filter((o) => o.trn_number === trn).map((o) => o.po_number));
  const legIds = new Set(legs.filter((l) => poNumbers.has(l.po_number)).map((l) => l.id));

  // shipped — only confirmed CIs, only legs under this TRN
  const confirmedInv = new Set(invoices.filter((i) => i.status === 'confirmed').map((i) => i.id));
  const shippedBySku = new Map();
  ciLines.forEach((cl) => {
    if (!legIds.has(cl.matched_leg_id) || !confirmedInv.has(cl.invoice_id)) return;
    shippedBySku.set(cl.sku_code, (shippedBySku.get(cl.sku_code) || 0) + (cl.qty || 0));
  });
  const ciSkus = [...shippedBySku.keys()];

  const resolveKey = (sku) => {
    if (shippedBySku.has(sku)) return sku;
    let best = null;
    for (const s of ciSkus) if (sku.startsWith(`${s}-`) && (!best || s.length > best.length)) best = s;
    return best || sku;
  };

  const rows = new Map(); // resolved sku → row
  const row = (sku) => {
    if (!rows.has(sku)) rows.set(sku, { sku_code: sku, ordered_qty: 0, allocated_qty: 0, shipped_qty: 0, received_qty: 0 });
    return rows.get(sku);
  };

  orderLines.forEach((ol) => { if (poNumbers.has(ol.po_number)) row(resolveKey(ol.sku_code)).ordered_qty += ol.ordered_qty || 0; });
  legLines.forEach((ll) => { if (legIds.has(ll.leg_id)) row(resolveKey(ll.sku_code)).allocated_qty += ll.allocated_qty || 0; });
  shippedBySku.forEach((qty, sku) => { row(sku).shipped_qty += qty; });

  const fulfillment = [...rows.values()].map((r) => ({
    ...r,
    remaining_qty: r.ordered_qty - r.shipped_qty,   // expected vs shipped
    variance: r.shipped_qty - r.received_qty,        // shipped vs received (future)
  })).sort((a, b) => a.sku_code.localeCompare(b.sku_code));

  const totals = fulfillment.reduce((t, r) => ({
    ordered_qty: t.ordered_qty + r.ordered_qty,
    allocated_qty: t.allocated_qty + r.allocated_qty,
    shipped_qty: t.shipped_qty + r.shipped_qty,
    received_qty: t.received_qty + r.received_qty,
  }), { ordered_qty: 0, allocated_qty: 0, shipped_qty: 0, received_qty: 0 });

  return { trn_number: trn, sku_count: fulfillment.length, totals, fulfillment };
}

module.exports = { compute };
