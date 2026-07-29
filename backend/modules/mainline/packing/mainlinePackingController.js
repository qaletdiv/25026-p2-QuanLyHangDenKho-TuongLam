'use strict';

// GET /mainline/bookings/:id/packing — cartons + computed summary (the summary
// is a VIEW over the carton rows, never stored — replaces shipment_data.summary{}).
const MainlinePackingModel = require('./MainlinePackingModel');
const MainlineBookingModel = require('../bookings/MainlineBookingModel');
const MainlineLegModel = require('../legs/MainlineLegModel');

function summarize(cartons) {
  const seen = new Set();
  let total_pcs = 0, total_value = 0, total_net_weight = 0, total_gross_weight = 0, total_cbm = 0;
  for (const c of cartons) {
    total_pcs += c.pcs_per_ctn || 0;
    total_value += c.total_usd || 0;
    // key by (leg, ctn): two POs in one booking may both number cartons from #1,
    // so ctn_number alone would collapse distinct physical cartons.
    const ck = `${c.leg_id}|${c.ctn_number}`;
    if (!seen.has(ck)) {
      seen.add(ck);
      total_net_weight += c.net_weight_kgs || 0;
      total_gross_weight += c.gross_weight_kgs || 0;
      const m = (c.measure_cm || '').split(/[*×xX]/).map((p) => parseFloat(p.trim()));
      if (m.length === 3 && m.every((v) => !isNaN(v))) total_cbm += (m[0] * m[1] * m[2]) / 1_000_000;
    }
  }
  return {
    total_pcs,
    total_cartons: seen.size,
    total_value: +total_value.toFixed(2),
    total_net_weight: +total_net_weight.toFixed(2),
    total_gross_weight: +total_gross_weight.toFixed(2),
    total_cbm: +total_cbm.toFixed(3),
  };
}

async function getPacking(req, res) {
  const [bookings, legs, allCartons] = await Promise.all([
    MainlineBookingModel.readBookings(), MainlineLegModel.readLegs(), MainlinePackingModel.read(),
  ]);
  if (!bookings.some((b) => b.id === req.params.id)) { const e = new Error('Booking not found'); e.statusCode = 404; throw e; }
  const cartons = allCartons.filter((c) => c.booking_id === req.params.id);

  // per-PO (leg) actual rollup — same summarize() view, grouped by leg → po_number
  const legPo = new Map(legs.map((l) => [String(l.id), l.po_number]));
  const byLeg = new Map();
  cartons.forEach((c) => { const k = String(c.leg_id); (byLeg.get(k) || byLeg.set(k, []).get(k)).push(c); });
  const by_po = [...byLeg.entries()]
    .map(([legId, rows]) => ({ leg_id: legId === 'null' ? null : legId, po_number: legPo.get(legId) || null, ...summarize(rows) }))
    .sort((a, b) => (a.po_number || '').localeCompare(b.po_number || ''));

  res.json({ booking_id: req.params.id, cartons, summary: summarize(cartons), by_po });
}

module.exports = { getPacking, summarize };
