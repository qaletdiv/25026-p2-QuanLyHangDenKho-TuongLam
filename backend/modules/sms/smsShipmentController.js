'use strict';

// SMS shipments (consignments) — the VENDOR self-serves the entry: PO(s) with
// qty & cartons, one tracking number + courier per consignment. No approval step.
//
// Guards (server-side — the form is not the enforcement point):
//   G1-SMS vendor scope: a Vendor login may only ship POs whose sms_pos
//     .supplierId matches their own supplier. Admin/Logistics are unscoped.
//   G2-SMS overship:     Σ shipped units per PO may exceed ordered total only
//     with force_overship (409 + warnings otherwise — partial lots are normal,
//     overshipping needs an explicit decision, mirroring mainline's G2).
//   lotNumber is assigned server-side (max existing lot per PO + 1) — vendors
//     never manage lots.

const M = require('./SmsModels');
const status = require('./smsService');
const { receivedByShipment } = require('./receiptMatch');
const { resolveVendorSupplierId } = require('../../utils/vendorScope');
const { shipmentVisibilityFn, vendorScopeFor } = require('./vendorAccess');
const { notifyChange } = require('../notifications/emailNotifier');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };

// The supplier a consignment belongs to, for vendor-scoped mail. An SMS box may
// legitimately carry several suppliers' POs (there is no same-supplier guard on
// this module), and in that case the answer is NULL — the same `every` rule
// vendorAccess applies to reads. Mailing a mixed box to one of its suppliers
// would leak the other's PO numbers into their inbox.
function _supplierOfShipment(shipmentId, c) {
  const sids = [...new Set(c.shipmentPos
    .filter((j) => j.shipmentId === shipmentId)
    .map((j) => (c.poByNumber.get(j.poNumber) || {}).supplierId || null))];
  return sids.length === 1 ? sids[0] : null;
}

// PO numbers in the box — the only handle an SMS recipient has on what moved.
const _poRefs = (shipmentId, c) => [...new Set(c.shipmentPos
  .filter((j) => j.shipmentId === shipmentId).map((j) => j.poNumber))].join(', ');

// Vendor scoping lives in utils/vendorScope (one copy, was four). Write paths use
// the default onUnlinked:'throw' — a vendor with no supplier link gets a 403.
const _vendorSupplierId = (user) => resolveVendorSupplierId(user);

async function _ctx() {
  const [shipments, shipmentPos, pos, poLines, trackingEvents, packingCartons, cartonFacts, codeRows, statuses, couriers, modes, facilities, seasons, suppliers, bookings, bookingPos, receipts, receiptLines, rejections] = await Promise.all([
    M.shipments.read(), M.shipmentPos.read(), M.pos.read(), M.poLines.read(),
    M.trackingEvents.read().catch(() => []), M.packingCartons.read().catch(() => []), M.cartons.read().catch(() => []),
    M.courierStatusMap.read().catch(() => []),
    M.statuses.read(), M.couriers.read().catch(() => []), M.modes.read().catch(() => []), M.facilities.read(),
    M.seasons.read().catch(() => []), M.suppliers.read().catch(() => []),
    M.bookings.read().catch(() => []), M.bookingPos.read().catch(() => []),
    M.receipts.read().catch(() => []), M.receiptLines.read().catch(() => []),
    M.receiptRejections.read().catch(() => []),
  ]);
  return {
    shipments, shipmentPos, pos, poLines, trackingEvents, packingCartons, cartonFacts,
    // NetSuite Item Receipts attributed per lot → the derived 'Received' status.
    // Built over ALL shipments/junctions (never the vendor-filtered slice): the
    // attribution pairs every lot of a PO with its IR, so a partial view would
    // shift which lot each receipt lands on.
    received: receivedByShipment({ junctions: shipmentPos, cartons: packingCartons, receipts, receiptLines, shipments, rejections }),
    // booking join — a booked consignment shows its authorization + booked qty
    bookingNumber: new Map(bookings.map((b) => [b.id, b.bookingNumber])),
    bookedByLot: new Map(bookingPos.map((bp) => [`${bp.poNumber}|${bp.lotNumber}`, Number(bp.units) || 0])),
    codeMap: new Map(codeRows.map((r) => [`${r.courierId}|${r.courierCode}`, r.statusId])),
    statusNameById: new Map(statuses.map((s) => [s.id, s.name])),
    // Manual-status vocabulary for a SHIPMENT. Filtering on `module` alone was
    // correct when written (2026-07-23, e127fad) — SMS had only shipment statuses
    // then. SMS bookings (2026-08-07) added four rows that are also module='sms',
    // which silently widened this list, so a booking state (e.g. 'Cancelled' →
    // sms_bk_cancelled) could be stored on a shipment row: the box then reads
    // Cancelled but is not in TERMINAL_STATUS_IDS (polled forever), never enters
    // the Delivered/Received done set (stuck in the Active view), and carries a
    // booking-category id that fails a CHECK at the Postgres migration.
    // `category` is what separates the two families — filter on BOTH.
    // 'both' is included because Cancelled serves bookings AND shipments (one row
    // per module name, same as mainline). It is excluded from the hand-settable
    // list further down, so widening this does not put it in the dropdown.
    smsStatuses: statuses.filter((s) => s.module === 'sms' && (s.category === 'shipment' || s.category === 'both')),
    courierName: new Map(couriers.map((cr) => [cr.id, cr.name])),
    // Sea / Air / Courier. Null mode = a plain vendor-entered parcel; the
    // landed-cost push falls back to COURIER, so the unbooked flow is unchanged.
    modeName: new Map(modes.map((m) => [m.id, m.name])),
    facName: new Map(facilities.map((f) => [f.id, f.name])),
    seasonCode: new Map(seasons.map((s) => [s.id, s.code])),
    supName: new Map(suppliers.map((sp) => [sp.id, sp.name])),
    poByNumber: new Map(pos.map((p) => [p.poNumber, p])),
    eventsByShipment: trackingEvents.reduce((m, e) => ((m[e.shipmentId] = m[e.shipmentId] || []).push(e), m), {}),
  };
}

function _enrich(s, c) {
  const myPos = c.shipmentPos.filter((j) => j.shipmentId === s.id)
    .sort((a, b) => (a.lotNumber || 0) - (b.lotNumber || 0));
  const poByNumber = new Map(c.pos.map((p) => [p.poNumber, p]));
  // SKU rows for this shipment, with the physical carton's weight/measure joined
  // back on (stored once in sms_cartons — see smsService.withCartonFacts).
  const myCartons = status.withCartonFacts(
    (c.packingCartons || []).filter((k) => k.shipmentId === s.id),
    c.cartonFacts || [],
  );
  // Carton count per PO: the vendor's declared figure, else — when they left it
  // blank at entry — the actual distinct cartons from the uploaded shipping data.
  const actualCartonsByPo = status.packingCartonsCountByPo(myCartons);
  const cartonsForPo = (j) => (j.cartons != null ? j.cartons : (actualCartonsByPo.get(j.poNumber) ?? null));
  // Season & supplier are DERIVED from the shipment's POs (normally one each;
  // distinct set joined defensively) — never stored on the shipment row (3NF).
  const seasonSet = [...new Set(myPos.map((j) => c.seasonCode.get((poByNumber.get(j.poNumber) || {}).seasonId)).filter(Boolean))];
  const supplierSet = [...new Set(myPos.map((j) => c.supName.get((poByNumber.get(j.poNumber) || {}).supplierId)).filter(Boolean))];
  return {
    ...s,
    courier: c.courierName.get(s.courierId) || null,
    mode: c.modeName.get(s.modeId) || null,
    facility: c.facName.get(s.facilityId) || null,
    season: seasonSet.join(', ') || null,
    supplier: supplierSet.join(', ') || null,
    // booking (optional) — DERIVED flags, never stored. isBooked drives the
    // mainline-style financial block; isDraft = approved but not yet shipped.
    bookingNumber: s.bookingId ? (c.bookingNumber.get(s.bookingId) || null) : null,
    isBooked: !!s.bookingId,
    isDraft: !!s.bookingId && !s.trackingNumber,
    ...status.deriveStatus(s, c.eventsByShipment, c.codeMap, c.statusNameById, c.received),
    // NetSuite receiving (derived) — set once every PO in the box has an Item
    // Receipt attributed to this lot, which is also what promotes Delivered →
    // Received above. receivedConfirmed = a human signed off every match on the
    // Landed Costs page (vs the quantity/sequence auto-suggestion).
    receivedDate: (c.received.get(s.id) || {}).receiptDate ?? null,
    receivedIrs: (c.received.get(s.id) || {}).ir_tranids ?? [],
    receivedConfirmed: (c.received.get(s.id) || {}).confirmed ?? false,
    // shipping data (derived) — present once the vendor uploads the packing Excel
    hasShippingData: myCartons.length > 0,
    packingSummary: myCartons.length ? status.packingSummary(myCartons) : null,
    pos: myPos.map((j) => ({
      poNumber: j.poNumber,
      lotNumber: j.lotNumber,
      units: j.units,
      // booked qty for this lot (null when the shipment has no booking) — the
      // booked-vs-shipped variance is derived at read, never stored
      bookedUnits: s.bookingId ? (c.bookedByLot.get(`${j.poNumber}|${j.lotNumber}`) ?? null) : null,
      cartons: cartonsForPo(j),
      trnNumber: (poByNumber.get(j.poNumber) || {}).trnNumber || null,
      supplierId: (poByNumber.get(j.poNumber) || {}).supplierId || null,
      supplier: c.supName.get((poByNumber.get(j.poNumber) || {}).supplierId) || null,
    })),
    // consignment totals — DERIVED from the junction, never stored
    totalUnits: myPos.reduce((a, j) => a + (Number(j.units) || 0), 0),
    totalCartons: myPos.reduce((a, j) => a + (Number(cartonsForPo(j)) || 0), 0),
    // newest first by actual INSTANT — FedEx stamps each scan in the scan
    // location's local timezone, so a string sort scrambles mixed offsets
    trackingEvents: (c.eventsByShipment[s.id] || []).slice().sort((a, b) => Date.parse(b.eventTime) - Date.parse(a.eventTime)),
  };
}

// Vendor row scoping for reads. A consignment's supplier comes from its POs via the
// junction — see modules/sms/vendorAccess for why visibility requires ALL POs to be
// the vendor's and why a junction-less draft is staff-only.
async function getAll(req, res) {
  const [c, vendorSid] = await Promise.all([_ctx(), vendorScopeFor(req)]);
  const visible = shipmentVisibilityFn(c.shipmentPos, new Map(c.pos.map((p) => [p.poNumber, p.supplierId])), vendorSid);
  res.json(c.shipments.filter((s) => visible(s.id)).map((s) => _enrich(s, c)));
}

async function getOne(req, res) {
  const [c, vendorSid] = await Promise.all([_ctx(), vendorScopeFor(req)]);
  const s = c.shipments.find((x) => x.id === req.params.id);
  const visible = shipmentVisibilityFn(c.shipmentPos, new Map(c.pos.map((p) => [p.poNumber, p.supplierId])), vendorSid);
  // 404 (not 403) when it exists but isn't theirs — a 403 confirms the id is real.
  if (!s || !visible(s.id)) err('SMS shipment not found', 404);
  res.json(_enrich(s, c));
}

// shared by create/update: validate PO refs, vendor scope, overship
function _checkPos(entries, c, vendorSupplierId, { excludeShipmentId = null } = {}) {
  const seen = new Set();
  const warnings = [];
  for (const e of entries) {
    if (seen.has(e.poNumber)) err(`Duplicate PO '${e.poNumber}' in one consignment — combine the units`, 400);
    seen.add(e.poNumber);
    const po = c.pos.find((p) => p.poNumber === e.poNumber);
    if (!po) err(`'${e.poNumber}' is not an SMS PO`, 400);
    if (vendorSupplierId && po.supplierId !== vendorSupplierId) {
      err(`'${e.poNumber}' belongs to a different supplier — you can only ship your own POs`, 403);
    }
    const ordered = c.poLines.filter((l) => l.poNumber === e.poNumber)
      .reduce((a, l) => a + (Number(l.orderedQty) || 0), 0);
    const alreadyShipped = c.shipmentPos
      .filter((j) => j.poNumber === e.poNumber && j.shipmentId !== excludeShipmentId)
      .reduce((a, j) => a + (Number(j.units) || 0), 0);
    if (alreadyShipped + Number(e.units) > ordered) {
      warnings.push({ poNumber: e.poNumber, ordered, already_shipped: alreadyShipped, requested: Number(e.units) });
    }
  }
  return warnings;
}

async function create(req, res) {
  const vendorSupplierId = await _vendorSupplierId(req.user);
  const c = await _ctx();
  const { courierId, modeId, trackingNumber, shipDate, facilityId, pos: entries, force_overbook, force_overship } = req.body;

  if (!c.courierName.has(courierId)) err(`Unknown courierId '${courierId}'`, 400);
  if (modeId && !c.modeName.has(modeId)) err(`Unknown modeId '${modeId}'`, 400);
  if (trackingNumber && c.shipments.some((s) => s.trackingNumber === trackingNumber)) {
    err(`Tracking number '${trackingNumber}' already exists on another shipment`, 400);
  }

  const warnings = _checkPos(entries, c, vendorSupplierId);
  if (warnings.length && !(force_overship || force_overbook)) {
    return res.status(409).json({ overship_warning: true, warnings });
  }

  const id = String(c.shipments.reduce((mx, s) => Math.max(mx, Number(s.id) || 0), 0) + 1);
  const shipment = {
    id,
    courierId,
    // null for the normal vendor-entered parcel — see the modeId note in database.dbml
    modeId: modeId || null,
    trackingNumber: trackingNumber || null,
    shipDate: shipDate || null,
    // destination defaults to the (single) PO's facility when not sent
    facilityId: facilityId || (c.pos.find((p) => p.poNumber === entries[0].poNumber) || {}).facilityId || null,
    manualStatusId: 'sms_label_created',
    createdBy: req.user?.id || null,
    createdAt: new Date().toISOString(),
  };

  const maxLot = (poNumber) => c.shipmentPos.filter((j) => j.poNumber === poNumber)
    .reduce((mx, j) => Math.max(mx, Number(j.lotNumber) || 0), 0);
  const junctions = entries.map((e) => ({
    id: `spo_${id}_${e.poNumber}`,
    shipmentId: id,
    poNumber: e.poNumber,
    lotNumber: maxLot(e.poNumber) + 1,        // server-owned, per PO
    units: Number(e.units),
    cartons: e.cartons != null ? Number(e.cartons) : null,
  }));

  await M.shipments.write([...c.shipments, shipment]);
  await M.shipmentPos.write([...c.shipmentPos, ...junctions]);

  const c2 = await _ctx();
  res.status(201).json(_enrich(c2.shipments.find((s) => s.id === id), c2));
}

async function update(req, res) {
  const vendorSupplierId = await _vendorSupplierId(req.user);
  const c = await _ctx();
  const idx = c.shipments.findIndex((s) => s.id === req.params.id);
  if (idx < 0) err('SMS shipment not found', 404);
  const next = { ...c.shipments[idx] };
  const myJunctions = c.shipmentPos.filter((j) => j.shipmentId === next.id);

  // a vendor may only touch consignments that carry exclusively their POs
  if (vendorSupplierId) {
    const poByNumber = new Map(c.pos.map((p) => [p.poNumber, p]));
    if (!myJunctions.every((j) => (poByNumber.get(j.poNumber) || {}).supplierId === vendorSupplierId)) {
      err('This shipment carries another supplier\'s POs', 403);
    }
  }

  if (req.body.courierId !== undefined) {
    if (!c.courierName.has(req.body.courierId)) err(`Unknown courierId '${req.body.courierId}'`, 400);
    next.courierId = req.body.courierId;
  }
  // Correcting the mode moves the NetSuite shipping method (custbody16) on the NEXT
  // landed-cost post. A row already posted keeps its snapshot — that is by design.
  if (req.body.modeId !== undefined) {
    if (req.body.modeId && !c.modeName.has(req.body.modeId)) err(`Unknown modeId '${req.body.modeId}'`, 400);
    next.modeId = req.body.modeId || null;
  }
  if (req.body.trackingNumber !== undefined) {
    const tn = req.body.trackingNumber || null;
    if (tn && c.shipments.some((s) => s.id !== next.id && s.trackingNumber === tn)) {
      err(`Tracking number '${tn}' already exists on another shipment`, 400);
    }
    next.trackingNumber = tn;
  }
  if (req.body.shipDate !== undefined) next.shipDate = req.body.shipDate || null;
  if (req.body.facilityId !== undefined) next.facilityId = req.body.facilityId || null;
  if (req.body.manual_status !== undefined && req.body.manual_status) {
    // Two statuses are not hand-settable, for opposite reasons.
    // 'Received' is DERIVED from NetSuite Item Receipts — typing it would claim a
    // receipt that doesn't exist. 'Cancelled' is a DECISION with guards behind it
    // (POST /sms/shipments/:id/cancel); leaving it in the free setter would be a
    // gated action sitting beside an ungated field that reaches the same state.
    const NOT_BY_HAND = new Set(['sms_received', 'sms_cancelled']);
    const selectable = c.smsStatuses.filter((s) => !NOT_BY_HAND.has(s.id));
    const st = selectable.find((s) => s.name === req.body.manual_status);
    if (!st) {
      err(req.body.manual_status === 'Cancelled'
        ? "Use POST /sms/shipments/:id/cancel to cancel a consignment — it has guards this route does not"
        : `'manual_status' must be one of: ${selectable.map((s) => s.name).join(', ')} ('Received' is derived from a NetSuite Item Receipt)`, 400);
    }
    next.manualStatusId = st.id;
  }

  // ── BOOKED-consignment financials: ACTUALS off the broker/courier bill, typed
  // once per customs entry (mainline behaviour — no rate, no estimate). Only a
  // booked shipment has a formal entry; a vendor-entered one keeps the derived
  // CI × rate estimate, so accepting them there would create a second truth.
  const FIN = ['customsEntryNumber', 'freight', 'duty'];
  const financials = FIN.filter((f) => req.body[f] !== undefined);
  if (financials.length) {
    if (!next.bookingId) {
      err(`${financials.join(', ')} apply only to a booked consignment — an unbooked SMS shipment uses the derived CI × rate estimate`, 400);
    }
    if (vendorSupplierId) err('Freight, duty and the customs entry number are entered by Logistics', 403);
    if (req.body.customsEntryNumber !== undefined) next.customsEntryNumber = req.body.customsEntryNumber || null;
    if (req.body.freight !== undefined) next.freight = req.body.freight === null ? null : Number(req.body.freight);
    if (req.body.duty !== undefined) next.duty = req.body.duty === null ? null : Number(req.body.duty);
  }

  // per-PO corrections: units/cartons on EXISTING junction rows only
  let junctions = c.shipmentPos;
  if (Array.isArray(req.body.pos)) {
    for (const e of req.body.pos) {
      if (!myJunctions.some((j) => j.poNumber === e.poNumber)) {
        err(`'${e.poNumber}' is not on this shipment — add/remove POs by recreating the shipment`, 400);
      }
    }
    const warnings = _checkPos(req.body.pos, c, vendorSupplierId, { excludeShipmentId: next.id });
    if (warnings.length && !req.body.force_overship) {
      return res.status(409).json({ overship_warning: true, warnings });
    }
    junctions = c.shipmentPos.map((j) => {
      const e = j.shipmentId === next.id ? req.body.pos.find((x) => x.poNumber === j.poNumber) : null;
      return e ? { ...j, units: Number(e.units), cartons: e.cartons != null ? Number(e.cartons) : j.cartons } : j;
    });
  }

  const shipments = [...c.shipments];
  const before = c.shipments[idx];
  shipments[idx] = next;
  await M.shipments.write(shipments);
  if (junctions !== c.shipmentPos) await M.shipmentPos.write(junctions);

  // Only the HAND-SET status is reportable here. The consignment's real status is
  // derived per read from the latest courier scan (smsService.deriveStatus), and a
  // scan arriving from the FedEx poll is not something this request did — it would
  // be reported as an edit somebody made, which is a lie about who acted.
  const statusNameOf = (id) => (c.smsStatuses.find((s) => s.id === id) || {}).name || null;
  await notifyChange({
    module: 'sms', entity: 'sms_shipment', entityId: next.id,
    ref: next.trackingNumber || next.id,
    before, after: next,
    statusFrom: statusNameOf(before.manualStatusId), statusTo: statusNameOf(next.manualStatusId),
    supplierId: _supplierOfShipment(next.id, c),
    actor: req.user, link: `/sms/shipments/${next.id}`,
    context: [{ label: 'POs', value: _poRefs(next.id, c) || '—' }],
  });

  const c2 = await _ctx();
  res.json(_enrich(c2.shipments.find((s) => s.id === next.id), c2));
}

async function remove(req, res) {
  const vendorSupplierId = await _vendorSupplierId(req.user);
  const [shipments, shipmentPos, receipts, pos] = await Promise.all([
    M.shipments.read(), M.shipmentPos.read(), M.receipts.read().catch(() => []), M.pos.read(),
  ]);
  const s = shipments.find((x) => x.id === req.params.id);
  if (!s) err('SMS shipment not found', 404);
  if (vendorSupplierId) {
    const poByNumber = new Map(pos.map((p) => [p.poNumber, p]));
    const mine = shipmentPos.filter((j) => j.shipmentId === s.id)
      .every((j) => (poByNumber.get(j.poNumber) || {}).supplierId === vendorSupplierId);
    if (!mine) err('This shipment carries another supplier\'s POs', 403);
  }
  if (receipts.some((r) => r.matchedShipmentId === s.id)) {
    err('A confirmed item receipt is matched to this shipment — unmatch it first', 400);
  }
  // A posted landed cost is money already PATCHed onto a live NetSuite Item
  // Receipt. Deleting the shipment would leave that row pointing at nothing while
  // the charge stays on the NetSuite record — 38 SMS rows are in that state today.
  // `landed_costs.shipmentId` is a SOFT ref (no FK), so nothing else catches it.
  const posted = (await M.landedCosts.read().catch(() => []))
    .filter((r) => r.module === 'sms' && String(r.shipmentId) === String(s.id));
  if (posted.length) {
    err('A landed cost has been posted for this consignment and pushed to NetSuite — unpost it first (Landed Costs page)', 409);
  }
  await M.shipments.write(shipments.filter((x) => x.id !== s.id));
  await M.shipmentPos.write(shipmentPos.filter((j) => j.shipmentId !== s.id));   // cascade junction
  const events = await M.trackingEvents.read().catch(() => []);                   // cascade tracking log
  if (events.some((e) => e.shipmentId === s.id)) {
    await M.trackingEvents.write(events.filter((e) => e.shipmentId !== s.id));
  }
  const cartons = await M.packingCartons.read().catch(() => []);                  // cascade shipping data
  if (cartons.some((k) => k.shipmentId === s.id)) {
    await M.packingCartons.write(cartons.filter((k) => k.shipmentId !== s.id));
  }
  const cartonFacts = await M.cartons.read().catch(() => []);                     // cascade physical cartons
  if (cartonFacts.some((k) => k.shipmentId === s.id)) {
    await M.cartons.write(cartonFacts.filter((k) => k.shipmentId !== s.id));
  }
  const docs = await M.documents.read().catch(() => []);                          // cascade generated docs
  if (docs.some((d) => d.shipmentId === s.id)) {
    await M.documents.write(docs.filter((d) => d.shipmentId !== s.id));
  }
  // A rejected (receipt × shipment) suggestion is an assertion about THIS
  // shipment, so it goes with it. Missed until the Postgres migration added the
  // foreign key; one such row exists in live data.
  const rejections = await M.receiptRejections.read().catch(() => []);
  if (rejections.some((r) => r.shipmentId === s.id)) {
    await M.receiptRejections.write(rejections.filter((r) => r.shipmentId !== s.id));
  }
  res.status(204).send();
}

// POST /:id/cancel — call off a consignment that has NOT been handed over.
//
// In practice that means a BOOKING-APPROVED DRAFT: approve creates the shipment
// row with `trackingNumber` null and no ship date, and the vendor fills those in
// when the box actually goes. Every one of the 37 vendor-entered parcels is typed
// AFTER handover and carries both, so the guard excludes them without needing a
// rule about bookings — the evidence already says which is which. That is the same
// test `smsBookingController.cancel` applies at booking grain ("a shipment that
// actually went out blocks the cancel — that's history, not a plan").
//
// Cancel does NOT touch the booking: the booking still authorizes those lots, and
// re-approving it issues a fresh draft. Calling off the whole consignment is a
// decision taken on the booking.
async function cancel(req, res) {
  const vendorSupplierId = await _vendorSupplierId(req.user);
  const c = await _ctx();
  const idx = c.shipments.findIndex((s) => s.id === req.params.id);
  if (idx < 0) err('SMS shipment not found', 404);
  const s = c.shipments[idx];

  // Same ownership test `remove` makes: EVERY PO in the box must be the vendor's,
  // or a cross-supplier consignment would be actionable by one of its suppliers.
  if (vendorSupplierId) {
    const mine = c.shipmentPos.filter((j) => j.shipmentId === s.id)
      .every((j) => (c.poByNumber.get(j.poNumber) || {}).supplierId === vendorSupplierId);
    if (!mine) err("This shipment carries another supplier's POs", 403);
  }

  if (s.manualStatusId === 'sms_cancelled') err('This consignment is already cancelled', 409);

  const [receipts, landedCosts] = await Promise.all([
    M.receipts.read().catch(() => []), M.landedCosts.read().catch(() => []),
  ]);

  const why = [];
  const handover = [];
  if (s.trackingNumber) handover.push(`tracking ${s.trackingNumber}`);
  if (s.shipDate) handover.push(`shipped ${String(s.shipDate).slice(0, 10)}`);
  if (handover.length) {
    why.push(`it has already been handed to the carrier (${handover.join(', ')})`);
  }
  const confirmed = receipts.filter((r) => r.matchedShipmentId === s.id && r.confirmedAt);
  if (confirmed.length) {
    why.push(`NetSuite has ${confirmed.length} confirmed item receipt${confirmed.length === 1 ? '' : 's'} for it`);
  }
  const posted = landedCosts.filter((r) => r.module === 'sms' && String(r.shipmentId) === String(s.id));
  if (posted.length) why.push('its landed cost is posted');

  if (why.length) {
    err(`This consignment cannot be cancelled because ${why.join('; and ')}.`, 409);
  }

  const shipments = [...c.shipments];
  shipments[idx] = { ...s, manualStatusId: 'sms_cancelled' };
  await M.shipments.write(shipments);

  await notifyChange({
    module: 'sms', entity: 'sms_shipment', entityId: s.id,
    ref: s.trackingNumber || s.id,
    action: 'has been CANCELLED',
    context: [{ label: 'POs', value: _poRefs(s.id, c) || '—' }],
    supplierId: _supplierOfShipment(s.id, c),
    actor: req.user, link: `/sms/shipments/${s.id}`,
  });

  const c2 = await _ctx();
  res.json(_enrich(c2.shipments.find((x) => x.id === s.id), c2));
}

module.exports = { getAll, getOne, create, update, cancel, remove };
