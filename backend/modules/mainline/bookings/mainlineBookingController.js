'use strict';

// Mainline bookings (Phase 3). Lifecycle:
//   create  → always "Booking Pending" (no SMS auto-approve)
//   approve → status "Booking Approved" → create mainline_shipments (one per leg)
//   remove  → delete booking + its junction rows + linked shipments
//
// Leg-only: bookings reference leg_id (validator-enforced); the controller also
// verifies each leg exists (a forecast/unsplit PO has no legs → unbookable).
// PO booking_status is NOT written back — it's derived live (poController).

const MainlineBookingModel = require('./MainlineBookingModel');
const MainlineShipmentModel = require('../shipments/MainlineShipmentModel');
const MainlineShipmentLegModel = require('../shipments/MainlineShipmentLegModel');
const MainlineLegModel = require('../legs/MainlineLegModel');
const PoOrderModel = require('../../po/PoOrderModel');
const PoMasterModel = require('../../po/PoMasterModel');
const { suppliers: SupplierModel, modes: ModeModel } = require('../../../models/MasterDataModel');
const BaseModel = require('../../../models/BaseModel');
const status = require('../statuses');
const svc = require('./mainlineBookingService');

// FCL/LCL is implied by the Sea mode name; Air/Courier have no container type.
const containerTypeFromMode = (modeName) => {
  const n = (modeName || '').toLowerCase();
  if (n.includes('fcl')) return 'ct_fcl';
  if (n.includes('lcl')) return 'ct_lcl';
  return null;
};

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };

async function _loadContext() {
  const [bookings, bookingLegs, legs, legLines, orders, masters, suppliers, modes, seasons] = await Promise.all([
    MainlineBookingModel.readBookings(), MainlineBookingModel.readBookingLegs(),
    MainlineLegModel.readLegs(), MainlineLegModel.readLegLines(),
    PoOrderModel.readOrders(), PoMasterModel.read(), SupplierModel.read().catch(() => []),
    ModeModel.read().catch(() => []),
    new BaseModel('migrated/seasons.json').read().catch(() => []),
  ]);
  return { bookings, bookingLegs, legs, legLines, orders, masters, suppliers, modes, seasons };
}

async function _enrich(bookings, ctx) {
  const idToStatusName = new Map();
  await Promise.all(bookings.map(async (b) => idToStatusName.set(b.booking_status_id, await status.nameForId(b.booking_status_id))));
  return svc.enrichBookings(bookings, {
    bookingLegs: ctx.bookingLegs, legs: ctx.legs, suppliers: ctx.suppliers, modes: ctx.modes,
    orders: ctx.orders, masters: ctx.masters, seasons: ctx.seasons, idToStatusName,
  });
}

function nextId(rows) { return String(rows.reduce((mx, r) => Math.max(mx, +String(r.id).replace(/\D/g, '') || 0), 0) + 1); }
function nextBookingNumber(bookings) {
  const mx = bookings.reduce((m, b) => Math.max(m, +String(b.booking_number || '').replace(/\D/g, '') || 0), 0);
  return `BKG-${mx + 1}`;
}

async function getAll(req, res) {
  const ctx = await _loadContext();
  res.json(await _enrich(ctx.bookings, ctx));
}

async function getOne(req, res) {
  const ctx = await _loadContext();
  const b = ctx.bookings.find((x) => x.id === req.params.id);
  if (!b) err('Booking not found', 404);
  res.json((await _enrich([b], ctx))[0]);
}

async function create(req, res) {
  const { supplier_id, po_legs, force_overbook } = req.body;
  const ctx = await _loadContext();
  const legById = new Map(ctx.legs.map((l) => [l.id, l]));

  // Leg-only guard: every referenced leg must exist (forecast POs have none).
  const missing = po_legs.filter((p) => !legById.has(p.leg_id)).map((p) => p.leg_id);
  if (missing.length) err(`Unknown leg_id(s): ${missing.join(', ')} — PO not split into legs yet (not bookable)`, 400);

  // G1 — vendor match: every leg must belong to supplier_id.
  const legSup = svc.legSupplierMap(ctx.legs, ctx.orders, ctx.masters);
  const vm = svc.checkVendorMatch(po_legs.map((p) => p.leg_id), supplier_id, legSup);
  if (!vm.ok) err(`All legs must belong to supplier ${supplier_id}; offending: ${vm.offending.map((o) => o.leg_id).join(', ')}`, 400);

  // G3 — same consignment: multiple POs may share a booking only with one destination
  // facility and one mode (same supplier from G1). They become a single shipment.
  if (po_legs.length > 1) {
    const cons = svc.checkSameConsignment(po_legs.map((p) => p.leg_id), { legs: ctx.legs, orders: ctx.orders });
    if (!cons.ok) {
      const [facilities, modes] = await Promise.all([
        new BaseModel('migrated/warehouse_facilities.json').read().catch(() => []),
        ModeModel.read().catch(() => []),
      ]);
      const fName = new Map(facilities.map((f) => [f.id, f.name]));
      const mName = new Map(modes.map((m) => [m.id, m.name]));
      const fs = cons.facilities.map((id) => fName.get(id) || id || '—').join(', ');
      const ms = cons.modes.map((id) => mName.get(id) || id || '—').join(', ');
      err(`Multiple POs can be booked together only when they share one destination and one mode. Found destinations: [${fs}]; modes: [${ms}].`, 400);
    }
  }

  // G2 — soft overbooking against leg capacity (Σ allocated_qty).
  if (!force_overbook) {
    const statusNamed = await _enrich(ctx.bookings, ctx);
    const bookedByLeg = svc.bookedUnitsByLeg(statusNamed, ctx.bookingLegs);
    const warnings = svc.overbookWarnings(po_legs, {
      capacities: svc.legCapacities(ctx.legLines),
      bookedByLeg,
      legPo: new Map(ctx.legs.map((l) => [l.id, l.po_number])),
    });
    if (warnings.length) return res.status(409).json({ overbook_warning: true, warnings });
  }

  const id = nextId(ctx.bookings);
  const booking = {
    id,
    booking_number: req.body.booking_number || nextBookingNumber(ctx.bookings),
    supplier_id,
    incoterm_id: req.body.incoterm_id || null,
    cargo_ready_date: req.body.cargo_ready_date || null,
    booking_status_id: await status.idForName('Booking Pending'),
    // booking date — user-settable (existing column, no schema change); defaults to now
    submitted_at: req.body.booking_date ? new Date(req.body.booking_date).toISOString() : new Date().toISOString(),
    approved_at: null,
    ...(force_overbook ? { overbooked: true } : {}),
  };
  const junction = po_legs.map((p) => ({
    id: `bpl_${id}_${p.leg_id}`,
    booking_id: id,
    leg_id: p.leg_id,
    units: p.units ?? null, cartons: p.cartons ?? null, weight_kg: p.weight_kg ?? null, cbm: p.cbm ?? null,
  }));

  await MainlineBookingModel.writeBookings([...ctx.bookings, booking]);
  await MainlineBookingModel.writeBookingLegs([...ctx.bookingLegs, ...junction]);

  ctx.bookings = [...ctx.bookings, booking];
  ctx.bookingLegs = [...ctx.bookingLegs, ...junction];
  res.status(201).json((await _enrich([booking], ctx))[0]);
}

// Shared approval: create one shipment per (booking, physical facility) and attach
// each booked leg as a junction row (idempotent). Legs going to the SAME facility
// (e.g. NRI US "Reserved" + "First") collapse into one shipment so the forwarder
// edits the shared logistics dates once. See database.dbml.
const earliest = (a, b) => (!a ? b : !b ? a : (a < b ? a : b));
const latest   = (a, b) => (!a ? b : !b ? a : (a > b ? a : b));

async function _approve(booking, ctx) {
  const [shipments, shipLegs, modes] = await Promise.all([
    MainlineShipmentModel.read(), MainlineShipmentLegModel.read(), ModeModel.read().catch(() => []),
  ]);
  const modeName = new Map(modes.map((m) => [m.id, m.name]));
  const myLegs = ctx.bookingLegs.filter((bl) => bl.booking_id === booking.id);
  const orderByPo = new Map(ctx.orders.map((o) => [o.po_number, o]));
  const legById = new Map(ctx.legs.map((l) => [l.id, l]));
  // The BOOKING becomes "Booking Approved"; the SHIPMENT it spawns starts its own
  // progress pipeline at "Ready to Ship".
  const readyToShipId = await status.idForName('Ready to Ship');

  // group this booking's legs by physical conveyance = (facility, mode).
  // Same facility + same mode → one shipment (incl. Reserved/First channels);
  // an Air leg and a Sea leg to the same facility stay separate shipments.
  const groups = new Map();
  for (const bl of myLegs) {
    const leg = legById.get(bl.leg_id) || {};
    const order = orderByPo.get(leg.po_number) || {};
    const facility_id = order.facility_id || null;
    const mode_id = leg.mode_id || null;
    const key = `${facility_id}|${mode_id}`;
    if (!groups.has(key)) groups.set(key, { facility_id, mode_id, items: [] });
    groups.get(key).items.push({ bl, leg });
  }

  let nextShipId = shipments.reduce((mx, s) => Math.max(mx, +String(s.id).replace(/\D/g, '') || 0), 0);
  let nextShipNum = shipments.reduce((mx, s) => Math.max(mx, +String(s.shipment_number || '').replace(/\D/g, '') || 0), 0);
  const created = [];

  for (const { facility_id, mode_id, items } of groups.values()) {
    let ship = shipments.find((s) => s.booking_id === booking.id && s.facility_id === facility_id && s.mode_id === mode_id);
    if (!ship) {                                            // idempotent re-approve (booking+facility+mode)
      ship = {
        id: String(++nextShipId),
        shipment_number: `SHP-${++nextShipNum}`,
        booking_id: booking.id,
        facility_id,
        mode_id,
        status_id: readyToShipId,
        container_type_id: containerTypeFromMode(modeName.get(mode_id)),
        pol_port_id: null, pod_port_id: null, bl_no: null,
        etd_pol: items.reduce((d, { leg }) => earliest(d, leg.etd_pol || null), null),
        eta_pod: null,
        e_del: items.reduce((d, { leg }) => latest(d, leg.e_del || null), null),
        cargo_received_date: null, ata: null, netsuite_id: null,   // ata = actual receipt date, filled later
        invoice_value: null, duty: null, freight: null,
      };
      shipments.push(ship);
      created.push(ship);
    }
    // attach each leg as a junction row (idempotent per shipment+leg)
    for (const { bl } of items) {
      if (shipLegs.some((j) => j.shipment_id === ship.id && j.leg_id === bl.leg_id)) continue;
      const lot = shipLegs.filter((j) => j.leg_id === bl.leg_id).reduce((m, j) => Math.max(m, Number(j.lot_number) || 0), 0) + 1;
      shipLegs.push({
        id: `spl_${ship.id}_${bl.leg_id}`,
        shipment_id: ship.id,
        leg_id: bl.leg_id,
        lot_number: lot,
        expected_quantity: Number(bl.units) || 0,
      });
    }
  }
  await MainlineShipmentModel.write(shipments);
  await MainlineShipmentLegModel.write(shipLegs);
  return created;
}

async function update(req, res) {
  const ctx = await _loadContext();
  const idx = ctx.bookings.findIndex((b) => b.id === req.params.id);
  if (idx < 0) err('Booking not found', 404);

  const booking = ctx.bookings[idx];
  const newStatusName = req.body.booking_status;
  const oldStatusName = await status.nameForId(booking.booking_status_id);

  if (newStatusName) booking.booking_status_id = await status.idForName(newStatusName);
  if (req.body.cargo_ready_date !== undefined) booking.cargo_ready_date = req.body.cargo_ready_date;
  if (req.body.incoterm_id !== undefined) booking.incoterm_id = req.body.incoterm_id;

  let createdShipments = [];
  if (newStatusName === 'Booking Approved' && oldStatusName !== 'Booking Approved') {
    booking.approved_at = new Date().toISOString();
    createdShipments = await _approve(booking, ctx);
  }
  await MainlineBookingModel.writeBookings(ctx.bookings);
  const enriched = (await _enrich([booking], ctx))[0];
  res.json({ ...enriched, shipments_created: createdShipments.length });
}

// POST /:id/approve — explicit approval shortcut.
async function approve(req, res) {
  const ctx = await _loadContext();
  const idx = ctx.bookings.findIndex((b) => b.id === req.params.id);
  if (idx < 0) err('Booking not found', 404);
  const booking = ctx.bookings[idx];
  booking.booking_status_id = await status.idForName('Booking Approved');
  booking.approved_at = booking.approved_at || new Date().toISOString();
  const created = await _approve(booking, ctx);
  await MainlineBookingModel.writeBookings(ctx.bookings);
  res.json({ ...(await _enrich([booking], ctx))[0], shipments_created: created.length });
}

async function remove(req, res) {
  const [bookings, bookingLegs, shipments, shipLegs] = await Promise.all([
    MainlineBookingModel.readBookings(), MainlineBookingModel.readBookingLegs(),
    MainlineShipmentModel.read(), MainlineShipmentLegModel.read(),
  ]);
  if (!bookings.some((b) => b.id === req.params.id)) err('Booking not found', 404);

  const removedShipIds = new Set(shipments.filter((s) => s.booking_id === req.params.id).map((s) => s.id));
  await MainlineBookingModel.writeBookings(bookings.filter((b) => b.id !== req.params.id));
  await MainlineBookingModel.writeBookingLegs(bookingLegs.filter((bl) => bl.booking_id !== req.params.id));
  await MainlineShipmentModel.write(shipments.filter((s) => s.booking_id !== req.params.id));
  await MainlineShipmentLegModel.write(shipLegs.filter((j) => !removedShipIds.has(j.shipment_id)));   // cascade junction
  res.status(204).send();
}

module.exports = { getAll, getOne, create, update, approve, remove };
