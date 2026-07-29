'use strict';

// Three-way (four-way) match:
//   ordered   (po_order_lines, NetSuite)          — size-level SKU
//   allocated (mainline_po_leg_lines, WIP)          — size-level SKU
//   shipped   (mainline_ci_line_items, confirmed CI) — style-color SKU (coarser)
//   received  (mainline_item_receipt_lines, NetSuite) — size-level SKU
//
// CI SKUs are coarser than PO SKUs (style-color vs style-color-size), so ordered,
// allocated & received are grouped up to the CI SKU they belong to (exact match,
// else the longest CI SKU that is a prefix). Computed at read; nothing stored.
//
// `compute(trn)` aggregates all POs under a TRN; `reconcilePo(poNumber)` scopes to
// one component PO — both go through computeForPos.

function computeForPos(poNumbers, { orderLines, legs, legLines, invoices, ciLines, receipts = [], receiptLines = [] }) {
  const legIds = new Set(legs.filter((l) => poNumbers.has(l.po_number)).map((l) => l.id));

  // shipped — only confirmed CIs, only legs in scope
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

  const rows = new Map();
  const row = (sku) => {
    if (!rows.has(sku)) rows.set(sku, { sku_code: sku, ordered_qty: 0, allocated_qty: 0, shipped_qty: 0, received_qty: 0 });
    return rows.get(sku);
  };

  orderLines.forEach((ol) => { if (poNumbers.has(ol.po_number)) row(resolveKey(ol.sku_code)).ordered_qty += ol.ordered_qty || 0; });
  legLines.forEach((ll) => { if (legIds.has(ll.leg_id)) row(resolveKey(ll.sku_code)).allocated_qty += ll.allocated_qty || 0; });
  shippedBySku.forEach((qty, sku) => { row(sku).shipped_qty += qty; });

  // received — NetSuite Item Receipt lines for the in-scope POs (attach to po_number),
  // rolled up to the CI SKU grain like ordered/allocated (receipt SKUs are size-level).
  const myReceiptIds = new Set(receipts.filter((r) => poNumbers.has(r.po_number)).map((r) => r.id));
  receiptLines.forEach((l) => { if (myReceiptIds.has(l.receipt_id)) row(resolveKey(l.sku_code)).received_qty += (l.qty || 0); });

  const fulfillment = [...rows.values()].map((r) => ({
    ...r,
    remaining_qty: r.ordered_qty - r.shipped_qty,   // expected vs shipped
    variance: r.shipped_qty - r.received_qty,        // shipped vs received
  })).sort((a, b) => a.sku_code.localeCompare(b.sku_code));

  const totals = fulfillment.reduce((t, r) => ({
    ordered_qty: t.ordered_qty + r.ordered_qty,
    allocated_qty: t.allocated_qty + r.allocated_qty,
    shipped_qty: t.shipped_qty + r.shipped_qty,
    received_qty: t.received_qty + r.received_qty,
  }), { ordered_qty: 0, allocated_qty: 0, shipped_qty: 0, received_qty: 0 });

  return { sku_count: fulfillment.length, totals, fulfillment };
}

// TRN grain — every PO under the master.
function compute(trn, ctx) {
  const poNumbers = new Set((ctx.orders || []).filter((o) => o.trn_number === trn).map((o) => o.po_number));
  return { trn_number: trn, ...computeForPos(poNumbers, ctx) };
}

// Component-PO grain — one po_number (the SMS-style PO reconciliation).
function reconcilePo(poNumber, ctx) {
  return { po_number: poNumber, ...computeForPos(new Set([poNumber]), ctx) };
}

// LEG grain — one air/sea split of a PO. Unlike reconcilePo (which unions all of a
// PO's legs), this scopes shipped to THIS leg and splits the PO's NetSuite receipts
// across its legs by SHIPPING METHOD (air arrives/receives before sea) capped at each
// leg's allocated quantity per SKU — so the sea leg isn't credited the air leg's
// received units. All derived at read; nothing stored (3NF).
function reconcileLeg(legId, { legs, legLines, invoices, ciLines, receipts = [], receiptLines = [], modes = [] }) {
  const leg = legs.find((l) => String(l.id) === String(legId));
  if (!leg) return null;
  const po = leg.po_number;
  const modeName = new Map(modes.map((m) => [m.id, m.name]));
  // legs of this PO, ordered by shipping method: Air (faster) receives first, then Sea/other.
  const rank = (l) => { const m = modeName.get(l.mode_id) || ''; return /air/i.test(m) ? 0 : /sea/i.test(m) ? 1 : 2; };
  const poLegs = legs.filter((l) => l.po_number === po).sort((a, b) => rank(a) - rank(b) || String(a.id).localeCompare(String(b.id)));

  // allocated per (leg, sku) — the WIP target for each split
  const allocByLegSku = new Map();
  legLines.forEach((ll) => { const k = `${ll.leg_id}|${ll.sku_code}`; allocByLegSku.set(k, (allocByLegSku.get(k) || 0) + (ll.allocated_qty || 0)); });

  // received per SKU for the whole PO (NetSuite receipt lines are size-level)
  const myReceiptIds = new Set(receipts.filter((r) => r.po_number === po).map((r) => r.id));
  const recvBySku = new Map();
  receiptLines.forEach((l) => { if (myReceiptIds.has(l.receipt_id)) recvBySku.set(l.sku_code, (recvBySku.get(l.sku_code) || 0) + (l.qty || 0)); });

  // allocate each SKU's received qty across the PO's legs (air first) capped at each
  // leg's allocated qty; any overflow beyond all allocations lands on the last leg.
  const recvForLegSku = new Map();
  recvBySku.forEach((qty, sku) => {
    let remaining = qty;
    for (const l of poLegs) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, allocByLegSku.get(`${l.id}|${sku}`) || 0);
      if (take > 0) recvForLegSku.set(`${l.id}|${sku}`, (recvForLegSku.get(`${l.id}|${sku}`) || 0) + take);
      remaining -= take;
    }
    if (remaining > 0 && poLegs.length) {
      const last = poLegs[poLegs.length - 1].id;
      recvForLegSku.set(`${last}|${sku}`, (recvForLegSku.get(`${last}|${sku}`) || 0) + remaining);
    }
  });

  // shipped per SKU for THIS leg — confirmed CI lines matched to the leg
  const confirmedInv = new Set(invoices.filter((i) => i.status === 'confirmed').map((i) => i.id));
  const shippedBySku = new Map();
  ciLines.forEach((cl) => { if (String(cl.matched_leg_id) === String(legId) && confirmedInv.has(cl.invoice_id)) shippedBySku.set(cl.sku_code, (shippedBySku.get(cl.sku_code) || 0) + (cl.qty || 0)); });

  // rows = every SKU touching this leg (allocated | shipped | received)
  const skus = new Set();
  legLines.forEach((ll) => { if (String(ll.leg_id) === String(legId)) skus.add(ll.sku_code); });
  shippedBySku.forEach((_, s) => skus.add(s));
  recvForLegSku.forEach((_, k) => { const i = k.indexOf('|'); if (k.slice(0, i) === String(legId)) skus.add(k.slice(i + 1)); });

  const fulfillment = [...skus].map((sku) => {
    const allocated_qty = allocByLegSku.get(`${legId}|${sku}`) || 0;
    const shipped_qty = shippedBySku.get(sku) || 0;
    const received_qty = recvForLegSku.get(`${legId}|${sku}`) || 0;
    return { sku_code: sku, ordered_qty: allocated_qty, allocated_qty, shipped_qty, received_qty, remaining_qty: allocated_qty - shipped_qty, variance: shipped_qty - received_qty };
  }).sort((a, b) => a.sku_code.localeCompare(b.sku_code));

  const totals = fulfillment.reduce((t, r) => ({
    ordered_qty: t.ordered_qty + r.ordered_qty, allocated_qty: t.allocated_qty + r.allocated_qty,
    shipped_qty: t.shipped_qty + r.shipped_qty, received_qty: t.received_qty + r.received_qty,
  }), { ordered_qty: 0, allocated_qty: 0, shipped_qty: 0, received_qty: 0 });

  return { po_number: po, leg_id: leg.id, mode: modeName.get(leg.mode_id) || null, sku_count: fulfillment.length, totals, fulfillment };
}

module.exports = { compute, reconcilePo, reconcileLeg };
