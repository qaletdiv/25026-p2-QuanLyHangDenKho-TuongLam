'use strict';

// Landed Cost derivations — all PURE (unit-testable), no IO. Everything the UI
// shows is DERIVED here at read time; the only thing persisted is the posted
// snapshot (invoice_value / freight / duty) written by the controller.
//
//   SMS basis      = commercial-invoice value = Σ (pcs_per_ctn × unit_price)
//                    over the shipment's packing cartons (the shipped-truth source).
//   freight        = ci_value × freight_pct / 100
//   duty           = ci_value × duty_pct / 100
//   per-PO split   = each amount apportioned by the PO's share of ci_value,
//                    largest-remainder rounded to cents so the parts sum EXACTLY
//                    to the whole (no penny drift across POs).

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Σ (pcs × unit_price) per PO for a shipment's cartons → Map<po_number, value>.
// (total_usd is derived, never stored on cartons, so we recompute from the parts.)
function ciValueByPo(cartons) {
  const m = new Map();
  for (const c of cartons) {
    const v = (Number(c.pcs_per_ctn) || 0) * (Number(c.unit_price) || 0);
    m.set(c.po_number, round2((m.get(c.po_number) || 0) + v));
  }
  return m;
}

// Apportion `total` dollars across `weights` (any units) so the pieces sum to
// EXACTLY total (to the cent). Largest-remainder method on integer cents.
function splitByValue(total, weights) {
  const totalCents = Math.round((Number(total) || 0) * 100);
  const sumW = weights.reduce((a, w) => a + (Number(w) || 0), 0);
  if (totalCents === 0 || sumW <= 0) return weights.map(() => 0);

  const exact = weights.map((w) => (totalCents * (Number(w) || 0)) / sumW);
  const floor = exact.map((x) => Math.floor(x));
  let remainder = totalCents - floor.reduce((a, x) => a + x, 0);
  // hand out the leftover cents to the largest fractional parts first
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  const cents = floor.slice();
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) cents[order[k].i] += 1;
  return cents.map((c) => c / 100);
}

// Given a shipment's CI value + a rate row, return the estimate totals.
function estimate(ciValue, rate) {
  const fPct = Number(rate?.freight_pct) || 0;
  const dPct = Number(rate?.duty_pct) || 0;
  return {
    freight_pct: fPct,
    duty_pct: dPct,
    freight: round2((Number(ciValue) || 0) * fPct / 100),
    duty: round2((Number(ciValue) || 0) * dPct / 100),
  };
}

// Build the per-PO split rows for a set of POs given their CI values and the
// freight/duty totals. Returns [{ po_number, ci_value, freight, duty }] summing
// to the totals exactly.
function splitByPo(poValues, freightTotal, dutyTotal) {
  const entries = [...poValues.entries()];              // [ [po, value], ... ]
  const weights = entries.map(([, v]) => v);
  const fParts = splitByValue(freightTotal, weights);
  const dParts = splitByValue(dutyTotal, weights);
  return entries.map(([po_number, ci_value], i) => ({
    po_number, ci_value, freight: fParts[i], duty: dParts[i],
  }));
}

module.exports = { ciValueByPo, splitByValue, estimate, splitByPo, round2 };
