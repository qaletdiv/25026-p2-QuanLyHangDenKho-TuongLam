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
const { resolveVendorSupplierId } = require('../../../utils/vendorScope');
const { permissionsForRole } = require('../../../utils/rolePermissions');
// The SHIPMENT's own cancel guards, reused so a booking-level cancel can never
// override what the consignment itself would refuse.
const lifecycle = require('../shipments/shipmentLifecycle');

// Everything else that keys on a booking — cleared by `remove`, which otherwise
// leaves rows pointing at a booking that is gone.
const CommercialInvoiceModel = new BaseModel('migrated/mainline_commercial_invoices.json');
const PackingCartonModel     = new BaseModel('migrated/mainline_packing_cartons.json');
const DocumentModel          = new BaseModel('migrated/mainline_documents.json');

// FCL/LCL is implied by the Sea mode name; Air/Courier have no container type.
const containerTypeFromMode = (modeName) => {
  const n = (modeName || '').toLowerCase();
  if (n.includes('fcl')) return 'ct_fcl';
  if (n.includes('lcl')) return 'ct_lcl';
  return null;
};

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };

async function _loadContext() {
  const [bookings, bookingLegs, legs, legLines, orders, masters, suppliers, modes, seasons, couriers] = await Promise.all([
    MainlineBookingModel.readBookings(), MainlineBookingModel.readBookingLegs(),
    MainlineLegModel.readLegs(), MainlineLegModel.readLegLines(),
    PoOrderModel.readOrders(), PoMasterModel.read(), SupplierModel.read().catch(() => []),
    ModeModel.read().catch(() => []),
    new BaseModel('migrated/seasons.json').read().catch(() => []),
    new BaseModel('couriers.json').read().catch(() => []),
  ]);
  return { bookings, bookingLegs, legs, legLines, orders, masters, suppliers, modes, seasons, couriers };
}

async function _enrich(bookings, ctx) {
  const idToStatusName = new Map();
  await Promise.all(bookings.map(async (b) => idToStatusName.set(b.booking_status_id, await status.nameForId(b.booking_status_id))));
  return svc.enrichBookings(bookings, {
    bookingLegs: ctx.bookingLegs, legs: ctx.legs, suppliers: ctx.suppliers, modes: ctx.modes,
    orders: ctx.orders, masters: ctx.masters, seasons: ctx.seasons, couriers: ctx.couriers, idToStatusName,
  });
}

function nextId(rows) { return String(rows.reduce((mx, r) => Math.max(mx, +String(r.id).replace(/\D/g, '') || 0), 0) + 1); }
function nextBookingNumber(bookings) {
  const mx = bookings.reduce((m, b) => Math.max(m, +String(b.booking_number || '').replace(/\D/g, '') || 0), 0);
  return `BKG-${mx + 1}`;
}

// Vendor row scoping. mainline_bookings carries supplier_id directly (G1 guarantees
// one supplier per booking), so this is a straight row filter. Only the RECORD LIST
// is filtered — the enrichment context (legs, orders, masters, suppliers) stays whole,
// because those are lookup tables and pruning them would blank out joined names.
// Safe to filter the list: enrichBookings is a pure per-booking map with no
// cross-record aggregation.
const bookingScope = (req) => resolveVendorSupplierId(req.user, { onUnlinked: 'deny' });
const mineOnly = (bookings, vendorSid) =>
  vendorSid == null ? bookings : bookings.filter((b) => String(b.supplier_id) === String(vendorSid));

async function getAll(req, res) {
  const [ctx, vendorSid] = await Promise.all([_loadContext(), bookingScope(req)]);
  res.json(await _enrich(mineOnly(ctx.bookings, vendorSid), ctx));
}

async function getOne(req, res) {
  const [ctx, vendorSid] = await Promise.all([_loadContext(), bookingScope(req)]);
  const b = ctx.bookings.find((x) => x.id === req.params.id);
  // 404 (not 403) when it exists but isn't theirs — a 403 would confirm the id is
  // real, letting a vendor enumerate other suppliers' bookings by probing ids.
  if (!b || (vendorSid != null && String(b.supplier_id) !== String(vendorSid))) err('Booking not found', 404);
  res.json((await _enrich([b], ctx))[0]);
}

async function create(req, res) {
  const { supplier_id, po_legs, courier_id, force_overbook } = req.body;
  const ctx = await _loadContext();
  const legById = new Map(ctx.legs.map((l) => [l.id, l]));

  // PLANNED carrier. Optional: it is not always decided when the vendor submits,
  // and it stays correctable on the shipment afterwards. Validated when supplied so
  // a typo cannot reach the landed-cost basis, which keys on this carrier.
  if (courier_id && !ctx.couriers.some((cr) => cr.id === courier_id)) {
    err(`Unknown courier_id '${courier_id}'`, 400);
  }

  // Leg-only guard: every referenced leg must exist (forecast POs have none).
  const missing = po_legs.filter((p) => !legById.has(p.leg_id)).map((p) => p.leg_id);
  if (missing.length) err(`Unknown leg_id(s): ${missing.join(', ')} — PO not split into legs yet (not bookable)`, 400);

  // G4 — NetSuite approval: refuse legs whose PO no supervisor has approved.
  // Checked before the combination guards because it is a property of the PO
  // itself, so the message is actionable on its own ("get it approved"), and
  // HARD — unlike G2 there is no force_ escape hatch (see svc.checkApproved).
  const appr = svc.checkApproved(po_legs.map((p) => p.leg_id), { legs: ctx.legs, orders: ctx.orders });
  if (!appr.ok) {
    const list = appr.offending
      .map((o) => `${o.po_number ?? o.leg_id} (${o.approval_status})`)
      .join(', ');
    err(
      `Cannot book a purchase order NetSuite has not approved: ${list}. `
      + 'Have it approved in NetSuite, then run the NetSuite Sync on the Purchase Orders page.',
      422,
    );
  }

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

  // Seed Cargo Ready from the WIP leg CRD (latest across the booked legs) so a new
  // booking carries a real date out of the box; the vendor can override it later
  // via update while the booking is still pending.
  const legCrds = po_legs.map((p) => legById.get(p.leg_id)?.crd).filter(Boolean);
  const seededCrd = legCrds.length ? legCrds.reduce((a, c) => (c > a ? c : a)) : null;

  const id = nextId(ctx.bookings);
  const booking = {
    id,
    booking_number: req.body.booking_number || nextBookingNumber(ctx.bookings),
    supplier_id,
    incoterm_id: req.body.incoterm_id || null,
    courier_id: courier_id || null,          // planned carrier; stamped onto the shipment at approve
    cargo_ready_date: req.body.cargo_ready_date || seededCrd,
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
  // A CANCELLED consignment is not a match for the idempotency check below.
  // Without this, cancelling a shipment is a dead end: re-approving finds the
  // cancelled row, creates nothing, and the booking is left Approved with no live
  // consignment and no way to issue one. Skipping it means re-approve mints a
  // fresh SHP-N and the cancelled row stays as the record of what happened.
  const cancelledId = await status.idForName('Cancelled');

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
    let ship = shipments.find((s) => s.booking_id === booking.id && s.facility_id === facility_id
      && s.mode_id === mode_id && s.status_id !== cancelledId);
    if (!ship) {                                            // idempotent re-approve (booking+facility+mode)
      ship = {
        id: String(++nextShipId),
        shipment_number: `SHP-${++nextShipNum}`,
        booking_id: booking.id,
        facility_id,
        mode_id,
        status_id: readyToShipId,
        container_type_id: containerTypeFromMode(modeName.get(mode_id)),
        // ACTUAL carrier, seeded from the booking's PLAN. Null when the booking did
        // not name one — and null means ACTUAL basis on the Landed Costs page, i.e.
        // the pre-2026-08-24 behaviour, never a silent estimate. Correctable on the
        // shipment. Deliberately NOT defaulted to a carrier: guessing one is the bug
        // this replaces (SMS approve used to hardcode FedEx).
        courier_id: booking.courier_id || null,
        pol_port_id: null, pod_port_id: null, bl_no: null, carrier_reference: null,
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
  const [ctx, vendorSid] = await Promise.all([_loadContext(), bookingScope(req)]);
  const idx = ctx.bookings.findIndex((b) => b.id === req.params.id);
  if (idx < 0) err('Booking not found', 404);

  const booking = ctx.bookings[idx];
  // A vendor edits their OWN booking through this route and nobody else's. getAll
  // and getOne were scoped and this WRITE was not, so a vendor got 404 reading
  // another supplier's booking and 200 writing it — the read gate said the record
  // did not exist while the write gate handed it over (verified 2026-09-18).
  // 404 rather than 403 for the same reason getOne gives: a 403 confirms the id is
  // real, which is the oracle for enumerating other suppliers' bookings.
  // `approve` and `remove` are unscoped too, but they are gated on booking_approve
  // / booking_delete, which no Vendor role holds — latent, not reachable today.
  if (vendorSid != null && String(booking.supplier_id) !== String(vendorSid)) err('Booking not found', 404);
  const newStatusName = req.body.booking_status;
  const oldStatusName = await status.nameForId(booking.booking_status_id);

  // A STATUS CHANGE HERE IS AN APPROVAL DECISION, so it takes `booking_approve` —
  // the same key POST /bookings/:id/approve is gated on at the route.
  //
  // This route carries `booking_create_mainline` because a Vendor edits their own
  // booking through it (Cargo Ready, carrier). But `booking_status` is an accepted
  // field, and moving it to 'Booking Approved' runs the FULL `_approve` below —
  // stamping approved_at and creating the shipments. So the edit route was a second,
  // ungated door into approval: a Vendor was refused at POST /approve (403) and then
  // let through here (200). Verified against the live vendor account, 2026-09-18.
  //
  // Gated in the HANDLER, not with requirePermission at the route, because the key
  // is needed only when the status actually MOVES — a vendor saving Cargo Ready on
  // their own pending booking must still pass. Cancelled/Rejected are covered too:
  // they are the same decision answered differently, and cancelling a booking
  // deletes shipments downstream.
  if (newStatusName && newStatusName !== oldStatusName) {
    const granted = await permissionsForRole(req.user?.role);
    if (!granted.includes('booking_approve')) {
      err("Permission denied — 'booking_approve' required to change a booking's status", 403);
    }
    // ...and the two outcomes that carry guards are not settable here at all.
    // Cancel cascades to the booking's consignments and has to judge each one;
    // Reject is Pending-only. Leaving them as free values on this route would be
    // the same ungated door the approval bypass was.
    const VIA_ACTION = { Cancelled: 'cancel', Rejected: 'reject' };
    if (VIA_ACTION[newStatusName]) {
      err(`Use POST /mainline/bookings/:id/${VIA_ACTION[newStatusName]} — it has guards this route does not`, 400);
    }
  }

  if (newStatusName) booking.booking_status_id = await status.idForName(newStatusName);
  // Cargo Ready is vendor-editable only while the booking is still pending — once
  // approved it has spawned shipments (which own the logistics dates) and is locked.
  // Admin / Logistics may override it even after approval (won't retro-change the
  // shipment dates already created).
  if (req.body.cargo_ready_date !== undefined) {
    const privileged = ['Admin', 'Logistics Coordinator'].includes(req.user?.role);
    if (oldStatusName !== 'Booking Pending' && !privileged) {
      err('Cargo Ready can only be edited while the booking is pending (not yet approved)', 409);
    }
    booking.cargo_ready_date = req.body.cargo_ready_date || null;
  }
  if (req.body.incoterm_id !== undefined) booking.incoterm_id = req.body.incoterm_id;
  // Planned carrier. Editable up to approval — after that the SHIPMENT's carrier is
  // the one that matters (it drives the landed-cost basis), so changing the plan
  // here deliberately does NOT retro-change an already-created shipment.
  if (req.body.courier_id !== undefined) {
    if (req.body.courier_id && !ctx.couriers.some((cr) => cr.id === req.body.courier_id)) {
      err(`Unknown courier_id '${req.body.courier_id}'`, 400);
    }
    booking.courier_id = req.body.courier_id || null;
  }

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

// POST /:id/reject — the negative answer to a PENDING booking. Nothing hangs off
// it yet (shipments are born at approve), so there is nothing to cascade.
async function reject(req, res) {
  const ctx = await _loadContext();
  const idx = ctx.bookings.findIndex((b) => b.id === req.params.id);
  if (idx < 0) err('Booking not found', 404);
  const booking = ctx.bookings[idx];
  const was = await status.nameForId(booking.booking_status_id);
  if (was !== 'Booking Pending') {
    err(`Only a Pending booking can be rejected — this one is ${was}. Cancel it instead.`, 409);
  }
  booking.booking_status_id = await status.idForName('Rejected');
  await MainlineBookingModel.writeBookings(ctx.bookings);
  res.json(await _enrich([booking], ctx).then((r) => r[0]));
}

// POST /:id/cancel — the way OUT of a booking, at either end of its life.
//
// The cascade is a STATUS, never an erasure: the booking's live consignments are
// CANCELLED with it, each judged by the same `shipmentLifecycle.cancelBlockers`
// that guards the shipment's own Cancel button. So a parent cancel can never do
// something a child would refuse — if one consignment has been handed over,
// receipted or costed, the whole call is refused and the message names it. That is
// the same "children first" rule `remove` enforces, expressed for a reversible
// action rather than a destructive one: cancel leaves every row in place.
async function cancel(req, res) {
  const ctx = await _loadContext();
  const idx = ctx.bookings.findIndex((b) => b.id === req.params.id);
  if (idx < 0) err('Booking not found', 404);
  const booking = ctx.bookings[idx];

  const was = await status.nameForId(booking.booking_status_id);
  if (!['Booking Pending', 'Booking Approved'].includes(was)) {
    err(`Only a Pending or Approved booking can be cancelled — this one is ${was}`, 409);
  }

  const [shipments, landedCosts, receipts] = await Promise.all([
    MainlineShipmentModel.read(),
    new BaseModel('migrated/landed_costs.json').read().catch(() => []),
    new BaseModel('migrated/mainline_item_receipts.json').read().catch(() => []),
  ]);
  const cancelledId = await status.idForName('Cancelled');
  const mine = shipments.filter((s) => s.booking_id === booking.id && s.status_id !== cancelledId);

  const blocked = mine
    .map((s) => ({ s, why: lifecycle.cancelBlockers(s, { landedCosts, receipts }) }))
    .filter((x) => x.why.length);
  if (blocked.length) {
    const detail = blocked.map((x) => `${x.s.shipment_number || x.s.id} (${x.why.join('; ')})`).join(', ');
    err(`This booking still carries a consignment that cannot be cancelled: ${detail}. `
      + 'Deal with that consignment first — cancelling the booking must not override its own guards.', 409);
  }

  booking.booking_status_id = cancelledId;
  if (mine.length) {
    await MainlineShipmentModel.write(shipments.map((s) => (mine.some((m) => m.id === s.id)
      ? { ...s, status_id: cancelledId }
      : s)));
  }
  await MainlineBookingModel.writeBookings(ctx.bookings);
  res.json({
    ...(await _enrich([booking], ctx))[0],
    shipments_cancelled: mine.length,
  });
}

// Deleting a booking clears what BELONGS to the booking: the junction, the
// commercial invoice, the packing cartons and the generated documents. Until the
// Postgres migration only the junction was cleared — and 8 of the 9 live bookings
// carry a CI, cartons AND documents, so a delete stranded all three. Those orphans
// are not inert: CI lines and the packing summary are DERIVED from
// mainline_packing_cartons per read, so they would have gone on contributing to
// totals for a booking that no longer existed.
//
// It no longer reaches down into the SHIPMENTS — see the guard below. A shipment
// has a lifecycle and guards of its own (shipmentLifecycle.js), and a parent delete
// that quietly overrides them is how a posted landed cost or a confirmed NetSuite
// receipt ends up pointing at nothing.
async function remove(req, res) {
  const id = req.params.id;
  const [bookings, bookingLegs, shipments, invoices, cartons, documents] = await Promise.all([
    MainlineBookingModel.readBookings(), MainlineBookingModel.readBookingLegs(),
    MainlineShipmentModel.read(),
    CommercialInvoiceModel.read(), PackingCartonModel.read(), DocumentModel.read(),
  ]);
  if (!bookings.some((b) => b.id === id)) err('Booking not found', 404);

  // CHILDREN FIRST (2026-09-18). This used to delete the booking's shipments as a
  // cascade, which meant one click on a parent destroyed the consignment, its ASN,
  // its receipt links, the commercial invoice, the packing cartons and the
  // generated documents — with no check on whether the goods had already arrived.
  // Live, that was 10 shipments, 8 CIs, 2,275 cartons, 48 documents and 16
  // confirmed NetSuite receipt matches sitting behind an unguarded button.
  //
  // The cascade BELOW is kept, because the CI, the cartons and the documents really
  // are artifacts of the booking. What is refused is reaching through the booking
  // to destroy a SHIPMENT, which owns its own lifecycle and its own guards. Deal
  // with each consignment on its own page, then the booking is free.
  const mine = shipments.filter((s) => s.booking_id === id);
  if (mine.length) {
    const list = mine.map((s) => s.shipment_number || s.id).join(', ');
    err(`This booking still has ${mine.length} shipment${mine.length === 1 ? '' : 's'} (${list}) — `
      + 'cancel and delete those first. Deleting a booking must not reach through and erase a consignment.', 409);
  }

  // No shipment write and no cascadeShipmentDelete here any more — the guard above
  // guarantees there is nothing of that kind left to clean up.
  await MainlineBookingModel.writeBookings(bookings.filter((b) => b.id !== id));
  await MainlineBookingModel.writeBookingLegs(bookingLegs.filter((bl) => bl.booking_id !== id));
  await CommercialInvoiceModel.write(invoices.filter((ci) => ci.booking_id !== id));    // cascade CI
  await PackingCartonModel.write(cartons.filter((c) => c.booking_id !== id));           // cascade shipping data
  await DocumentModel.write(documents.filter((d) => d.booking_id !== id));              // cascade generated docs
  res.status(204).send();
}

module.exports = { getAll, getOne, create, update, approve, reject, cancel, remove };
