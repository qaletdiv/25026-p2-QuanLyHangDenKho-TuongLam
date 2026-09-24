'use strict';

// Mainline booking service — enrichment + pure business helpers (G1 vendor match,
// G2 leg-capacity overbooking). Pure functions are exported for unit testing.

// legId → supplierId, resolved leg → po_order → po_master.
function legSupplierMap(legs, orders, masters) {
  const orderByPo = new Map(orders.map((o) => [o.poNumber, o]));
  const masterByTrn = new Map(masters.map((m) => [m.trnNumber, m]));
  const m = new Map();
  legs.forEach((leg) => {
    const order = orderByPo.get(leg.poNumber);
    const master = order && masterByTrn.get(order.trnNumber);
    m.set(leg.id, master ? master.supplierId : null);
  });
  return m;
}

// G1: every requested leg must belong to the booking's supplier.
// Returns { ok, offending:[{legId, supplierId}] }.
function checkVendorMatch(legIds, supplierId, legSupplierById) {
  const offending = legIds
    .map((id) => ({ legId: id, supplierId: legSupplierById.get(id) ?? null }))
    .filter((x) => x.supplierId !== supplierId);
  return { ok: offending.length === 0, offending };
}

// G3: multiple POs can share one booking/shipment only when they go to the SAME
// destination facility by the SAME mode (supplier already enforced by G1). Returns
// { ok, facilities:[], modes:[] } so the caller can report what conflicts.
function checkSameConsignment(legIds, { legs, orders }) {
  const orderByPo = new Map(orders.map((o) => [o.poNumber, o]));
  const legById = new Map(legs.map((l) => [l.id, l]));
  const facilities = new Set(), modes = new Set();
  legIds.forEach((id) => {
    const leg = legById.get(id) || {};
    const order = orderByPo.get(leg.poNumber) || {};
    facilities.add(order.facilityId ?? null);
    modes.add(leg.modeId ?? null);
  });
  return { ok: facilities.size <= 1 && modes.size <= 1, facilities: [...facilities], modes: [...modes] };
}

/**
 * G4 — a leg whose PO NetSuite has NOT approved cannot be booked (2026-09-09).
 *
 * Approval is a money gate: booking reserves space and commits the supplier, and
 * a PO awaiting supervisor sign-off may still change or be rejected outright.
 * Until now nothing stopped it — the portal didn't even display the difference.
 *
 * HARD refusal, deliberately: no `force_` bypass like G2's overbooking. G2 is soft
 * because shipping a bit over allocation is a real, routine call for a coordinator
 * to make; "book it before the supervisor approves it" is not theirs to make.
 *
 * Only an explicit 'Pending Approval' / 'Rejected' blocks. NULL means NetSuite has
 * no value for that PO (older closed POs carry none) and must NOT block — treating
 * absence as disapproval would refuse legitimate bookings on historical POs.
 *
 * @returns {{ok: boolean, offending: Array<{legId, poNumber, approvalStatus}>}}
 */
const BOOKING_BLOCKING_APPROVAL = new Set(['Pending Approval', 'Rejected']);

function checkApproved(legIds, { legs, orders }) {
  const orderByPo = new Map(orders.map((o) => [o.poNumber, o]));
  const legById = new Map(legs.map((l) => [l.id, l]));
  const offending = legIds
    .map((id) => {
      const leg = legById.get(id) || {};
      const order = orderByPo.get(leg.poNumber) || {};
      return { legId: id, poNumber: leg.poNumber ?? null, approvalStatus: order.approvalStatus ?? null };
    })
    .filter((x) => BOOKING_BLOCKING_APPROVAL.has(String(x.approvalStatus)));
  return { ok: offending.length === 0, offending };
}

// leg capacity = Σ allocatedQty of that leg's lines (the air/sea allocation).
function legCapacities(legLines) {
  const cap = new Map();
  legLines.forEach((l) => cap.set(l.legId, (cap.get(l.legId) || 0) + (l.allocatedQty || 0)));
  return cap;
}

// units already booked per leg across non-cancelled/rejected bookings.
function bookedUnitsByLeg(bookings, bookingLegs, { excludeBookingId } = {}) {
  const liveBookingIds = new Set(
    bookings.filter((b) => !['Cancelled', 'Rejected'].includes(b._status_name) && b.id !== excludeBookingId).map((b) => b.id)
  );
  const booked = new Map();
  bookingLegs.forEach((bl) => {
    if (!liveBookingIds.has(bl.bookingId)) return;
    booked.set(bl.legId, (booked.get(bl.legId) || 0) + (Number(bl.units) || 0));
  });
  return booked;
}

// G2: soft overbooking — returns one warning per leg that would exceed capacity.
function overbookWarnings(requestedLegs, { capacities, bookedByLeg, legPo }) {
  const warnings = [];
  requestedLegs.forEach((rl) => {
    const cap = capacities.get(rl.legId) || 0;
    const already = bookedByLeg.get(rl.legId) || 0;
    const requested = Number(rl.units) || 0;
    if (already + requested > cap) {
      warnings.push({
        legId: rl.legId,
        poNumber: legPo.get(rl.legId) || null,
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
function enrichBookings(bookings, { bookingLegs, legs, suppliers, modes = [], orders = [], masters = [], seasons = [], couriers = [], idToStatusName }) {
  const supName = new Map(suppliers.map((s) => [s.id, s.name]));
  const legById = new Map(legs.map((l) => [l.id, l]));
  const modeName = new Map(modes.map((m) => [m.id, m.name]));
  const courierName = new Map(couriers.map((cr) => [cr.id, cr.name]));
  const orderByPo = new Map(orders.map((o) => [o.poNumber, o]));
  const masterByTrn = new Map(masters.map((m) => [m.trnNumber, m]));
  const seasonCode = new Map(seasons.map((s) => [s.id, s.code]));
  const byBooking = bookingLegs.reduce((m, bl) => ((m[bl.bookingId] = m[bl.bookingId] || []).push(bl), m), {});
  const seasonOfLeg = (leg) => {
    const order = orderByPo.get(leg.poNumber) || {};
    const master = masterByTrn.get(order.trnNumber) || {};
    return seasonCode.get(master.seasonId) || null;
  };
  return bookings.map((b) => {
    const myLegs = (byBooking[b.id] || []).map((bl) => legById.get(bl.legId) || {});
    const poLegs = (byBooking[b.id] || []).map((bl) => {
      const leg = legById.get(bl.legId) || {};
      return { ...bl, poNumber: leg.poNumber || null, mode: modeName.get(leg.modeId) || null };
    });
    const seasonSet = [...new Set(myLegs.map(seasonOfLeg).filter(Boolean))];
    // Cargo Ready falls back to the WIP leg CRD (latest across the booked legs) when
    // unset — covers bookings created before it was seeded; a stored value wins.
    const crds = myLegs.map((l) => l.crd).filter(Boolean);
    const legCrd = crds.length ? crds.reduce((a, c) => (c > a ? c : a)) : null;
    return {
      ...b,
      supplierName: supName.get(b.supplierId) || null,
      // PLANNED carrier (name JOINED, never stored). Null on bookings made before
      // 2026-08-24 and on any booking that did not name one.
      courier: courierName.get(b.courierId) || null,
      bookingStatus: idToStatusName.get(b.bookingStatusId) || null,
      mode: [...new Set(poLegs.map((l) => l.mode).filter(Boolean))].join(', ') || null,
      season: seasonSet.join(', ') || null,
      cargoReadyDate: b.cargoReadyDate ?? legCrd,
      poLegs,
    };
  });
}

module.exports = {
  legSupplierMap, checkVendorMatch, checkSameConsignment, checkApproved,
  legCapacities, bookedUnitsByLeg, overbookWarnings, enrichBookings,
};
