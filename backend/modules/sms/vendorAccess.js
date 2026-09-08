'use strict';

// Vendor visibility for the SMS read path. Kept separate from the mainline guard
// (modules/mainline/vendorAccess.js) — the two modules share no transactional
// tables, and only the pure resolver in utils/vendorScope is common.
//
// SMS has no supplier column on the shipment: a consignment's supplier comes from
// its POs via the sms_shipment_pos junction (sms_pos.supplier_id).
//
// TWO DELIBERATE EDGE CASES:
//
// 1. ALL POs must belong to the vendor, not ANY. A cross-supplier consignment would
//    otherwise expose supplier B's PO lines to supplier A through the shipment
//    detail. There are ZERO such consignments today (verified across all 35
//    shipments), so `every` costs nothing and fails closed if one ever appears.
//    This matches the existing `_assertVendorOwns` in smsBookingController.
//
// 2. A shipment with NO junction rows is NOT visible to a vendor. `every` on an
//    empty array is `true`, which would make every untracked draft — the ones
//    booking-approve creates before a box ships — readable by ANY vendor. The
//    explicit length check closes that.

const M = require('./SmsModels');
const { resolveVendorSupplierId } = require('../../utils/vendorScope');

const notFound = (msg) => { const e = new Error(msg); e.statusCode = 404; throw e; };
const scope = (req) => resolveVendorSupplierId(req.user, { onUnlinked: 'deny' });

/**
 * Build a predicate: is this SMS shipment visible to the given vendor?
 * @param {Array} shipmentPos  sms_shipment_pos rows
 * @param {Map|Object} poSupplierByNumber  po_number → supplier_id
 * @param {string|null} vendorSupplierId   null = staff, everything visible
 */
function shipmentVisibilityFn(shipmentPos, poSupplierByNumber, vendorSupplierId) {
  if (vendorSupplierId == null) return () => true;
  const mine = String(vendorSupplierId);
  const get = (po) => (poSupplierByNumber instanceof Map
    ? poSupplierByNumber.get(po)
    : (poSupplierByNumber[po] || {}).supplier_id);
  const byShipment = shipmentPos.reduce((m, j) => {
    (m[j.shipment_id] = m[j.shipment_id] || []).push(j.po_number);
    return m;
  }, {});
  return (shipmentId) => {
    const pos = byShipment[shipmentId] || [];
    if (!pos.length) return false;                                  // untracked draft — staff only
    return pos.every((po) => String(get(po)) === mine);             // no cross-supplier leak
  };
}

/** Resolve the caller's vendor scope (null for staff). */
const vendorScopeFor = (req) => scope(req);

/**
 * 404s unless the caller may see this SMS shipment. Reads the junction + POs itself
 * so callers that don't already hold them stay simple.
 */
async function assertShipmentVisible(req, shipmentId, label = 'SMS shipment not found') {
  const vendorSid = await scope(req);
  if (vendorSid == null) return null;
  const [shipments, shipmentPos, pos] = await Promise.all([
    M.shipments.read(), M.shipmentPos.read(), M.pos.read(),
  ]);
  if (!shipments.some((s) => s.id === shipmentId)) notFound(label);
  const supplierOf = new Map(pos.map((p) => [p.po_number, p.supplier_id]));
  const visible = shipmentVisibilityFn(shipmentPos, supplierOf, vendorSid);
  if (!visible(shipmentId)) notFound(label);                        // 404, never 403
  return vendorSid;
}

module.exports = { shipmentVisibilityFn, assertShipmentVisible, vendorScopeFor };
