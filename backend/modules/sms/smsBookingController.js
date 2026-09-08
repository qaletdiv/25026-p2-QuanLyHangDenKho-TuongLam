'use strict';

// SMS bookings — the OPTIONAL authorization step (added 2026-08-07).
//
// A courier consignment reserves no space, so most SMS shipments are still entered
// straight by the vendor with no booking. A booking is used when the consignment is
// planned up front and will clear customs formally: Vendor submits → Logistics
// approves → approval creates one DRAFT shipment per destination facility (tracking
// number filled in later, when the box actually ships). The resulting shipment
// carries ACTUAL freight/duty off the broker bill, like a mainline shipment.
//
// Guards (server-side; see smsBookingService for the pure helpers):
//   G1-SMS same-supplier      — every booked PO belongs to the booking's supplier
//   G2-SMS overbooking        — soft, 409 + force_overbook
//   G3-SMS same-consignment   — one destination facility per booking
//   lot-not-double-booked     — HARD (no force): a lot may sit on one live booking
//   Pending-only mutation     — edit/delete blocked once approved/rejected
//
// Vendors are scoped to their own supplier throughout (JWT carries {id, role} only).

const M = require('./SmsModels');
const svc = require('./smsBookingService');
const { resolveVendorSupplierId } = require('../../utils/vendorScope');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };

const STATUS = {
  pending:   'sms_bk_pending',
  approved:  'sms_bk_approved',
  rejected:  'sms_bk_rejected',
  cancelled: 'sms_bk_cancelled',
};

// Vendor scoping lives in utils/vendorScope (one copy, was four).
const _vendorSupplierId = (user) => resolveVendorSupplierId(user);

async function _ctx() {
  const [bookings, bookingPos, shipments, shipmentPos, pos, poLines, statuses, suppliers, incoterms, seasons, facilities, couriers, modes] =
    await Promise.all([
      M.bookings.read().catch(() => []), M.bookingPos.read().catch(() => []),
      M.shipments.read(), M.shipmentPos.read(), M.pos.read(), M.poLines.read(),
      M.statuses.read(), M.suppliers.read().catch(() => []), M.incoterms.read().catch(() => []),
      M.seasons.read().catch(() => []), M.facilities.read(), M.couriers.read().catch(() => []),
      M.modes.read().catch(() => []),
    ]);
  return {
    bookings, bookingPos, shipments, shipmentPos, pos, poLines, suppliers, incoterms, seasons, facilities, couriers, modes,
    idToStatusName: new Map(statuses.map((s) => [s.id, s.name])),
    poByNumber: new Map(pos.map((p) => [p.po_number, p])),
  };
}

const _enrichOne = (b, c) => svc.enrichBookings([b], { ...c })[0];

// Vendor scope: a booking is theirs when every booked PO is theirs.
// ONE definition of "is this booking the vendor's", shared by the read path (which
// turns a false into a 404) and the write paths (which raise 403). ALL of a booking's
// POs must be theirs — G1 already enforces one supplier per booking, so a mixed
// booking is an anomaly and failing closed is right.
//
// The `!rows.length` guard matters: `[].every(...)` is `true`, so without it a
// booking carrying NO junction rows would read as owned by EVERY vendor.
function _vendorOwnsBooking(bookingId, c, vendorSupplierId) {
  const rows = c.bookingPos.filter((bp) => bp.booking_id === bookingId);
  if (!rows.length) return false;
  return rows.every((bp) =>
    String((c.poByNumber.get(bp.po_number) || {}).supplier_id) === String(vendorSupplierId));
}

function _assertVendorOwns(bookingId, c, vendorSupplierId) {
  if (!vendorSupplierId) return;
  if (!_vendorOwnsBooking(bookingId, c, vendorSupplierId)) {
    err("This booking carries another supplier's POs", 403);
  }
}

// Shared validation for create/update: PO refs, G1, G3, lot conflicts, G2.
// Returns { entries } with lot_number resolved, or responds 409 for soft overbook.
function _validateEntries(entries, c, { supplierId, vendorSupplierId, excludeBookingId = null, force }) {
  const seen = new Set();
  for (const e of entries) {
    const key = `${e.po_number}|${e.lot_number ?? 'auto'}`;
    if (seen.has(key)) err(`Duplicate PO '${e.po_number}' in one booking — combine the units`, 400);
    seen.add(key);
    if (!c.poByNumber.has(e.po_number)) err(`'${e.po_number}' is not an SMS PO`, 400);
    if (vendorSupplierId && (c.poByNumber.get(e.po_number) || {}).supplier_id !== vendorSupplierId) {
      err(`'${e.po_number}' belongs to a different supplier — you can only book your own POs`, 403);
    }
  }

  const poNumbers = entries.map((e) => e.po_number);

  // G1 — one supplier per booking
  const g1 = svc.checkSupplierMatch(poNumbers, supplierId, c.poByNumber);
  if (!g1.ok) {
    err(`These POs do not belong to the booking's supplier: ${g1.offending.map((o) => o.po_number).join(', ')}`, 400);
  }

  // G3 — one destination facility
  const g3 = svc.checkSameConsignment(poNumbers, c.poByNumber);
  if (!g3.ok) {
    err(`One booking must ship to a single destination — these POs span ${g3.facilities.length} facilities. Split them into separate bookings.`, 400);
  }

  // lot conflicts — HARD (double-authorizing the same goods is never intended)
  const conflicts = svc.lotConflicts(entries, c.bookings, c.bookingPos, c.idToStatusName, { excludeBookingId });
  if (conflicts.length) {
    err(`Already booked: ${conflicts.map((x) => `${x.po_number} lot ${x.lot_number} (on ${x.booking_number})`).join(', ')}`, 409);
  }

  // G2 — soft overbooking
  const warnings = svc.overbookWarnings(entries, {
    ordered: svc.orderedByPo(c.poLines),
    bookedByPo: svc.bookedUnitsByPo(c.bookings, c.bookingPos, c.idToStatusName, { excludeBookingId }),
  });
  if (warnings.length && !force) return { overbook: warnings };

  // resolve lots — pinned value wins, else next free past shipped AND booked
  const taken = new Map();
  const resolved = entries.map((e) => {
    if (e.lot_number != null) return { ...e, lot_number: Number(e.lot_number) };
    const base = svc.nextLotForPo(e.po_number, { shipmentPos: c.shipmentPos, bookingPos: c.bookingPos });
    const bump = taken.get(e.po_number) || 0;
    taken.set(e.po_number, bump + 1);
    return { ...e, lot_number: base + bump };
  });
  return { entries: resolved };
}

// READ scoping uses onUnlinked:'deny' (empty list), unlike the write paths' 'throw'
// (403) — a misconfigured vendor account should render an empty page, not error it.
const _readScope = (req) => resolveVendorSupplierId(req.user, { onUnlinked: 'deny' });

async function getAll(req, res) {
  const [vendorSupplierId, c] = await Promise.all([_readScope(req), _ctx()]);
  let out = svc.enrichBookings(c.bookings, { ...c });
  if (vendorSupplierId != null) {
    out = out.filter((b) => String(b.supplier_id) === String(vendorSupplierId));
  }
  res.json(out);
}

async function getOne(req, res) {
  const [vendorSupplierId, c] = await Promise.all([_readScope(req), _ctx()]);
  const b = c.bookings.find((x) => x.id === req.params.id);
  if (!b) err('SMS booking not found', 404);
  // 404, NOT the 403 that _assertVendorOwns raises. That helper is right for the
  // write paths ("you may not touch this"), but on a read a 403 confirms the id
  // exists, which is exactly the oracle for enumerating other suppliers' bookings.
  if (vendorSupplierId != null && !_vendorOwnsBooking(b.id, c, vendorSupplierId)) {
    err('SMS booking not found', 404);
  }
  res.json(_enrichOne(b, c));
}

async function create(req, res) {
  const vendorSupplierId = await _vendorSupplierId(req.user);
  const c = await _ctx();
  const { supplier_id, incoterm_id, courier_id, mode_id, cargo_ready_date, pos: entries, force_overbook } = req.body;

  if (!c.suppliers.some((s) => s.id === supplier_id)) err(`Unknown supplier_id '${supplier_id}'`, 400);
  if (vendorSupplierId && supplier_id !== vendorSupplierId) {
    err('You can only create bookings for your own supplier', 403);
  }
  if (incoterm_id && !c.incoterms.some((i) => i.id === incoterm_id)) err(`Unknown incoterm_id '${incoterm_id}'`, 400);
  if (!c.couriers.some((cr) => cr.id === courier_id)) err(`Unknown courier_id '${courier_id}'`, 400);
  if (!c.modes.some((m) => m.id === mode_id)) err(`Unknown mode_id '${mode_id}'`, 400);

  const checked = _validateEntries(entries, c, { supplierId: supplier_id, vendorSupplierId, force: force_overbook });
  if (checked.overbook) return res.status(409).json({ overbook_warning: true, warnings: checked.overbook });

  const seq = c.bookings.reduce((mx, b) => Math.max(mx, Number(String(b.booking_number).replace(/^SMS-B-/, '')) || 0), 0) + 1;
  const id = `smsbk_${seq}`;
  const booking = {
    id,
    booking_number: `SMS-B-${seq}`,
    supplier_id,
    incoterm_id: incoterm_id || null,
    // planned carrier + mode — copied onto the draft shipment at approve
    courier_id,
    mode_id,
    cargo_ready_date: cargo_ready_date || null,
    booking_status_id: STATUS.pending,
    submitted_at: new Date().toISOString(),
    approved_at: null,
  };
  const junctions = checked.entries.map((e, i) => ({
    id: `smsbp_${id}_${i + 1}`,
    booking_id: id,
    po_number: e.po_number,
    lot_number: e.lot_number,
    units: Number(e.units),
    cartons: e.cartons != null ? Number(e.cartons) : null,
    weight_kg: e.weight_kg != null ? Number(e.weight_kg) : null,
    cbm: e.cbm != null ? Number(e.cbm) : null,
  }));

  await M.bookings.write([...c.bookings, booking]);
  await M.bookingPos.write([...c.bookingPos, ...junctions]);

  const c2 = await _ctx();
  res.status(201).json(_enrichOne(c2.bookings.find((b) => b.id === id), c2));
}

async function update(req, res) {
  const vendorSupplierId = await _vendorSupplierId(req.user);
  const c = await _ctx();
  const idx = c.bookings.findIndex((b) => b.id === req.params.id);
  if (idx < 0) err('SMS booking not found', 404);
  const booking = c.bookings[idx];
  _assertVendorOwns(booking.id, c, vendorSupplierId);

  if (c.idToStatusName.get(booking.booking_status_id) !== 'Booking Pending') {
    err(`Only a Pending booking can be edited — this one is ${c.idToStatusName.get(booking.booking_status_id)}`, 400);
  }
  if (req.body.incoterm_id && !c.incoterms.some((i) => i.id === req.body.incoterm_id)) {
    err(`Unknown incoterm_id '${req.body.incoterm_id}'`, 400);
  }
  if (req.body.courier_id !== undefined && !c.couriers.some((cr) => cr.id === req.body.courier_id)) {
    err(`Unknown courier_id '${req.body.courier_id}'`, 400);
  }
  if (req.body.mode_id !== undefined && !c.modes.some((m) => m.id === req.body.mode_id)) {
    err(`Unknown mode_id '${req.body.mode_id}'`, 400);
  }

  const next = { ...booking };
  if (req.body.incoterm_id !== undefined) next.incoterm_id = req.body.incoterm_id || null;
  if (req.body.courier_id !== undefined) next.courier_id = req.body.courier_id;
  if (req.body.mode_id !== undefined) next.mode_id = req.body.mode_id;
  if (req.body.cargo_ready_date !== undefined) next.cargo_ready_date = req.body.cargo_ready_date || null;

  let junctions = c.bookingPos;
  if (Array.isArray(req.body.pos)) {
    const checked = _validateEntries(req.body.pos, c, {
      supplierId: booking.supplier_id, vendorSupplierId,
      excludeBookingId: booking.id, force: req.body.force_overbook,
    });
    if (checked.overbook) return res.status(409).json({ overbook_warning: true, warnings: checked.overbook });
    // replace this booking's junction wholesale (add/remove/edit in one shot)
    junctions = [
      ...c.bookingPos.filter((bp) => bp.booking_id !== booking.id),
      ...checked.entries.map((e, i) => ({
        id: `smsbp_${booking.id}_${i + 1}`,
        booking_id: booking.id,
        po_number: e.po_number,
        lot_number: e.lot_number,
        units: Number(e.units),
        cartons: e.cartons != null ? Number(e.cartons) : null,
        weight_kg: e.weight_kg != null ? Number(e.weight_kg) : null,
        cbm: e.cbm != null ? Number(e.cbm) : null,
      })),
    ];
  }

  const bookings = [...c.bookings];
  bookings[idx] = next;
  await M.bookings.write(bookings);
  if (junctions !== c.bookingPos) await M.bookingPos.write(junctions);

  const c2 = await _ctx();
  res.json(_enrichOne(c2.bookings.find((b) => b.id === booking.id), c2));
}

// POST /sms/bookings/:id/approve — Logistics/Admin. Creates ONE DRAFT shipment per
// destination facility (G3 keeps that at one today, but the split is written
// defensively). Draft = no tracking number yet; the shipper adds it when the box
// goes out. The booking's PO-lots become the shipment's junction rows, carrying the
// BOOKED units forward as the initial shipped figure (correctable later).
async function approve(req, res) {
  const c = await _ctx();
  const idx = c.bookings.findIndex((b) => b.id === req.params.id);
  if (idx < 0) err('SMS booking not found', 404);
  const booking = c.bookings[idx];
  const statusName = c.idToStatusName.get(booking.booking_status_id);
  if (statusName !== 'Booking Pending') err(`Only a Pending booking can be approved — this one is ${statusName}`, 400);

  const myPos = c.bookingPos.filter((bp) => bp.booking_id === booking.id);
  if (!myPos.length) err('This booking has no POs', 400);

  // a lot already shipped cannot be authorized retroactively
  const shipped = myPos.filter((bp) => c.shipmentPos.some((j) => j.po_number === bp.po_number && j.lot_number === bp.lot_number));
  if (shipped.length) {
    err(`Already shipped, cannot approve: ${shipped.map((s) => `${s.po_number} lot ${s.lot_number}`).join(', ')}`, 409);
  }

  // group the booked lots by destination facility → one draft shipment each
  const byFacility = myPos.reduce((m, bp) => {
    const fac = (c.poByNumber.get(bp.po_number) || {}).facility_id || null;
    (m[fac ?? '__none'] = m[fac ?? '__none'] || []).push(bp);
    return m;
  }, {});

  // Carrier + mode come from the BOOKING — they are not guessed here. This used to
  // be `couriers.find(/fedex/i) || couriers[0]`, which stamped FedEx on every draft
  // (including Ceva sea consignments) and, because the landed-cost push tagged SMS
  // as COURIER unconditionally, sent the wrong shipping method to NetSuite.
  // A booking predating those fields is refused rather than defaulted: it is
  // Pending-editable, so the fix is to set the carrier/mode on the booking.
  if (!booking.courier_id || !booking.mode_id) {
    err('This booking has no carrier/mode set — edit the booking and pick them before approving', 400);
  }
  if (!c.couriers.some((cr) => cr.id === booking.courier_id)) err(`Unknown courier_id '${booking.courier_id}' on this booking`, 400);
  if (!c.modes.some((m) => m.id === booking.mode_id)) err(`Unknown mode_id '${booking.mode_id}' on this booking`, 400);

  let nextId = c.shipments.reduce((mx, s) => Math.max(mx, Number(s.id) || 0), 0);
  const newShipments = [];
  const newJunctions = [];

  for (const [facKey, rows] of Object.entries(byFacility)) {
    const id = String(++nextId);
    newShipments.push({
      id,
      courier_id: booking.courier_id,              // the PLANNED carrier, not a default
      mode_id: booking.mode_id,                    // drives NS custbody16 on the landed-cost push
      tracking_number: null,                       // DRAFT — filled in when it ships
      ship_date: null,
      facility_id: facKey === '__none' ? null : facKey,
      manual_status_id: 'sms_label_created',
      created_by: req.user?.id || null,
      created_at: new Date().toISOString(),
      booking_id: booking.id,
      customs_entry_number: null,
      duty: null,
      freight: null,
    });
    rows.forEach((bp) => newJunctions.push({
      id: `spo_${id}_${bp.po_number}`,
      shipment_id: id,
      po_number: bp.po_number,
      lot_number: bp.lot_number,                   // the BOOKED lot ships as that lot
      units: Number(bp.units),
      cartons: bp.cartons != null ? Number(bp.cartons) : null,
    }));
  }

  const bookings = [...c.bookings];
  bookings[idx] = { ...booking, booking_status_id: STATUS.approved, approved_at: new Date().toISOString() };

  // NOTE (JSON stack): three sequential writes, no transaction — a crash between
  // them leaves partial state. Same class as mainline booking-approve; fixed at the
  // Postgres migration with a real transaction.
  await M.shipments.write([...c.shipments, ...newShipments]);
  await M.shipmentPos.write([...c.shipmentPos, ...newJunctions]);
  await M.bookings.write(bookings);

  const c2 = await _ctx();
  res.status(201).json({
    booking: _enrichOne(c2.bookings.find((b) => b.id === booking.id), c2),
    created_shipments: newShipments.map((s) => s.id),
  });
}

// POST /sms/bookings/:id/reject — frees the lots for re-booking (they only count
// against capacity while the booking is live).
async function reject(req, res) {
  const c = await _ctx();
  const idx = c.bookings.findIndex((b) => b.id === req.params.id);
  if (idx < 0) err('SMS booking not found', 404);
  const statusName = c.idToStatusName.get(c.bookings[idx].booking_status_id);
  if (statusName !== 'Booking Pending') err(`Only a Pending booking can be rejected — this one is ${statusName}`, 400);

  const bookings = [...c.bookings];
  bookings[idx] = { ...bookings[idx], booking_status_id: STATUS.rejected };
  await M.bookings.write(bookings);

  const c2 = await _ctx();
  res.json(_enrichOne(c2.bookings.find((b) => b.id === req.params.id), c2));
}

// POST /sms/bookings/:id/cancel — the way OUT of an approved booking. Allowed from
// Pending or Approved. Its DRAFT shipments (approved but never shipped) are deleted
// with their junction rows; a shipment that actually went out (has a tracking
// number) blocks the cancel — that's history, not a plan.
async function cancel(req, res) {
  const vendorSupplierId = await _vendorSupplierId(req.user);
  const c = await _ctx();
  const idx = c.bookings.findIndex((b) => b.id === req.params.id);
  if (idx < 0) err('SMS booking not found', 404);
  const booking = c.bookings[idx];
  _assertVendorOwns(booking.id, c, vendorSupplierId);

  const statusName = c.idToStatusName.get(booking.booking_status_id);
  if (!['Booking Pending', 'Booking Approved'].includes(statusName)) {
    err(`Only a Pending or Approved booking can be cancelled — this one is ${statusName}`, 400);
  }

  const mine = c.shipments.filter((s) => s.booking_id === booking.id);
  const shipped = mine.filter((s) => s.tracking_number);
  if (shipped.length) {
    err(`Already shipped under this booking (${shipped.map((s) => s.tracking_number).join(', ')}) — cancel is blocked; delete those shipments first if they were entered in error`, 409);
  }

  const draftIds = new Set(mine.map((s) => s.id));
  const bookings = [...c.bookings];
  bookings[idx] = { ...booking, booking_status_id: STATUS.cancelled };

  if (draftIds.size) {
    await M.shipments.write(c.shipments.filter((s) => !draftIds.has(s.id)));
    await M.shipmentPos.write(c.shipmentPos.filter((j) => !draftIds.has(j.shipment_id)));
  }
  await M.bookings.write(bookings);

  const c2 = await _ctx();
  res.json({
    booking: _enrichOne(c2.bookings.find((b) => b.id === booking.id), c2),
    deleted_draft_shipments: [...draftIds],
  });
}

// DELETE — Pending/Rejected/Cancelled only, junction cascades. An approved booking
// has shipments hanging off it; cancel it instead of deleting history.
async function remove(req, res) {
  const vendorSupplierId = await _vendorSupplierId(req.user);
  const c = await _ctx();
  const b = c.bookings.find((x) => x.id === req.params.id);
  if (!b) err('SMS booking not found', 404);
  _assertVendorOwns(b.id, c, vendorSupplierId);

  const statusName = c.idToStatusName.get(b.booking_status_id);
  if (statusName === 'Booking Approved') {
    err('An approved booking has shipments — cancel it instead (POST /sms/bookings/:id/cancel)', 400);
  }
  if (c.shipments.some((s) => s.booking_id === b.id)) {
    err('Shipments reference this booking — delete those first', 400);
  }

  await M.bookings.write(c.bookings.filter((x) => x.id !== b.id));
  await M.bookingPos.write(c.bookingPos.filter((bp) => bp.booking_id !== b.id));
  res.status(204).send();
}

module.exports = { getAll, getOne, create, update, approve, reject, cancel, remove };
