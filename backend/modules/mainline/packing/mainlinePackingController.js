'use strict';

// GET /mainline/bookings/:id/packing — cartons + computed summary (the summary
// is a VIEW over the carton rows, never stored — replaces shipment_data.summary{}).
const { models } = require('../../../models');
const { assertBookingVisible } = require('../vendorAccess');

function summarize(cartons) {
  const seen = new Set();
  let totalPcs = 0, totalValue = 0, totalNetWeight = 0, totalGrossWeight = 0, totalCbm = 0;
  for (const c of cartons) {
    totalPcs += c.pcsPerCtn || 0;
    totalValue += c.totalUsd || 0;
    // key by (leg, ctn): two POs in one booking may both number cartons from #1,
    // so ctnNumber alone would collapse distinct physical cartons.
    const ck = `${c.legId}|${c.ctnNumber}`;
    if (!seen.has(ck)) {
      seen.add(ck);
      totalNetWeight += c.netWeightKgs || 0;
      totalGrossWeight += c.grossWeightKgs || 0;
      const m = (c.measureCm || '').split(/[*×xX]/).map((p) => parseFloat(p.trim()));
      if (m.length === 3 && m.every((v) => !isNaN(v))) totalCbm += (m[0] * m[1] * m[2]) / 1_000_000;
    }
  }
  return {
    totalPcs,
    totalCartons: seen.size,
    totalValue: +totalValue.toFixed(2),
    totalNetWeight: +totalNetWeight.toFixed(2),
    totalGrossWeight: +totalGrossWeight.toFixed(2),
    totalCbm: +totalCbm.toFixed(3),
  };
}

async function getPacking(req, res) {
  await assertBookingVisible(req, req.params.id);
  const [bookings, legs, allCartons] = await Promise.all([
    models.mainline_bookings.read(), models.mainline_po_legs.read(), models.mainline_packing_cartons.read(),
  ]);
  if (!bookings.some((b) => b.id === req.params.id)) { const e = new Error('Booking not found'); e.statusCode = 404; throw e; }
  const cartons = allCartons.filter((c) => c.bookingId === req.params.id);

  // per-PO (leg) actual rollup — same summarize() view, grouped by leg → poNumber
  const legPo = new Map(legs.map((l) => [String(l.id), l.poNumber]));
  const byLeg = new Map();
  cartons.forEach((c) => { const k = String(c.legId); (byLeg.get(k) || byLeg.set(k, []).get(k)).push(c); });
  const by_po = [...byLeg.entries()]
    .map(([legId, rows]) => ({ legId: legId === 'null' ? null : legId, poNumber: legPo.get(legId) || null, ...summarize(rows) }))
    .sort((a, b) => (a.poNumber || '').localeCompare(b.poNumber || ''));

  res.json({ bookingId: req.params.id, cartons, summary: summarize(cartons), by_po });
}

module.exports = { getPacking, summarize };
