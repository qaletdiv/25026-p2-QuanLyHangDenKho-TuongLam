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
  const [shipLegs, bookingLegs, packingCartons, legs, orders, masters, suppliers, facilities, channels, ports, containerTypes, bookings, modes, seasons, itemReceipts, itemReceiptLines] = await Promise.all([
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
  ]);
  return { shipLegs, bookingLegs, packingCartons, legs, orders, masters, suppliers, facilities, channels, ports, containerTypes, bookings, modes, seasons, itemReceipts, itemReceiptLines };
}

async function _enrich(shipments, ctx) {
  const idToStatusName = new Map();
  await Promise.all(shipments.map(async (s) => idToStatusName.set(s.status_id, await status.nameForId(s.status_id))));
  return enrichShipments(shipments, { ...ctx, idToStatusName });
}

async function getAll(req, res) {
  const [shipments, ctx] = await Promise.all([MainlineShipmentModel.read(), _ctx()]);
  res.json(await _enrich(shipments, ctx));
}

async function getOne(req, res) {
  const [shipments, ctx] = await Promise.all([MainlineShipmentModel.read(), _ctx()]);
  const s = shipments.find((x) => x.id === req.params.id);
  if (!s) err('Shipment not found', 404);
  res.json((await _enrich([s], ctx))[0]);
}

async function update(req, res) {
  const shipments = await MainlineShipmentModel.read();
  const idx = shipments.findIndex((s) => s.id === req.params.id);
  if (idx < 0) err('Shipment not found', 404);
  const next = { ...shipments[idx] };
  if (req.body.status) next.status_id = await status.idForName(req.body.status);
  // Header-level fields = the SHARED logistics facts for the whole physical shipment.
  // Editing them once propagates to every PO leg in the consignment.
  // (expected_quantity + lot_number are per-leg → live on the junction, not here.
  //  `ata` is the actual receipt date — manual now, NetSuite later. Expected ATA is
  //  derived (e_del + 5) and therefore not editable.)
  for (const k of ['etd_pol', 'eta_pod', 'e_del', 'cargo_received_date', 'ata', 'netsuite_id',
                   'bl_no', 'customs_entry_number', 'container_type_id', 'pol_port_id', 'pod_port_id', 'invoice_value', 'duty', 'freight']) {
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

module.exports = { getAll, getOne, update, bulkStatus, remove };
