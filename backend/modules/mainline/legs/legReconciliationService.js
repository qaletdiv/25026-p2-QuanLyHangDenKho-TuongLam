'use strict';

// R2 reconciliation — per (poNumber, skuCode): orderedQty (NetSuite, po_order_lines)
// vs Σ allocatedQty across that poNumber's air/sea legs (WIP). Mismatches are
// flagged for review, never auto-resolved.
//
// SCOPE — two filters, both deliberate:
//
// (1) A PO with NO legs is SKIPPED entirely. "Ordered but not yet split into air/sea"
//     is the FORECAST lifecycle state, not a discrepancy — those POs are a season
//     ahead and the WIP that splits them hasn't been issued yet. Counting them made
//     every SKU of every forecast PO a "mismatch": on the live data that was 2,467 of
//     2,640, which buried the few real ones (a genuine S/L quantity transposition on
//     PO04825 sat invisible underneath). Unconditional — a forecast PO is never a
//     finding, in any caller.
//
// (2) `opts.poNumbers`, when supplied, narrows to those POs. The WIP import passes the
//     POs from the uploaded sheet so its response describes THAT UPLOAD rather than
//     the whole order book — a one-PO upload used to report across 21 POs with no
//     baseline to compare against, which reads as "your file was wrong".
//
// pure: returns { mismatches:[{poNumber, skuCode, orderedQty, allocatedQty, delta}], checked }
function reconcile(orderLines, legs, legLines, { poNumbers = null } = {}) {
  const poByLeg = new Map(legs.map((l) => [l.id, l.poNumber]));
  // POs that HAVE at least one leg — the only ones an allocation can be expected for.
  const splitPos = new Set(legs.map((l) => l.poNumber));
  const inScope = (po) => splitPos.has(po) && (!poNumbers || poNumbers.has(po));

  const allocated = new Map(); // `${po}|${sku}` → qty
  legLines.forEach((ll) => {
    const po = poByLeg.get(ll.legId);
    if (!po || !inScope(po)) return;
    const k = `${po}|${ll.skuCode}`;
    allocated.set(k, (allocated.get(k) || 0) + (ll.allocatedQty || 0));
  });

  const ordered = new Map();
  orderLines.forEach((ol) => {
    if (!inScope(ol.poNumber)) return;
    const k = `${ol.poNumber}|${ol.skuCode}`;
    ordered.set(k, (ordered.get(k) || 0) + (ol.orderedQty || 0));
  });

  // union of keys (a SKU allocated but not ordered, or ordered but unallocated, both matter)
  const keys = new Set([...ordered.keys(), ...allocated.keys()]);
  const mismatches = [];
  keys.forEach((k) => {
    const o = ordered.get(k) || 0;
    const a = allocated.get(k) || 0;
    if (o !== a) {
      const [poNumber, skuCode] = k.split('|');
      mismatches.push({ poNumber, skuCode, orderedQty: o, allocatedQty: a, delta: a - o });
    }
  });
  return { mismatches, checked: keys.size };
}

module.exports = { reconcile };
