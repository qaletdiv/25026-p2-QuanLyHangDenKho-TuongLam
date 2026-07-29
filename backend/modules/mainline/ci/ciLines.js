'use strict';

// CI line items are DERIVED from mainline_packing_cartons — not stored (folded
// 2026-07-07). Both used to be written from the same shipment-data upload, so the
// packing cartons are the single source. This reproduces the EXACT former write
// logic (per (booking, sku): qty = Σ pcs_per_ctn, weight = Σ net_weight_kgs,
// cbm = Σ from measure_cm; matched_leg_id = the carton's leg; ids `cil_<booking>_<n>`)
// so every consumer sees byte-identical output to the old stored table.

const cbmOf = (measure) => {
  const d = String(measure || '').split(/[*×xX]/).map((p) => parseFloat(p.trim()));
  return d.length === 3 && d.every((v) => !isNaN(v)) ? (d[0] * d[1] * d[2]) / 1e6 : 0;
};

// CI lines for ONE booking, from that booking's cartons (filters internally).
// Grouped per (LEG, sku): a consolidated booking can carry the SAME style-color SKU
// under more than one leg (two POs, or the air+sea split of one PO), and those must
// stay as separate lines — keying by sku alone would collapse them onto one leg and
// mis-attribute shipped quantities. Mirrors how the CI document keys by (po, sku).
function linesForBooking(cartons, bookingId) {
  const bySku = new Map();
  for (const c of cartons) {
    if (c.booking_id !== bookingId || !c.sku_code) continue;
    const legKey = c.leg_id || null;
    const key = `${legKey}||${c.sku_code}`;
    const cur = bySku.get(key) || { sku_code: c.sku_code, matched_leg_id: legKey, qty: 0, weight_kg: 0, cbm: 0 };
    cur.qty += Number(c.pcs_per_ctn) || 0;
    cur.weight_kg += Number(c.net_weight_kgs) || 0;
    cur.cbm += cbmOf(c.measure_cm);
    bySku.set(key, cur);
  }
  return [...bySku.values()].map((x, i) => ({
    id: `cil_${bookingId}_${i + 1}`,
    invoice_id: `ci_${bookingId}`,
    sku_code: x.sku_code,
    matched_leg_id: x.matched_leg_id,
    qty: x.qty,
    weight_kg: +x.weight_kg.toFixed(2),
    cbm: +x.cbm.toFixed(3),
    match_status: x.matched_leg_id ? 'matched' : 'unmatched',
  }));
}

// CI lines for EVERY booking present in the cartons (for the fulfillment match).
function deriveAllCiLines(cartons) {
  const bookingIds = [...new Set(cartons.map((c) => c.booking_id))];
  return bookingIds.flatMap((bid) => linesForBooking(cartons, bid));
}

module.exports = { linesForBooking, deriveAllCiLines, cbmOf };
