'use strict';

// R2 reconciliation — per (po_number, sku_code): ordered_qty (NetSuite, po_order_lines)
// vs Σ allocated_qty across that po_number's air/sea legs (WIP). Mismatches are
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
// pure: returns { mismatches:[{po_number, sku_code, ordered_qty, allocated_qty, delta}], checked }
function reconcile(orderLines, legs, legLines, { poNumbers = null } = {}) {
  const poByLeg = new Map(legs.map((l) => [l.id, l.po_number]));
  // POs that HAVE at least one leg — the only ones an allocation can be expected for.
  const splitPos = new Set(legs.map((l) => l.po_number));
  const inScope = (po) => splitPos.has(po) && (!poNumbers || poNumbers.has(po));

  const allocated = new Map(); // `${po}|${sku}` → qty
  legLines.forEach((ll) => {
    const po = poByLeg.get(ll.leg_id);
    if (!po || !inScope(po)) return;
    const k = `${po}|${ll.sku_code}`;
    allocated.set(k, (allocated.get(k) || 0) + (ll.allocated_qty || 0));
  });

  const ordered = new Map();
  orderLines.forEach((ol) => {
    if (!inScope(ol.po_number)) return;
    const k = `${ol.po_number}|${ol.sku_code}`;
    ordered.set(k, (ordered.get(k) || 0) + (ol.ordered_qty || 0));
  });

  // union of keys (a SKU allocated but not ordered, or ordered but unallocated, both matter)
  const keys = new Set([...ordered.keys(), ...allocated.keys()]);
  const mismatches = [];
  keys.forEach((k) => {
    const o = ordered.get(k) || 0;
    const a = allocated.get(k) || 0;
    if (o !== a) {
      const [po_number, sku_code] = k.split('|');
      mismatches.push({ po_number, sku_code, ordered_qty: o, allocated_qty: a, delta: a - o });
    }
  });
  return { mismatches, checked: keys.size };
}

module.exports = { reconcile };
