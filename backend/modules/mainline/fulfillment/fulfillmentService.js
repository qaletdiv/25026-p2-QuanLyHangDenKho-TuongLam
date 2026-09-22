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

function computeForPos(poNumbers, { orderLines, legs, legLines, invoices, ciLines, receipts = [], receiptLines = [], shipmentLegs = [] }) {
  const legIds = new Set(legs.filter((l) => poNumbers.has(l.po_number)).map((l) => l.id));

  // WHAT VARIANCE COMPARES AGAINST depends on whether a consignment exists (Lam,
  // 2026-09-16). A leg WITH a shipment is measured against what that shipment
  // shipped — even when that is 0, because a shipment carrying nothing while units
  // are received IS the discrepancy. A leg with NO shipment has nothing to compare
  // shipped against, so the expectation is its ALLOCATION.
  //
  // Done per leg rather than for the whole scope: a TRN can hold both kinds at
  // once, and one shipped leg would otherwise put every unshipped leg on the wrong
  // basis. `shipped_qty` already only accrues from legs with confirmed CI lines, so
  // the expected quantity is that plus the allocation of the shipment-less legs.
  const legsWithShipment = new Set(shipmentLegs.map((j) => String(j.leg_id)));
  const unshippedLegIds = new Set([...legIds].filter((id) => !legsWithShipment.has(String(id))));

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
    if (!rows.has(sku)) rows.set(sku, { sku_code: sku, ordered_qty: 0, allocated_qty: 0, shipped_qty: 0, received_qty: 0, _allocUnshipped: 0 });
    return rows.get(sku);
  };

  orderLines.forEach((ol) => { if (poNumbers.has(ol.po_number)) row(resolveKey(ol.sku_code)).ordered_qty += ol.ordered_qty || 0; });
  legLines.forEach((ll) => {
    if (!legIds.has(ll.leg_id)) return;
    const r = row(resolveKey(ll.sku_code));
    r.allocated_qty += ll.allocated_qty || 0;
    if (unshippedLegIds.has(ll.leg_id)) r._allocUnshipped += ll.allocated_qty || 0;
  });
  shippedBySku.forEach((qty, sku) => { row(sku).shipped_qty += qty; });

  // received — NetSuite Item Receipt lines for the in-scope POs (attach to po_number),
  // rolled up to the CI SKU grain like ordered/allocated (receipt SKUs are size-level).
  const myReceiptIds = new Set(receipts.filter((r) => poNumbers.has(r.po_number)).map((r) => r.id));
  receiptLines.forEach((l) => { if (myReceiptIds.has(l.receipt_id)) row(resolveKey(l.sku_code)).received_qty += (l.qty || 0); });

  const fulfillment = [...rows.values()].map(({ _allocUnshipped, ...r }) => ({
    ...r,
    // RECEIVED IS A FLOOR ON SHIPPED — you cannot receive what was never shipped.
    // `shipped_qty` counts only confirmed CI packing lines matched to the leg, so a
    // PO that was received without anyone uploading shipping data here reads
    // shipped 0, and "remaining" then claimed the full quantity was still to come
    // while the receipts beside it said it had all arrived (PO04723: allocated
    // 1,300 · shipped 0 · received 1,300 · remaining 1,300). Same rule the SMS
    // report uses. The floor is capped at ordered so an OVER-receipt cannot make
    // remaining negative; `shipped_qty` itself is never capped, so a genuine
    // over-SHIP still shows as a negative remaining.
    remaining_qty: r.ordered_qty - Math.max(r.shipped_qty, Math.min(r.received_qty, r.ordered_qty)),
    // ACTUAL minus EXPECTED, so the sign reads the way a warehouse discrepancy is
    // spoken: over-received is POSITIVE, short-received negative. It was
    // `shipped - received`, which inverted both (a leg over-received by 1 showed
    // -1) — fixed 2026-09-16. Nothing branches on the sign, only on `!== 0`.
    // EXPECTED = shipped, plus the allocation of any leg that has no consignment
    // at all (see the note above); on a fully-shipped scope that is just shipped.
    variance: r.received_qty - (r.shipped_qty + _allocUnshipped),
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

// SHIPPED + RECEIVED per (leg, SKU) for EVERY leg, in one pass.
//
// The two rules that make a leg's actuals, extracted so the leg page and the report
// export cannot drift apart — they were one function's internals until the export
// needed them too, and a second copy of "which leg gets credited this receipt" is
// exactly how two screens start disagreeing about a discrepancy.
//   shipped  — confirmed CI lines matched to the leg
//   received — the PO's NetSuite receipt lines split across ITS legs by shipping
//              method (air arrives before sea), each capped at that leg's allocated
//              qty for the SKU, any overflow landing on the last leg. Without the
//              split the sea leg would be credited the air leg's received units.
// Returns { shippedByLegSku, recvByLegSku }, both Map(`${legId}|${sku}` → qty).
function legActuals({ legs, legLines, invoices, ciLines, receipts = [], receiptLines = [], modes = [] }) {
  const modeName = new Map(modes.map((m) => [m.id, m.name]));
  const rank = (l) => { const m = modeName.get(l.mode_id) || ''; return /air/i.test(m) ? 0 : /sea/i.test(m) ? 1 : 2; };

  // allocated per (leg, sku) — the cap each leg can absorb
  const allocByLegSku = new Map();
  legLines.forEach((ll) => {
    const k = `${ll.leg_id}|${ll.sku_code}`;
    allocByLegSku.set(k, (allocByLegSku.get(k) || 0) + (ll.allocated_qty || 0));
  });

  // shipped per (leg, sku) — confirmed CIs only
  const confirmedInv = new Set(invoices.filter((i) => i.status === 'confirmed').map((i) => i.id));
  const shippedByLegSku = new Map();
  ciLines.forEach((cl) => {
    if (cl.matched_leg_id == null || !confirmedInv.has(cl.invoice_id)) return;
    const k = `${cl.matched_leg_id}|${cl.sku_code}`;
    shippedByLegSku.set(k, (shippedByLegSku.get(k) || 0) + (cl.qty || 0));
  });

  // received per (leg, sku), allocated PO by PO
  const legsByPo = new Map();
  legs.forEach((l) => {
    if (!legsByPo.has(l.po_number)) legsByPo.set(l.po_number, []);
    legsByPo.get(l.po_number).push(l);
  });
  const receiptPo = new Map(receipts.map((r) => [r.id, r.po_number]));
  const recvByPoSku = new Map();                       // `${po}|${sku}` → qty
  receiptLines.forEach((l) => {
    const po = receiptPo.get(l.receipt_id);
    if (!po) return;
    const k = `${po}|${l.sku_code}`;
    recvByPoSku.set(k, (recvByPoSku.get(k) || 0) + (l.qty || 0));
  });

  const recvByLegSku = new Map();
  recvByPoSku.forEach((qty, key) => {
    const i = key.indexOf('|');
    const po = key.slice(0, i), sku = key.slice(i + 1);
    const poLegs = (legsByPo.get(po) || []).slice()
      .sort((a, b) => rank(a) - rank(b) || String(a.id).localeCompare(String(b.id)));
    if (!poLegs.length) return;
    let remaining = qty;
    for (const l of poLegs) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, allocByLegSku.get(`${l.id}|${sku}`) || 0);
      if (take > 0) recvByLegSku.set(`${l.id}|${sku}`, (recvByLegSku.get(`${l.id}|${sku}`) || 0) + take);
      remaining -= take;
    }
    if (remaining > 0) {
      const last = poLegs[poLegs.length - 1].id;
      recvByLegSku.set(`${last}|${sku}`, (recvByLegSku.get(`${last}|${sku}`) || 0) + remaining);
    }
  });

  return { shippedByLegSku, recvByLegSku };
}

// LEG grain — one air/sea split of a PO. Unlike reconcilePo (which unions all of a
// PO's legs), this scopes shipped to THIS leg and splits the PO's NetSuite receipts
// across its legs by SHIPPING METHOD (air arrives/receives before sea) capped at each
// leg's allocated quantity per SKU — so the sea leg isn't credited the air leg's
// received units. All derived at read; nothing stored (3NF).
function reconcileLeg(legId, { legs, legLines, invoices, ciLines, receipts = [], receiptLines = [], modes = [], shipmentLegs = [] }) {
  const leg = legs.find((l) => String(l.id) === String(legId));
  if (!leg) return null;
  // Does a consignment exist for THIS leg? It decides what variance compares
  // received against — see the note in computeForPos.
  const hasShipment = shipmentLegs.some((j) => String(j.leg_id) === String(legId));
  const po = leg.po_number;
  const modeName = new Map(modes.map((m) => [m.id, m.name]));
  // legs of this PO, ordered by shipping method: Air (faster) receives first, then Sea/other.
  const rank = (l) => { const m = modeName.get(l.mode_id) || ''; return /air/i.test(m) ? 0 : /sea/i.test(m) ? 1 : 2; };
  const poLegs = legs.filter((l) => l.po_number === po).sort((a, b) => rank(a) - rank(b) || String(a.id).localeCompare(String(b.id)));

  // allocated per (leg, sku) — the WIP target for each split
  const allocByLegSku = new Map();
  legLines.forEach((ll) => { const k = `${ll.leg_id}|${ll.sku_code}`; allocByLegSku.set(k, (allocByLegSku.get(k) || 0) + (ll.allocated_qty || 0)); });

  // shipped + received per (leg, sku) — ONE implementation, shared with the report
  // export (`legActuals` above); `poLegs` is kept only for the mode label below.
  const { shippedByLegSku, recvForLegSku } = (() => {
    const a = legActuals({ legs, legLines, invoices, ciLines, receipts, receiptLines, modes });
    return { shippedByLegSku: a.shippedByLegSku, recvForLegSku: a.recvByLegSku };
  })();
  void poLegs;

  // rows = every SKU touching this leg (allocated | shipped | received)
  const skus = new Set();
  const forThisLeg = (m) => {
    const out = new Map();
    m.forEach((v, k) => { const i = k.indexOf('|'); if (k.slice(0, i) === String(legId)) out.set(k.slice(i + 1), v); });
    return out;
  };
  const shippedBySku = forThisLeg(shippedByLegSku);
  const recvBySkuThisLeg = forThisLeg(recvForLegSku);
  legLines.forEach((ll) => { if (String(ll.leg_id) === String(legId)) skus.add(ll.sku_code); });
  shippedBySku.forEach((_, s) => skus.add(s));
  recvBySkuThisLeg.forEach((_, s) => skus.add(s));

  const fulfillment = [...skus].map((sku) => {
    const allocated_qty = allocByLegSku.get(`${legId}|${sku}`) || 0;
    const shipped_qty = shippedBySku.get(sku) || 0;
    const received_qty = recvBySkuThisLeg.get(sku) || 0;
    // variance measures received against SHIPPED when a consignment exists (even a
    // shipment carrying 0 — that is a real discrepancy) and against ALLOCATED when
    // none does; remaining floors shipped at received. See the notes on the
    // TRN-grain computation above — the two grains must agree on both conventions.
    return {
      sku_code: sku, ordered_qty: allocated_qty, allocated_qty, shipped_qty, received_qty,
      remaining_qty: allocated_qty - Math.max(shipped_qty, Math.min(received_qty, allocated_qty)),
      variance: received_qty - (hasShipment ? shipped_qty : allocated_qty),
    };
  }).sort((a, b) => a.sku_code.localeCompare(b.sku_code));

  const totals = fulfillment.reduce((t, r) => ({
    ordered_qty: t.ordered_qty + r.ordered_qty, allocated_qty: t.allocated_qty + r.allocated_qty,
    shipped_qty: t.shipped_qty + r.shipped_qty, received_qty: t.received_qty + r.received_qty,
  }), { ordered_qty: 0, allocated_qty: 0, shipped_qty: 0, received_qty: 0 });

  return { po_number: po, leg_id: leg.id, mode: modeName.get(leg.mode_id) || null, sku_count: fulfillment.length, totals, fulfillment };
}

module.exports = { compute, reconcilePo, reconcileLeg, legActuals };
