'use strict';

// Mainline shipments (Phase 3) — tracking records. getAll/getOne/update/remove/bulkStatus.
// Status changes validate against MAINLINE_SHIPMENT_STATUSES only.

const { models } = require('../../../models');
const SupplierModel = models.suppliers;
const ModeModel = models.modes;
const status = require('../statuses');
const { enrichShipments } = require('./mainlineShipmentService');
const { resolveVendorSupplierId } = require('../../../utils/vendorScope');
const { assertLegVisible } = require('../vendorAccess');
const { cascadeShipmentDelete } = require('./shipmentCleanup');
const lifecycle = require('./shipmentLifecycle');

// Read-only here, and both are owned elsewhere: `landed_costs` belongs to the
// landed-cost module (a posted row records money already pushed to NetSuite) and
// the receipts are NetSuite's. The lifecycle guards only ask whether they exist.
const LandedCostModel = models.landed_costs;
const ItemReceiptModel = models.mainline_item_receipts;
// same attribution the ATA and the landed-cost push use — one answer to "which IR
// belongs to this consignment", per the note at the top of that file
const { resolveMainlineReceipts } = require('../receipts/mainlineReceiptMatch');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };

// Journey chronology guard: whichever of these dates are filled must not go
// backwards, else transit-time durations turn negative and poison lane averages.
// (CRD is leg-owned and can legitimately differ per leg, so it isn't checked here.)
const DATE_ORDER = [
  ['cargoReceivedDate', 'Cargo Received'],
  ['etdPol',             'ETD POL'],
  ['etaPod',             'ETA POD'],
  ['eDel',               'E-DEL'],
  ['ata',                 'ATA'],
];
function checkChronology(shipment) {
  const filled = DATE_ORDER.map(([k, label]) => ({ label, v: shipment[k] })).filter((d) => d.v);
  for (let i = 1; i < filled.length; i++) {
    if (filled[i].v < filled[i - 1].v) {
      err(`${filled[i].label} (${filled[i].v}) cannot be before ${filled[i - 1].label} (${filled[i - 1].v})`, 400);
    }
  }
}

async function _ctx() {
  const [shipLegs, bookingLegs, packingCartons, legs, orders, masters, suppliers, facilities, channels, ports, containerTypes, bookings, modes, seasons, itemReceipts, itemReceiptLines, couriers, receiptRejections, allShipments] = await Promise.all([
    models.mainline_shipment_legs.read(), models.mainline_booking_po_legs.read().catch(() => []),
    models.mainline_packing_cartons.read().catch(() => []),
    models.mainline_po_legs.read(), models.po_orders.read(), models.po_masters.read(),
    SupplierModel.read().catch(() => []),
    models.warehouse_facilities.read().catch(() => []),
    models.allocation_channels.read().catch(() => []),
    models.ports.read().catch(() => []),
    models.container_types.read().catch(() => []),
    models.mainline_bookings.read().catch(() => []), ModeModel.read().catch(() => []),
    models.seasons.read().catch(() => []),
    models.mainline_item_receipts.read().catch(() => []),
    models.mainline_item_receipt_lines.read().catch(() => []),
    models.couriers.read().catch(() => []),
    // human "no" on a suggested (IR × shipment) pair — the ATA attribution must
    // honour it too, else a rejected match would still drive the arrival date.
    models.mainline_receipt_match_rejections.read().catch(() => []),
    // the UNFILTERED shipment table — the receipt matcher is competitive and must
    // see every consignment carrying a PO, even ones this caller cannot read
    models.mainline_shipments.read(),
  ]);
  return { shipLegs, bookingLegs, packingCartons, legs, orders, masters, suppliers, facilities, channels, ports, containerTypes, bookings, modes, seasons, itemReceipts, itemReceiptLines, couriers, receiptRejections, allShipments };
}

async function _enrich(shipments, ctx) {
  const idToStatusName = new Map();
  await Promise.all(shipments.map(async (s) => idToStatusName.set(s.statusId, await status.nameForId(s.statusId))));
  return enrichShipments(shipments, { ...ctx, idToStatusName });
}

// Vendor row scoping. A shipment has no supplier of its own — it inherits it from
// its booking (mainline_bookings.supplierId, one supplier per booking by G1).
//
// Only the shipment LIST is filtered; the enrichment context stays whole so joined
// names still resolve. This does not skew derived values: enrichShipments allocates
// received units FIFO across a PO's shipment legs, and supplier scoping is CLOSED
// over PO → booking → shipment (every shipment touching a PO belongs to that PO's
// supplier), so a vendor's filtered set contains all shipments for their own POs and
// the allocation is identical. Verified field-by-field against the unscoped read.
const shipmentScope = (req) => resolveVendorSupplierId(req.user, { onUnlinked: 'deny' });
function visibleShipments(shipments, ctx, vendorSid) {
  if (vendorSid == null) return shipments;
  const myBookings = new Set(
    ctx.bookings.filter((b) => String(b.supplierId) === String(vendorSid)).map((b) => b.id),
  );
  return shipments.filter((s) => myBookings.has(s.bookingId));
}

async function getAll(req, res) {
  const [shipments, ctx, vendorSid] = await Promise.all([models.mainline_shipments.read(), _ctx(), shipmentScope(req)]);
  res.json(await _enrich(visibleShipments(shipments, ctx, vendorSid), ctx));
}

async function getOne(req, res) {
  const [shipments, ctx, vendorSid] = await Promise.all([models.mainline_shipments.read(), _ctx(), shipmentScope(req)]);
  const s = shipments.find((x) => x.id === req.params.id);
  // 404, not 403 — see the booking controller: a 403 confirms the id exists.
  if (!s || !visibleShipments([s], ctx, vendorSid).length) err('Shipment not found', 404);
  res.json((await _enrich([s], ctx))[0]);
}

// GET /mainline/legs/:legId/shipments — the consignments carrying ONE PO leg, for
// the Shipments section on the PO leg detail page. The mainline answer to the SMS
// PO detail's lot table, at the grain the junction actually keys on: a leg, not a
// TRN. (On a TRN one shipment shows up under several legs and quantities double-
// count — live data has shipments 2-9 each carrying two legs.)
//
// Quantities are the SHIPPED actuals from the shipping-data upload, not the booked
// expectedQuantity, so this table and the commercial invoice quote one number.
async function getByLeg(req, res) {
  const { legId } = req.params;
  // 404s (never 403s) if the leg isn't the caller's — see vendorAccess.
  const vendorSid = await assertLegVisible(req, legId);
  const [shipments, ctx] = await Promise.all([models.mainline_shipments.read(), _ctx()]);
  const carrying = new Set(
    ctx.shipLegs.filter((j) => String(j.legId) === String(legId)).map((j) => String(j.shipmentId)),
  );
  // The leg guard already settles visibility (a leg's shipments belong to its PO's
  // supplier by G1), so this second filter is defence in depth, not the control.
  const mine = visibleShipments(shipments.filter((s) => carrying.has(String(s.id))), ctx, vendorSid);

  // RECEIVED per lot. Item Receipts attach to a poNumber, not to a shipment, so
  // the per-lot figure comes from the shared attribution resolver — the same one
  // that decides the ATA and the landed-cost push target, so all three agree on
  // which IR belongs to which consignment. Without this the page could show a
  // leg-level discrepancy with no way to tell which lot caused it.
  const legRow = ctx.legs.find((l) => String(l.id) === String(legId));
  const legPo = legRow ? legRow.poNumber : null;
  const matchCtx = {
    mlReceipts: ctx.itemReceipts, mlReceiptLines: ctx.itemReceiptLines,
    mlShipmentLegs: ctx.shipLegs, mlRejections: ctx.receiptRejections,
    // the UNFILTERED table: the matcher is competitive, so every consignment
    // carrying this PO has to be in the pool or the attribution shifts
    mlShipments: ctx.allShipments,
    poByLeg: new Map(ctx.legs.map((l) => [l.id, l.poNumber])),
  };
  // Resolved per shipment rather than once: the resolver returns only the target
  // for the id it is asked about. It re-resolves the whole PO each call, which is
  // what keeps the answers consistent — and a leg carries a handful of lots.
  const receivedFor = (shipmentId) => {
    if (!legPo) return null;
    const t = resolveMainlineReceipts(shipmentId, [legPo], matchCtx)[0];
    return t && t.receiptId ? t : null;
  };

  const rows = (await _enrich(mine, ctx)).map((s) => {
    const leg = (s.legs || []).find((l) => String(l.legId) === String(legId)) || {};
    const rec = receivedFor(s.id);
    return {
      shipmentId:             s.id,
      shipmentNumber:         s.shipmentNumber || null,
      lotNumber:              leg.lotNumber ?? null,
      // The freight forwarder's own reference. Left BLANK when absent — no fallback
      // to BL or SHP-N: the forwarder's number is the one being asked for, and a
      // substitute that looks like it would be worse than an empty cell.
      carrier_shipment_number: s.carrierReference || null,
      // CRD (actual) = the day the cargo was actually ready/handed to the forwarder,
      // per shipment. Distinct from the leg's CRD (the WIP target) shown above it on
      // the page — they differ on 15 of 17 live rows, which is the point of showing it.
      crd_actual:              s.cargoReceivedDate || null,
      shippedQty:             leg.shippedQty ?? null,
      shippedCartons:         leg.shippedCartons ?? null,
      // NULL, never 0, when no IR is attributed — "not received yet" and "received
      // nothing" are different answers and only one of them is a discrepancy.
      receivedQty:            rec ? (rec.receiptQty ?? null) : null,
      received_ir:             rec ? (rec.netsuiteIrTranid || null) : null,
      receivedDate:           rec ? (rec.receiptDate || null) : null,
      // an unconfirmed attribution is a SUGGESTION — the UI marks it as such
      receivedConfirmed:      rec ? !!rec.confirmed : false,
      status:                  s.status || null,
    };
  }).sort((a, b) => (a.lotNumber ?? 0) - (b.lotNumber ?? 0)
    || String(a.shipmentNumber || '').localeCompare(String(b.shipmentNumber || ''), undefined, { numeric: true }));

  res.json(rows);
}

async function update(req, res) {
  const shipments = await models.mainline_shipments.read();
  const idx = shipments.findIndex((s) => s.id === req.params.id);
  if (idx < 0) err('Shipment not found', 404);
  const next = { ...shipments[idx] };

  // CANCELLED IS NOT A STATUS YOU TYPE. It is a decision with guards behind it
  // (`cancel` below), and leaving it in the generic status setter would be the
  // same hole the booking approve bypass was: one gated action, and beside it an
  // ungated field that reaches the same state. Both directions are closed —
  // a cancelled consignment does not come back either, because re-approving its
  // booking now issues a fresh shipment, which keeps the cancelled one as a record
  // of what happened instead of quietly reusing it.
  const wasStatus = await status.nameForId(next.statusId);
  if (req.body.status === 'Cancelled' && wasStatus !== 'Cancelled') {
    err('Use POST /mainline/shipments/:id/cancel to cancel a consignment — it has guards this route does not', 400);
  }
  if (wasStatus === 'Cancelled' && req.body.status && req.body.status !== 'Cancelled') {
    err('This consignment is cancelled and cannot be reopened — re-approve its booking to issue a new one', 409);
  }

  if (req.body.status) next.statusId = await status.idForName(req.body.status);

  // ACTUAL carrier. Validated because it decides the landed-cost BASIS: a carrier
  // that does not invoice freight & duty separately (FedEx/DHL) makes the shipment
  // an ESTIMATE off the CI value instead of typed actuals.
  const couriers = await models.couriers.read().catch(() => []);
  if (req.body.courierId !== undefined) {
    if (req.body.courierId && !couriers.some((cr) => cr.id === req.body.courierId)) {
      err(`Unknown courierId '${req.body.courierId}'`, 400);
    }
    next.courierId = req.body.courierId || null;
  }
  // Typed freight/duty belong to the ACTUAL basis only. On an estimate-basis carrier
  // they would be a second, contradictory truth beside the derived CI × rate figure —
  // the same reason smsShipmentController refuses them on an unbooked consignment.
  // Checked against the carrier AFTER the assignment above, so switching carrier and
  // amounts in one request is judged on the carrier the request actually leaves set.
  const carrier = couriers.find((cr) => cr.id === next.courierId) || null;
  const isEstimateBasis = !!carrier && carrier.providesCostInvoices === false;
  const typedAmounts = ['freight', 'duty'].filter((f) => req.body[f] !== undefined && req.body[f] !== null);
  if (typedAmounts.length && isEstimateBasis) {
    err(`${carrier.name} does not invoice freight & duty separately, so this shipment's landed cost is estimated from the commercial-invoice value — ${typedAmounts.join(' and ')} cannot be entered by hand`, 400);
  }
  // Header-level fields = the SHARED logistics facts for the whole physical shipment.
  // Editing them once propagates to every PO leg in the consignment.
  // (expectedQuantity + lotNumber are per-leg → live on the junction, not here.
  //  `ata` is the actual receipt date — manual now, NetSuite later. Expected ATA is
  //  derived (eDel + 5) and therefore not editable.)
  for (const k of ['etdPol', 'etaPod', 'eDel', 'cargoReceivedDate', 'ata', 'netsuiteId',
                   'blNo', 'carrierReference', 'customsEntryNumber', 'containerTypeId', 'polPortId', 'podPortId', 'invoiceValue', 'duty', 'freight']) {
    if (req.body[k] !== undefined) next[k] = req.body[k];
  }
  checkChronology(next);   // 400 before anything is written
  shipments[idx] = next;
  await models.mainline_shipments.write(shipments);
  const ctx = await _ctx();
  res.json((await _enrich([shipments[idx]], ctx))[0]);
}

async function bulkStatus(req, res) {
  const { ids, status: statusName } = req.body;
  const shipments = await models.mainline_shipments.read();
  const statusId = await status.idForName(statusName);
  const idSet = new Set(ids);
  let updated = 0;
  shipments.forEach((s) => { if (idSet.has(s.id)) { s.statusId = statusId; updated++; } });
  await models.mainline_shipments.write(shipments);
  res.json({ updated });
}

// Everything the lifecycle guards need to see. Loaded together so cancel and
// delete judge a consignment on exactly the same facts.
async function _lifecycleCtx() {
  const [landedCosts, receipts] = await Promise.all([
    LandedCostModel.read().catch(() => []),
    ItemReceiptModel.read().catch(() => []),
  ]);
  return { landedCosts, receipts };
}

// POST /:id/cancel — the way out of a consignment that has NOT left the supplier.
//
// Cancel withdraws the CONVEYANCE, never the authorization: the booking stays
// Approved, its units stay committed against the leg, and nobody else can take the
// space. That is the normal case — a sailing falls through and the same goods go
// next week. If the whole consignment is off, that is a decision about the BOOKING,
// taken on the booking.
async function cancel(req, res) {
  const shipments = await models.mainline_shipments.read();
  const idx = shipments.findIndex((s) => s.id === req.params.id);
  if (idx < 0) err('Shipment not found', 404);
  const ship = shipments[idx];

  const statusName = await status.nameForId(ship.statusId);
  if (statusName === 'Cancelled') err('This consignment is already cancelled', 409);

  const why = lifecycle.cancelBlockers(ship, await _lifecycleCtx());
  if (why.length) {
    err(`${ship.shipmentNumber} cannot be cancelled because ${why.join('; and ')}.`, 409);
  }

  shipments[idx] = { ...ship, statusId: await status.idForName('Cancelled') };
  await models.mainline_shipments.write(shipments);
  const ctx = await _ctx();
  res.json({
    ...(await _enrich([shipments[idx]], ctx))[0],
    // The status the row was in when it was called off. A cancelled consignment
    // otherwise loses the only trace of how far it had got.
    cancelled_from: statusName,
    // The typed status said it had moved and no record backed that up — the client
    // asked anyway (see `confirm_status_conflict`), so say so in the response.
    status_conflicted: lifecycle.statusDisagrees(ship, statusName),
  });
}

// Four tables key on a shipment; this used to clear one of them (the junction).
// cascadeShipmentDelete owns the rest — see that module for why the ASN and the
// rejections are DELETED while the Item Receipts are only UNLINKED.
//
// The guards in front of it are the point: delete is for a consignment entered by
// mistake, so it asks that someone first CANCELLED it, and it refuses outright
// while a record NetSuite owns still points at it — a posted landed cost (money
// already PATCHed onto a live Item Receipt) or a confirmed receipt. Each of those
// has its own deliberate reversal, and the message names it.
async function remove(req, res) {
  const shipments = await models.mainline_shipments.read();
  const id = req.params.id;
  const ship = shipments.find((s) => s.id === id);
  if (!ship) err('Shipment not found', 404);

  const statusName = await status.nameForId(ship.statusId);
  const why = lifecycle.deleteBlockers(ship, statusName, await _lifecycleCtx());
  if (why.length) {
    err(`${ship.shipmentNumber} cannot be deleted because ${why.join('; and ')}.`, 409);
  }

  await models.mainline_shipments.write(shipments.filter((s) => s.id !== id));
  await cascadeShipmentDelete([id]);
  res.status(204).send();
}

module.exports = { getAll, getOne, getByLeg, update, bulkStatus, cancel, remove };
