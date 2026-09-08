'use strict';

// Vendor visibility guards for the mainline SUB-RESOURCES — the endpoints that hang
// off a booking or a shipment id (CI, packing, documents, ASN, fulfillment,
// order-intent). Those handlers don't return a list to filter; they return one
// record's detail, so the check is "may this caller see the parent at all?".
//
// Every guard 404s rather than 403s on an out-of-scope id. A 403 distinguishes
// "exists but not yours" from "doesn't exist", which is exactly the oracle a vendor
// would use to enumerate other suppliers' booking numbers, TRNs and shipment ids.
//
// Staff (non-Vendor) resolve to null and pass through untouched.

const MainlineBookingModel = require('./bookings/MainlineBookingModel');
const MainlineShipmentModel = require('./shipments/MainlineShipmentModel');
const PoOrderModel = require('../po/PoOrderModel');
const PoMasterModel = require('../po/PoMasterModel');
const { resolveVendorSupplierId } = require('../../utils/vendorScope');

const notFound = (msg) => { const e = new Error(msg); e.statusCode = 404; throw e; };
const scope = (req) => resolveVendorSupplierId(req.user, { onUnlinked: 'deny' });
const same = (a, b) => String(a) === String(b);

/**
 * 404s unless the caller may see this booking. Bookings carry supplier_id directly.
 * @returns {Promise<string|null>} the resolved vendor supplier id (null for staff)
 */
async function assertBookingVisible(req, bookingId, label = 'Booking not found') {
  const vendorSid = await scope(req);
  if (vendorSid == null) return null;
  const bookings = await MainlineBookingModel.readBookings();
  const b = bookings.find((x) => x.id === bookingId);
  if (!b || !same(b.supplier_id, vendorSid)) notFound(label);
  return vendorSid;
}

/**
 * 404s unless the caller may see this shipment. A shipment inherits its supplier
 * from its booking.
 */
async function assertShipmentVisible(req, shipmentId, label = 'Shipment not found') {
  const vendorSid = await scope(req);
  if (vendorSid == null) return null;
  const [shipments, bookings] = await Promise.all([
    MainlineShipmentModel.read(),
    MainlineBookingModel.readBookings(),
  ]);
  const s = shipments.find((x) => x.id === shipmentId);
  if (!s) notFound(label);
  const b = bookings.find((x) => x.id === s.booking_id);
  if (!b || !same(b.supplier_id, vendorSid)) notFound(label);
  return vendorSid;
}

/**
 * 404s unless the caller may see this PO master (TRN). supplier_id lives on
 * po_masters; a master with a null supplier is never a vendor's.
 */
async function assertTrnVisible(req, trn, label = 'PO master not found') {
  const vendorSid = await scope(req);
  if (vendorSid == null) return null;
  const masters = await PoMasterModel.read();
  const m = masters.find((x) => x.trn_number === trn);
  if (!m || m.supplier_id == null || !same(m.supplier_id, vendorSid)) notFound(label);
  return vendorSid;
}

/** 404s unless the caller may see this component PO (po_number → order → master). */
async function assertPoNumberVisible(req, poNumber, label = 'PO not found') {
  const vendorSid = await scope(req);
  if (vendorSid == null) return null;
  const [orders, masters] = await Promise.all([PoOrderModel.readOrders(), PoMasterModel.read()]);
  const order = orders.find((o) => o.po_number === poNumber);
  const m = order && masters.find((x) => x.trn_number === order.trn_number);
  if (!m || m.supplier_id == null || !same(m.supplier_id, vendorSid)) notFound(label);
  return vendorSid;
}

/** 404s unless the caller may see this leg (leg → order → master). */
async function assertLegVisible(req, legId, label = 'PO leg not found') {
  const vendorSid = await scope(req);
  if (vendorSid == null) return null;
  const MainlineLegModel = require('./legs/MainlineLegModel');
  const [legs, orders, masters] = await Promise.all([
    MainlineLegModel.readLegs(), PoOrderModel.readOrders(), PoMasterModel.read(),
  ]);
  const leg = legs.find((l) => String(l.id) === String(legId));
  const order = leg && orders.find((o) => o.po_number === leg.po_number);
  const m = order && masters.find((x) => x.trn_number === order.trn_number);
  if (!m || m.supplier_id == null || !same(m.supplier_id, vendorSid)) notFound(label);
  return vendorSid;
}

module.exports = {
  assertBookingVisible,
  assertShipmentVisible,
  assertTrnVisible,
  assertPoNumberVisible,
  assertLegVisible,
};
