'use strict';

// R2 reconciliation — per (po_number, sku_code): ordered_qty (NetSuite, po_order_lines)
// vs Σ allocated_qty across that po_number's air/sea legs (WIP). Mismatches are
// flagged for review, never auto-resolved.

// pure: returns { mismatches:[{po_number, sku_code, ordered_qty, allocated_qty, delta}], checked }
function reconcile(orderLines, legs, legLines) {
  const poByLeg = new Map(legs.map((l) => [l.id, l.po_number]));

  const allocated = new Map(); // `${po}|${sku}` → qty
  legLines.forEach((ll) => {
    const po = poByLeg.get(ll.leg_id);
    if (!po) return;
    const k = `${po}|${ll.sku_code}`;
    allocated.set(k, (allocated.get(k) || 0) + (ll.allocated_qty || 0));
  });

  const ordered = new Map();
  orderLines.forEach((ol) => ordered.set(`${ol.po_number}|${ol.sku_code}`, (ordered.get(`${ol.po_number}|${ol.sku_code}`) || 0) + (ol.ordered_qty || 0)));

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
