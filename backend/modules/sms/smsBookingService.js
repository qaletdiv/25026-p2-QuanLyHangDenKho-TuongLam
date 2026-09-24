'use strict';

// SMS booking service — enrichment + PURE business helpers (exported for unit
// testing, mirroring mainlineBookingService). The SMS analogues of the mainline
// booking guards:
//
//   G1-SMS same-supplier : every booked PO must belong to the booking's supplier.
//   G2-SMS overbooking   : Σ booked units per (po, lot) may not exceed the PO's
//                          ordered total minus what other LIVE bookings hold.
//                          Soft — 409 + force_overbook, mirroring overship.
//   G3-SMS consignment   : the booked POs must share ONE destination facility.
//                          Mode is NOT a grouping key (unlike mainline): the booking
//                          STATES one carrier + one mode for the whole consignment,
//                          so there is nothing to split on.
//   lot-not-double-booked: a lot may sit on at most one LIVE booking. Enforced
//                          here, NOT as a unique index: a Cancelled/Rejected
//                          booking must leave the lot re-bookable.
//
// "LIVE" = a booking whose status is neither Cancelled nor Rejected.

const DEAD_STATUSES = ['Cancelled', 'Rejected'];

const isLive = (statusName) => !DEAD_STATUSES.includes(statusName || '');

// booking id → status NAME, for the live/dead test
function bookingStatusNames(bookings, idToStatusName) {
  return new Map(bookings.map((b) => [b.id, idToStatusName.get(b.bookingStatusId) || null]));
}

function liveBookingIds(bookings, idToStatusName, { excludeBookingId = null } = {}) {
  const names = bookingStatusNames(bookings, idToStatusName);
  return new Set(bookings.filter((b) => b.id !== excludeBookingId && isLive(names.get(b.id))).map((b) => b.id));
}

// G1: every requested PO must belong to the booking's supplier.
// Returns { ok, offending:[{poNumber, supplierId}] }.
function checkSupplierMatch(poNumbers, supplierId, poByNumber) {
  const offending = poNumbers
    .map((po) => ({ poNumber: po, supplierId: (poByNumber.get(po) || {}).supplierId ?? null }))
    .filter((x) => x.supplierId !== supplierId);
  return { ok: offending.length === 0, offending };
}

// G3: one destination facility across the booked POs (SMS has no mode axis).
// Returns { ok, facilities:[] } so the caller can report the conflict.
function checkSameConsignment(poNumbers, poByNumber) {
  const facilities = new Set(poNumbers.map((po) => (poByNumber.get(po) || {}).facilityId ?? null));
  return { ok: facilities.size <= 1, facilities: [...facilities] };
}

// ordered qty per PO (the booking/shipping capacity), Σ over sms_po_lines
function orderedByPo(poLines) {
  const ordered = new Map();
  poLines.forEach((l) => ordered.set(l.poNumber, (ordered.get(l.poNumber) || 0) + (Number(l.orderedQty) || 0)));
  return ordered;
}

// units already held per PO by OTHER live bookings
function bookedUnitsByPo(bookings, bookingPos, idToStatusName, { excludeBookingId = null } = {}) {
  const live = liveBookingIds(bookings, idToStatusName, { excludeBookingId });
  const booked = new Map();
  bookingPos.forEach((bp) => {
    if (!live.has(bp.bookingId)) return;
    booked.set(bp.poNumber, (booked.get(bp.poNumber) || 0) + (Number(bp.units) || 0));
  });
  return booked;
}

// G2: soft overbooking — one warning per PO that would exceed its ordered total.
function overbookWarnings(entries, { ordered, bookedByPo }) {
  const warnings = [];
  entries.forEach((e) => {
    const cap = ordered.get(e.poNumber) || 0;
    const already = bookedByPo.get(e.poNumber) || 0;
    const requested = Number(e.units) || 0;
    if (already + requested > cap) {
      warnings.push({
        poNumber: e.poNumber,
        ordered: cap,
        already_booked: already,
        requested,
        overage: already + requested - cap,
      });
    }
  });
  return warnings;
}

// lot-not-double-booked: a (po, lot) already held by another LIVE booking is a
// hard conflict (not force-able — it would double-authorize the same goods).
function lotConflicts(entries, bookings, bookingPos, idToStatusName, { excludeBookingId = null } = {}) {
  const live = liveBookingIds(bookings, idToStatusName, { excludeBookingId });
  const heldBy = new Map();     // "po|lot" → bookingNumber
  const numberById = new Map(bookings.map((b) => [b.id, b.bookingNumber]));
  bookingPos.forEach((bp) => {
    if (!live.has(bp.bookingId)) return;
    heldBy.set(`${bp.poNumber}|${bp.lotNumber}`, numberById.get(bp.bookingId) || bp.bookingId);
  });
  return entries
    .filter((e) => e.lotNumber != null && heldBy.has(`${e.poNumber}|${e.lotNumber}`))
    .map((e) => ({ poNumber: e.poNumber, lotNumber: e.lotNumber, bookingNumber: heldBy.get(`${e.poNumber}|${e.lotNumber}`) }));
}

// Next free lot for a PO: one past the highest lot already SHIPPED or BOOKED, so a
// booked-but-unshipped lot can't be handed out twice.
function nextLotForPo(poNumber, { shipmentPos, bookingPos }) {
  const mx = (rows) => rows.filter((r) => r.poNumber === poNumber)
    .reduce((m, r) => Math.max(m, Number(r.lotNumber) || 0), 0);
  return Math.max(mx(shipmentPos), mx(bookingPos)) + 1;
}

// Enrich bookings for API responses. Supplier/status/season/incoterm names are
// JOINED, never stored on the row. Totals are Σ over the junction (derived).
// `shipments` = the draft/real consignments this booking produced (1:N).
function enrichBookings(bookings, {
  bookingPos, pos, shipments = [], shipmentPos = [], suppliers = [], incoterms = [],
  seasons = [], facilities = [], couriers = [], modes = [], idToStatusName,
}) {
  const supName = new Map(suppliers.map((s) => [s.id, s.name]));
  const incoName = new Map(incoterms.map((i) => [i.id, i.name]));
  const courierName = new Map(couriers.map((cr) => [cr.id, cr.name]));
  const modeName = new Map(modes.map((m) => [m.id, m.name]));
  const seasonCode = new Map(seasons.map((s) => [s.id, s.code]));
  const facName = new Map(facilities.map((f) => [f.id, f.name]));
  const poByNumber = new Map(pos.map((p) => [p.poNumber, p]));
  const byBooking = bookingPos.reduce((m, bp) => ((m[bp.bookingId] = m[bp.bookingId] || []).push(bp), m), {});
  // shipped units per (po, lot) → the booked-vs-shipped variance, derived
  const shippedByLot = new Map(shipmentPos.map((j) => [`${j.poNumber}|${j.lotNumber}`, Number(j.units) || 0]));

  return bookings.map((b) => {
    const myPos = (byBooking[b.id] || []).slice()
      .sort((x, y) => x.poNumber.localeCompare(y.poNumber) || (x.lotNumber || 0) - (y.lotNumber || 0));
    const seasonSet = [...new Set(myPos.map((bp) => seasonCode.get((poByNumber.get(bp.poNumber) || {}).seasonId)).filter(Boolean))];
    const facilitySet = [...new Set(myPos.map((bp) => (poByNumber.get(bp.poNumber) || {}).facilityId).filter(Boolean))];
    const myShipments = shipments.filter((s) => s.bookingId === b.id);
    return {
      ...b,
      supplierName: supName.get(b.supplierId) || null,
      incoterm: incoName.get(b.incotermId) || null,
      // planned carrier + mode (names JOINED, never stored). Null on the bookings
      // created before 2026-08-24, when approve hardcoded FedEx instead.
      courier: courierName.get(b.courierId) || null,
      mode: modeName.get(b.modeId) || null,
      bookingStatus: idToStatusName.get(b.bookingStatusId) || null,
      season: seasonSet.join(', ') || null,
      destination: facilitySet.map((f) => facName.get(f) || f).join(', ') || null,
      pos: myPos.map((bp) => ({
        ...bp,
        supplier: supName.get((poByNumber.get(bp.poNumber) || {}).supplierId) || null,
        shippedUnits: shippedByLot.get(`${bp.poNumber}|${bp.lotNumber}`) ?? null,
      })),
      // totals — DERIVED from the junction, never stored. weightKg is a decimal,
      // so the Σ is rounded to 2dp: adding 12.3 + 4.55 in binary float otherwise
      // surfaces as 16.849999999999998 in the UI.
      totalUnits: myPos.reduce((a, bp) => a + (Number(bp.units) || 0), 0),
      totalCartons: myPos.reduce((a, bp) => a + (Number(bp.cartons) || 0), 0),
      totalWeightKg: +myPos.reduce((a, bp) => a + (Number(bp.weightKg) || 0), 0).toFixed(2),
      shipments: myShipments.map((s) => ({
        id: s.id,
        trackingNumber: s.trackingNumber || null,
        courierId: s.courierId || null,
        modeId: s.modeId || null,
        facilityId: s.facilityId || null,
        shipDate: s.shipDate || null,
        isDraft: !s.trackingNumber,          // derived: approved but not yet shipped
      })),
    };
  });
}

module.exports = {
  isLive, bookingStatusNames, liveBookingIds,
  checkSupplierMatch, checkSameConsignment,
  orderedByPo, bookedUnitsByPo, overbookWarnings, lotConflicts, nextLotForPo,
  enrichBookings,
};
