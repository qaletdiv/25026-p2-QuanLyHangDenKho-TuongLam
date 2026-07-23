'use strict';

// Mainline booking service — enrichment + pure business helpers (G1 vendor match,
// G2 leg-capacity overbooking). Pure functions are exported for unit testing.

// leg_id → supplier_id, resolved leg → po_order → po_master.
function legSupplierMap(legs, orders, masters) {
  const orderByPo = new Map(orders.map((o) => [o.po_number, o]));
  const masterByTrn = new Map(masters.map((m) => [m.trn_number, m]));
  const m = new Map();
  legs.forEach((leg) => {
    const order = orderByPo.get(leg.po_number);
    const master = order && masterByTrn.get(order.trn_number);
    m.set(leg.id, master ? master.supplier_id : null);
  });
  return m;
}

// G1: every requested leg must belong to the booking's supplier.
// Returns { ok, offending:[{leg_id, supplier_id}] }.
function checkVendorMatch(legIds, supplierId, legSupplierById) {
  const offending = legIds
    .map((id) => ({ leg_id: id, supplier_id: legSupplierById.get(id) ?? null }))
    .filter((x) => x.supplier_id !== supplierId);
  return { ok: offending.length === 0, offending };
}

// G3: multiple POs can share one booking/shipment only when they go to the SAME
// destination facility by the SAME mode (supplier already enforced by G1). Returns
// { ok, facilities:[], modes:[] } so the caller can report what conflicts.
function checkSameConsignment(legIds, { legs, orders }) {
  const orderByPo = new Map(orders.map((o) => [o.po_number, o]));
  const legById = new Map(legs.map((l) => [l.id, l]));
  const facilities = new Set(), modes = new Set();
  legIds.forEach((id) => {
    const leg = legById.get(id) || {};
    const order = orderByPo.get(leg.po_number) || {};
    facilities.add(order.facility_id ?? null);
    modes.add(leg.mode_id ?? null);
  });
  return { ok: facilities.size <= 1 && modes.size <= 1, facilities: [...facilities], modes: [...modes] };
}

// leg capacity = Σ allocated_qty of that leg's lines (the air/sea allocation).
function legCapacities(legLines) {
  const cap = new Map();
  legLines.forEach((l) => cap.set(l.leg_id, (cap.get(l.leg_id) || 0) + (l.allocated_qty || 0)));
  return cap;
}

// units already booked per leg across non-cancelled/rejected bookings.
function bookedUnitsByLeg(bookings, bookingLegs, { excludeBookingId } = {}) {
  const liveBookingIds = new Set(
    bookings.filter((b) => !['Cancelled', 'Rejected'].includes(b._status_name) && b.id !== excludeBookingId).map((b) => b.id)
  );
  const booked = new Map();
  bookingLegs.forEach((bl) => {
    if (!liveBookingIds.has(bl.booking_id)) return;
    booked.set(bl.leg_id, (booked.get(bl.leg_id) || 0) + (Number(bl.units) || 0));
  });
  return booked;
}

// G2: soft overbooking — returns one warning per leg that would exceed capacity.
function overbookWarnings(requestedLegs, { capacities, bookedByLeg, legPo }) {
  const warnings = [];
  requestedLegs.forEach((rl) => {
    const cap = capacities.get(rl.leg_id) || 0;
    const already = bookedByLeg.get(rl.leg_id) || 0;
    const requested = Number(rl.units) || 0;
    if (already + requested > cap) {
      warnings.push({
        leg_id: rl.leg_id,
        po_number: legPo.get(rl.leg_id) || null,
        already_booked: already,
        capacity: cap,
        requested,
        overage: already + requested - cap,
      });
    }
  });
  return warnings;
}

// Enrich bookings for API responses: supplier name, status name, mode, season,
// nested legs. Mode (Air/Sea) matters to the forwarder; G3 keeps one mode per
// booking, but we derive the distinct set defensively (joined) plus per-leg mode.
// Season is DERIVED (leg → po_order → po_master → season code) for the season
// filter — a booking normally has one season; the distinct set is joined defensively.
function enrichBookings(bookings, { bookingLegs, legs, suppliers, modes = [], orders = [], masters = [], seasons = [], idToStatusName }) {
  const supName = new Map(suppliers.map((s) => [s.id, s.name]));
  const legById = new Map(legs.map((l) => [l.id, l]));
  const modeName = new Map(modes.map((m) => [m.id, m.name]));
  const orderByPo = new Map(orders.map((o) => [o.po_number, o]));
  const masterByTrn = new Map(masters.map((m) => [m.trn_number, m]));
  const seasonCode = new Map(seasons.map((s) => [s.id, s.code]));
  const byBooking = bookingLegs.reduce((m, bl) => ((m[bl.booking_id] = m[bl.booking_id] || []).push(bl), m), {});
  const seasonOfLeg = (leg) => {
    const order = orderByPo.get(leg.po_number) || {};
    const master = masterByTrn.get(order.trn_number) || {};
    return seasonCode.get(master.season_id) || null;
  };
  return bookings.map((b) => {
    const myLegs = (byBooking[b.id] || []).map((bl) => legById.get(bl.leg_id) || {});
    const po_legs = (byBooking[b.id] || []).map((bl) => {
      const leg = legById.get(bl.leg_id) || {};
      return { ...bl, po_number: leg.po_number || null, mode: modeName.get(leg.mode_id) || null };
    });
    const seasonSet = [...new Set(myLegs.map(seasonOfLeg).filter(Boolean))];
    return {
      ...b,
      supplier_name: supName.get(b.supplier_id) || null,
      booking_status: idToStatusName.get(b.booking_status_id) || null,
      mode: [...new Set(po_legs.map((l) => l.mode).filter(Boolean))].join(', ') || null,
      season: seasonSet.join(', ') || null,
      po_legs,
    };
  });
}

module.exports = {
  legSupplierMap, checkVendorMatch, checkSameConsignment, legCapacities, bookedUnitsByLeg,
  overbookWarnings, enrichBookings,
};
