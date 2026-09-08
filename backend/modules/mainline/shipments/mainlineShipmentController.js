'use strict';

// Mainline shipments (Phase 3) — tracking records. getAll/getOne/update/remove/bulkStatus.
// Status changes validate against MAINLINE_SHIPMENT_STATUSES only.

const MainlineShipmentModel = require('./MainlineShipmentModel');
const MainlineShipmentLegModel = require('./MainlineShipmentLegModel');
const MainlineLegModel = require('../legs/MainlineLegModel');
const MainlineBookingModel = require('../bookings/MainlineBookingModel');
const PoOrderModel = require('../../po/PoOrderModel');
const PoMasterModel = require('../../po/PoMasterModel');
const { suppliers: SupplierModel, modes: ModeModel } = require('../../../models/MasterDataModel');
const BaseModel = require('../../../models/BaseModel');
const status = require('../statuses');
const { enrichShipments } = require('./mainlineShipmentService');
const { resolveVendorSupplierId } = require('../../../utils/vendorScope');
const { assertLegVisible } = require('../vendorAccess');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };

// Journey chronology guard: whichever of these dates are filled must not go
// backwards, else transit-time durations turn negative and poison lane averages.
// (CRD is leg-owned and can legitimately differ per leg, so it isn't checked here.)
const DATE_ORDER = [
  ['cargo_received_date', 'Cargo Received'],
  ['etd_pol',             'ETD POL'],
  ['eta_pod',             'ETA POD'],
  ['e_del',               'E-DEL'],
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
    MainlineShipmentLegModel.read(), MainlineBookingModel.readBookingLegs().catch(() => []),
    new BaseModel('migrated/mainline_packing_cartons.json').read().catch(() => []),
    MainlineLegModel.readLegs(), PoOrderModel.readOrders(), PoMasterModel.read(),
    SupplierModel.read().catch(() => []),
    new BaseModel('migrated/warehouse_facilities.json').read().catch(() => []),
    new BaseModel('migrated/allocation_channels.json').read().catch(() => []),
    new BaseModel('migrated/ports.json').read().catch(() => []),
    new BaseModel('migrated/container_types.json').read().catch(() => []),
    MainlineBookingModel.readBookings().catch(() => []), ModeModel.read().catch(() => []),
    new BaseModel('migrated/seasons.json').read().catch(() => []),
    new BaseModel('migrated/mainline_item_receipts.json').read().catch(() => []),
    new BaseModel('migrated/mainline_item_receipt_lines.json').read().catch(() => []),
    new BaseModel('couriers.json').read().catch(() => []),
    // human "no" on a suggested (IR × shipment) pair — the ATA attribution must
    // honour it too, else a rejected match would still drive the arrival date.
    new BaseModel('migrated/mainline_receipt_match_rejections.json').read().catch(() => []),
    // the UNFILTERED shipment table — the receipt matcher is competitive and must
    // see every consignment carrying a PO, even ones this caller cannot read
    MainlineShipmentModel.read(),
  ]);
  return { shipLegs, bookingLegs, packingCartons, legs, orders, masters, suppliers, facilities, channels, ports, containerTypes, bookings, modes, seasons, itemReceipts, itemReceiptLines, couriers, receiptRejections, allShipments };
}

async function _enrich(shipments, ctx) {
  const idToStatusName = new Map();
  await Promise.all(shipments.map(async (s) => idToStatusName.set(s.status_id, await status.nameForId(s.status_id))));
  return enrichShipments(shipments, { ...ctx, idToStatusName });
}

// Vendor row scoping. A shipment has no supplier of its own — it inherits it from
// its booking (mainline_bookings.supplier_id, one supplier per booking by G1).
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
    ctx.bookings.filter((b) => String(b.supplier_id) === String(vendorSid)).map((b) => b.id),
  );
  return shipments.filter((s) => myBookings.has(s.booking_id));
}

async function getAll(req, res) {
  const [shipments, ctx, vendorSid] = await Promise.all([MainlineShipmentModel.read(), _ctx(), shipmentScope(req)]);
  res.json(await _enrich(visibleShipments(shipments, ctx, vendorSid), ctx));
}

async function getOne(req, res) {
  const [shipments, ctx, vendorSid] = await Promise.all([MainlineShipmentModel.read(), _ctx(), shipmentScope(req)]);
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
// expected_quantity, so this table and the commercial invoice quote one number.
async function getByLeg(req, res) {
  const { legId } = req.params;
  // 404s (never 403s) if the leg isn't the caller's — see vendorAccess.
  const vendorSid = await assertLegVisible(req, legId);
  const [shipments, ctx] = await Promise.all([MainlineShipmentModel.read(), _ctx()]);
  const carrying = new Set(
    ctx.shipLegs.filter((j) => String(j.leg_id) === String(legId)).map((j) => String(j.shipment_id)),
  );
  // The leg guard already settles visibility (a leg's shipments belong to its PO's
  // supplier by G1), so this second filter is defence in depth, not the control.
  const mine = visibleShipments(shipments.filter((s) => carrying.has(String(s.id))), ctx, vendorSid);

  const rows = (await _enrich(mine, ctx)).map((s) => {
    const leg = (s.legs || []).find((l) => String(l.leg_id) === String(legId)) || {};
    return {
      shipment_id:             s.id,
      shipment_number:         s.shipment_number || null,
      lot_number:              leg.lot_number ?? null,
      // The freight forwarder's own reference. Left BLANK when absent — no fallback
      // to BL or SHP-N: the forwarder's number is the one being asked for, and a
      // substitute that looks like it would be worse than an empty cell.
      carrier_shipment_number: s.carrier_reference || null,
      // CRD (actual) = the day the cargo was actually ready/handed to the forwarder,
      // per shipment. Distinct from the leg's CRD (the WIP target) shown above it on
      // the page — they differ on 15 of 17 live rows, which is the point of showing it.
      crd_actual:              s.cargo_received_date || null,
      shipped_qty:             leg.shipped_qty ?? null,
      shipped_cartons:         leg.shipped_cartons ?? null,
      status:                  s.status || null,
    };
  }).sort((a, b) => (a.lot_number ?? 0) - (b.lot_number ?? 0)
    || String(a.shipment_number || '').localeCompare(String(b.shipment_number || ''), undefined, { numeric: true }));

  res.json(rows);
}

async function update(req, res) {
  const shipments = await MainlineShipmentModel.read();
  const idx = shipments.findIndex((s) => s.id === req.params.id);
  if (idx < 0) err('Shipment not found', 404);
  const next = { ...shipments[idx] };
  if (req.body.status) next.status_id = await status.idForName(req.body.status);

  // ACTUAL carrier. Validated because it decides the landed-cost BASIS: a carrier
  // that does not invoice freight & duty separately (FedEx/DHL) makes the shipment
  // an ESTIMATE off the CI value instead of typed actuals.
  const couriers = await new BaseModel('couriers.json').read().catch(() => []);
  if (req.body.courier_id !== undefined) {
    if (req.body.courier_id && !couriers.some((cr) => cr.id === req.body.courier_id)) {
      err(`Unknown courier_id '${req.body.courier_id}'`, 400);
    }
    next.courier_id = req.body.courier_id || null;
  }
  // Typed freight/duty belong to the ACTUAL basis only. On an estimate-basis carrier
  // they would be a second, contradictory truth beside the derived CI × rate figure —
  // the same reason smsShipmentController refuses them on an unbooked consignment.
  // Checked against the carrier AFTER the assignment above, so switching carrier and
  // amounts in one request is judged on the carrier the request actually leaves set.
  const carrier = couriers.find((cr) => cr.id === next.courier_id) || null;
  const isEstimateBasis = !!carrier && carrier.provides_cost_invoices === false;
  const typedAmounts = ['freight', 'duty'].filter((f) => req.body[f] !== undefined && req.body[f] !== null);
  if (typedAmounts.length && isEstimateBasis) {
    err(`${carrier.name} does not invoice freight & duty separately, so this shipment's landed cost is estimated from the commercial-invoice value — ${typedAmounts.join(' and ')} cannot be entered by hand`, 400);
  }
  // Header-level fields = the SHARED logistics facts for the whole physical shipment.
  // Editing them once propagates to every PO leg in the consignment.
  // (expected_quantity + lot_number are per-leg → live on the junction, not here.
  //  `ata` is the actual receipt date — manual now, NetSuite later. Expected ATA is
  //  derived (e_del + 5) and therefore not editable.)
  for (const k of ['etd_pol', 'eta_pod', 'e_del', 'cargo_received_date', 'ata', 'netsuite_id',
                   'bl_no', 'carrier_reference', 'customs_entry_number', 'container_type_id', 'pol_port_id', 'pod_port_id', 'invoice_value', 'duty', 'freight']) {
    if (req.body[k] !== undefined) next[k] = req.body[k];
  }
  checkChronology(next);   // 400 before anything is written
  shipments[idx] = next;
  await MainlineShipmentModel.write(shipments);
  const ctx = await _ctx();
  res.json((await _enrich([shipments[idx]], ctx))[0]);
}

async function bulkStatus(req, res) {
  const { ids, status: statusName } = req.body;
  const shipments = await MainlineShipmentModel.read();
  const statusId = await status.idForName(statusName);
  const idSet = new Set(ids);
  let updated = 0;
  shipments.forEach((s) => { if (idSet.has(s.id)) { s.status_id = statusId; updated++; } });
  await MainlineShipmentModel.write(shipments);
  res.json({ updated });
}

async function remove(req, res) {
  const [shipments, shipLegs] = await Promise.all([MainlineShipmentModel.read(), MainlineShipmentLegModel.read()]);
  if (!shipments.some((s) => s.id === req.params.id)) err('Shipment not found', 404);
  await MainlineShipmentModel.write(shipments.filter((s) => s.id !== req.params.id));
  await MainlineShipmentLegModel.write(shipLegs.filter((j) => j.shipment_id !== req.params.id));   // cascade junction
  res.status(204).send();
}

module.exports = { getAll, getOne, getByLeg, update, bulkStatus, remove };
