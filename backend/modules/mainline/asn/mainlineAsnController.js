'use strict';

// Mainline ASN (Advance Shipping Notice) — SHIPMENT-scoped.
//   POST /mainline/shipments/:id/asn → generate the ASN for this shipment (leg)
//   GET  /mainline/shipments/:id/asn → latest ASN for the shipment
//
// An ASN is the receiver's arrival notice for a PHYSICAL shipment, so it lives on
// the shipment, not the booking. Contents are this leg's CI lines; the gate is this
// shipment's own e_del (estimated delivery).
// Reuses the shared asnService.generatePackingList via a leg-scoped legacy shape.

const crypto = require('crypto');
const { generatePackingList } = require('../../../services/asnService');
const MainlineAsnModel = require('./MainlineAsnModel');
const MainlineShipmentModel = require('../shipments/MainlineShipmentModel');
const MainlineShipmentLegModel = require('../shipments/MainlineShipmentLegModel');
const MainlineBookingModel = require('../bookings/MainlineBookingModel');
const MainlineLegModel = require('../legs/MainlineLegModel');
const MainlineCiModel = require('../ci/MainlineCiModel');
const MainlinePackingModel = require('../packing/MainlinePackingModel');
const { linesForBooking } = require('../ci/ciLines');
const { suppliers: SupplierModel } = require('../../../models/MasterDataModel');
const { assertShipmentVisible } = require('../vendorAccess');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };

async function generateAsn(req, res) {
  const shipmentId = req.params.id;
  const [shipments, shipLegs, bookings, legs, invoices, cartons, suppliers] = await Promise.all([
    MainlineShipmentModel.read(), MainlineShipmentLegModel.read(), MainlineBookingModel.readBookings(),
    MainlineLegModel.readLegs(), MainlineCiModel.readInvoices(), MainlinePackingModel.read(), SupplierModel.read().catch(() => []),
  ]);

  const shipment = shipments.find((s) => s.id === shipmentId);
  if (!shipment) err('Shipment not found', 404);
  if (!shipment.e_del) err('Cannot generate ASN: estimated delivery date (e_del) is missing on this shipment', 400);

  const booking = bookings.find((b) => b.id === shipment.booking_id) || {};
  const ci = invoices.find((i) => i.booking_id === shipment.booking_id);
  if (!ci || ci.status !== 'confirmed') err('Cannot generate ASN: this shipment has no confirmed commercial invoice', 400);
  // CI lines derived from packing cartons for this shipment's booking (not stored)
  const ciLines = linesForBooking(cartons, shipment.booking_id);

  // contents = CI lines for ALL legs physically in this shipment (one arrival notice
  // for the whole consignment, across the legs going to this facility).
  const myJunctions = shipLegs.filter((j) => j.shipment_id === shipmentId);
  const legById = new Map(legs.map((l) => [l.id, l]));
  const myLegIds = new Set(myJunctions.map((j) => j.leg_id));
  const poByLeg = (legId) => (legById.get(legId) || {}).po_number || null;
  const legLines = ciLines.filter((l) => l.invoice_id === ci.id && myLegIds.has(l.matched_leg_id));
  if (!legLines.length) err('Cannot generate ASN: no commercial-invoice lines matched to this shipment', 400);

  const supplierName = (suppliers.find((s) => s.id === booking.supplier_id) || {}).name || null;
  const legacy = {
    id: booking.id,
    booking_number: booking.booking_number,
    vendor_name: supplierName,
    po_details: myJunctions.map((j) => ({ po_number: poByLeg(j.leg_id), units: j.expected_quantity })),
    commercial_invoice: {
      status: 'confirmed', invoice_number: ci.invoice_number,
      line_items: legLines.map((l) => ({ sku_code: l.sku_code, qty: l.qty, weight_kg: l.weight_kg, cbm: l.cbm, matched_po: poByLeg(l.matched_leg_id) })),
    },
  };
  const file_url = await generatePackingList(legacy);

  const record = { id: crypto.randomUUID(), shipment_id: shipmentId, file_url, status: 'sent', generated_at: new Date().toISOString() };
  const asns = await MainlineAsnModel.read();
  asns.push(record);
  await MainlineAsnModel.write(asns);
  res.status(201).json(record);
}

async function getAsn(req, res) {
  await assertShipmentVisible(req, req.params.id);
  const asns = await MainlineAsnModel.read();
  const mine = asns.filter((a) => a.shipment_id === req.params.id);
  if (!mine.length) err('No ASN found for this shipment', 404);
  res.json(mine[mine.length - 1]);
}

module.exports = { generateAsn, getAsn };
