'use strict';

// Mainline ASN (Advance Shipping Notice) — SHIPMENT-scoped.
//   POST /mainline/shipments/:id/asn → generate the ASN for this shipment (leg)
//   GET  /mainline/shipments/:id/asn → latest ASN for the shipment
//
// An ASN is the receiver's arrival notice for a PHYSICAL shipment, so it lives on
// the shipment, not the booking. Contents are this leg's CI lines; the gate is this
// shipment's own eDel (estimated delivery).
// Reuses the shared asnService.generatePackingList via a leg-scoped legacy shape.

const crypto = require('crypto');
const { models } = require('../../../models');
const { generatePackingList } = require('../../../services/asnService');
const { linesForBooking } = require('../ci/ciLines');
const SupplierModel = models.suppliers;
const { assertShipmentVisible } = require('../vendorAccess');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };

async function generateAsn(req, res) {
  const shipmentId = req.params.id;
  const [shipments, shipLegs, bookings, legs, invoices, cartons, suppliers] = await Promise.all([
    models.mainline_shipments.read(), models.mainline_shipment_legs.read(), models.mainline_bookings.read(),
    models.mainline_po_legs.read(), models.mainline_commercial_invoices.read(), models.mainline_packing_cartons.read(), SupplierModel.read().catch(() => []),
  ]);

  const shipment = shipments.find((s) => s.id === shipmentId);
  if (!shipment) err('Shipment not found', 404);
  if (!shipment.eDel) err('Cannot generate ASN: estimated delivery date (eDel) is missing on this shipment', 400);

  const booking = bookings.find((b) => b.id === shipment.bookingId) || {};
  const ci = invoices.find((i) => i.bookingId === shipment.bookingId);
  if (!ci || ci.status !== 'confirmed') err('Cannot generate ASN: this shipment has no confirmed commercial invoice', 400);
  // CI lines derived from packing cartons for this shipment's booking (not stored)
  const ciLines = linesForBooking(cartons, shipment.bookingId);

  // contents = CI lines for ALL legs physically in this shipment (one arrival notice
  // for the whole consignment, across the legs going to this facility).
  const myJunctions = shipLegs.filter((j) => j.shipmentId === shipmentId);
  const legById = new Map(legs.map((l) => [l.id, l]));
  const myLegIds = new Set(myJunctions.map((j) => j.legId));
  const poByLeg = (legId) => (legById.get(legId) || {}).poNumber || null;
  const legLines = ciLines.filter((l) => l.invoice_id === ci.id && myLegIds.has(l.matched_leg_id));
  if (!legLines.length) err('Cannot generate ASN: no commercial-invoice lines matched to this shipment', 400);

  const supplierName = (suppliers.find((s) => s.id === booking.supplierId) || {}).name || null;
  const legacy = {
    id: booking.id,
    bookingNumber: booking.bookingNumber,
    vendor_name: supplierName,
    po_details: myJunctions.map((j) => ({ poNumber: poByLeg(j.legId), units: j.expectedQuantity })),
    commercial_invoice: {
      status: 'confirmed', invoiceNumber: ci.invoiceNumber,
      line_items: legLines.map((l) => ({ skuCode: l.skuCode, qty: l.qty, weightKg: l.weightKg, cbm: l.cbm, matched_po: poByLeg(l.matched_leg_id) })),
    },
  };
  const fileUrl = await generatePackingList(legacy);

  const record = { id: crypto.randomUUID(), shipmentId: shipmentId, fileUrl, status: 'sent', generatedAt: new Date().toISOString() };
  const asns = await models.mainline_asns.read();
  asns.push(record);
  await models.mainline_asns.write(asns);
  res.status(201).json(record);
}

async function getAsn(req, res) {
  await assertShipmentVisible(req, req.params.id);
  const asns = await models.mainline_asns.read();
  const mine = asns.filter((a) => a.shipmentId === req.params.id);
  if (!mine.length) err('No ASN found for this shipment', 404);
  res.json(mine[mine.length - 1]);
}

module.exports = { generateAsn, getAsn };
