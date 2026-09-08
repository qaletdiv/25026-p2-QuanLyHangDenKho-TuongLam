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
  return new Map(bookings.map((b) => [b.id, idToStatusName.get(b.booking_status_id) || null]));
}

function liveBookingIds(bookings, idToStatusName, { excludeBookingId = null } = {}) {
  const names = bookingStatusNames(bookings, idToStatusName);
  return new Set(bookings.filter((b) => b.id !== excludeBookingId && isLive(names.get(b.id))).map((b) => b.id));
}

// G1: every requested PO must belong to the booking's supplier.
// Returns { ok, offending:[{po_number, supplier_id}] }.
function checkSupplierMatch(poNumbers, supplierId, poByNumber) {
  const offending = poNumbers
    .map((po) => ({ po_number: po, supplier_id: (poByNumber.get(po) || {}).supplier_id ?? null }))
    .filter((x) => x.supplier_id !== supplierId);
  return { ok: offending.length === 0, offending };
}

// G3: one destination facility across the booked POs (SMS has no mode axis).
// Returns { ok, facilities:[] } so the caller can report the conflict.
function checkSameConsignment(poNumbers, poByNumber) {
  const facilities = new Set(poNumbers.map((po) => (poByNumber.get(po) || {}).facility_id ?? null));
  return { ok: facilities.size <= 1, facilities: [...facilities] };
}

// ordered qty per PO (the booking/shipping capacity), Σ over sms_po_lines
function orderedByPo(poLines) {
  const ordered = new Map();
  poLines.forEach((l) => ordered.set(l.po_number, (ordered.get(l.po_number) || 0) + (Number(l.ordered_qty) || 0)));
  return ordered;
}

// units already held per PO by OTHER live bookings
function bookedUnitsByPo(bookings, bookingPos, idToStatusName, { excludeBookingId = null } = {}) {
  const live = liveBookingIds(bookings, idToStatusName, { excludeBookingId });
  const booked = new Map();
  bookingPos.forEach((bp) => {
    if (!live.has(bp.booking_id)) return;
    booked.set(bp.po_number, (booked.get(bp.po_number) || 0) + (Number(bp.units) || 0));
  });
  return booked;
}

// G2: soft overbooking — one warning per PO that would exceed its ordered total.
function overbookWarnings(entries, { ordered, bookedByPo }) {
  const warnings = [];
  entries.forEach((e) => {
    const cap = ordered.get(e.po_number) || 0;
    const already = bookedByPo.get(e.po_number) || 0;
    const requested = Number(e.units) || 0;
    if (already + requested > cap) {
      warnings.push({
        po_number: e.po_number,
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
  const heldBy = new Map();     // "po|lot" → booking_number
  const numberById = new Map(bookings.map((b) => [b.id, b.booking_number]));
  bookingPos.forEach((bp) => {
    if (!live.has(bp.booking_id)) return;
    heldBy.set(`${bp.po_number}|${bp.lot_number}`, numberById.get(bp.booking_id) || bp.booking_id);
  });
  return entries
    .filter((e) => e.lot_number != null && heldBy.has(`${e.po_number}|${e.lot_number}`))
    .map((e) => ({ po_number: e.po_number, lot_number: e.lot_number, booking_number: heldBy.get(`${e.po_number}|${e.lot_number}`) }));
}

// Next free lot for a PO: one past the highest lot already SHIPPED or BOOKED, so a
// booked-but-unshipped lot can't be handed out twice.
function nextLotForPo(poNumber, { shipmentPos, bookingPos }) {
  const mx = (rows) => rows.filter((r) => r.po_number === poNumber)
    .reduce((m, r) => Math.max(m, Number(r.lot_number) || 0), 0);
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
  const poByNumber = new Map(pos.map((p) => [p.po_number, p]));
  const byBooking = bookingPos.reduce((m, bp) => ((m[bp.booking_id] = m[bp.booking_id] || []).push(bp), m), {});
  // shipped units per (po, lot) → the booked-vs-shipped variance, derived
  const shippedByLot = new Map(shipmentPos.map((j) => [`${j.po_number}|${j.lot_number}`, Number(j.units) || 0]));

  return bookings.map((b) => {
    const myPos = (byBooking[b.id] || []).slice()
      .sort((x, y) => x.po_number.localeCompare(y.po_number) || (x.lot_number || 0) - (y.lot_number || 0));
    const seasonSet = [...new Set(myPos.map((bp) => seasonCode.get((poByNumber.get(bp.po_number) || {}).season_id)).filter(Boolean))];
    const facilitySet = [...new Set(myPos.map((bp) => (poByNumber.get(bp.po_number) || {}).facility_id).filter(Boolean))];
    const myShipments = shipments.filter((s) => s.booking_id === b.id);
    return {
      ...b,
      supplier_name: supName.get(b.supplier_id) || null,
      incoterm: incoName.get(b.incoterm_id) || null,
      // planned carrier + mode (names JOINED, never stored). Null on the bookings
      // created before 2026-08-24, when approve hardcoded FedEx instead.
      courier: courierName.get(b.courier_id) || null,
      mode: modeName.get(b.mode_id) || null,
      booking_status: idToStatusName.get(b.booking_status_id) || null,
      season: seasonSet.join(', ') || null,
      destination: facilitySet.map((f) => facName.get(f) || f).join(', ') || null,
      pos: myPos.map((bp) => ({
        ...bp,
        supplier: supName.get((poByNumber.get(bp.po_number) || {}).supplier_id) || null,
        shipped_units: shippedByLot.get(`${bp.po_number}|${bp.lot_number}`) ?? null,
      })),
      // totals — DERIVED from the junction, never stored. weight_kg is a decimal,
      // so the Σ is rounded to 2dp: adding 12.3 + 4.55 in binary float otherwise
      // surfaces as 16.849999999999998 in the UI.
      total_units: myPos.reduce((a, bp) => a + (Number(bp.units) || 0), 0),
      total_cartons: myPos.reduce((a, bp) => a + (Number(bp.cartons) || 0), 0),
      total_weight_kg: +myPos.reduce((a, bp) => a + (Number(bp.weight_kg) || 0), 0).toFixed(2),
      shipments: myShipments.map((s) => ({
        id: s.id,
        tracking_number: s.tracking_number || null,
        courier_id: s.courier_id || null,
        mode_id: s.mode_id || null,
        facility_id: s.facility_id || null,
        ship_date: s.ship_date || null,
        is_draft: !s.tracking_number,          // derived: approved but not yet shipped
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
