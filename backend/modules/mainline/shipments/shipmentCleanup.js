'use strict';

// Everything that has to happen to the rows keyed on a mainline shipment when
// that shipment goes away.
//
// It lives in its own module because there are TWO ways a shipment is deleted —
// DELETE /mainline/shipments/:id, and DELETE /mainline/bookings/:id, which
// removes the booking's shipments as a cascade — and until the Postgres
// migration only the first one cleaned up at all, and only the junction. The
// booking path left ASNs, receipt matches and rejections pointing at shipments
// that no longer existed.
//
// The split between "delete" and "unlink" is the important part:
//
//   mainline_shipment_legs / mainline_asns / mainline_receipt_match_rejections
//       are artifacts OF the shipment. No shipment, no meaning — deleted.
//
//   mainline_item_receipts are NETSUITE's record that goods physically arrived.
//       They outlive any portal row and are never deleted here. Only the
//       portal-owned match is cleared (matchedShipmentId + who confirmed it),
//       because a confirmation pointing at a deleted shipment asserts a link to
//       something that is not there — the same reasoning utils/pruneStaleReceipts
//       applies in the other direction. The receipt goes back to "unmatched" and
//       its consignment stops deriving `Received` until someone re-confirms.
const { models } = require('../../../models');

const ShipmentLegModel           = models.mainline_shipment_legs;
const AsnModel                   = models.mainline_asns;
const ItemReceiptModel           = models.mainline_item_receipts;
const ReceiptMatchRejectionModel = models.mainline_receipt_match_rejections;

/**
 * Detach every row that keys on `shipmentIds`. Does NOT delete the shipments
 * themselves — the caller owns mainline_shipments, since it is also the one
 * deciding which rows survive.
 *
 * Writes only the tables that actually change, so a shipment with no ASN does
 * not rewrite mainline_asns for nothing.
 *
 * @param {Iterable<string>} shipmentIds
 * @returns {Promise<{shipment_legs:number, asns:number, rejections:number, receipts_unlinked:number}>}
 */
async function cascadeShipmentDelete(shipmentIds) {
  const ids = new Set([...shipmentIds].map(String));
  const removed = { shipment_legs: 0, asns: 0, rejections: 0, receipts_unlinked: 0 };
  if (!ids.size) return removed;

  const hit = (v) => v !== null && v !== undefined && ids.has(String(v));

  const [legs, asns, rejections, receipts] = await Promise.all([
    ShipmentLegModel.read(), AsnModel.read(),
    ReceiptMatchRejectionModel.read(), ItemReceiptModel.read(),
  ]);

  const keptLegs = legs.filter((j) => !hit(j.shipmentId));
  removed.shipment_legs = legs.length - keptLegs.length;
  if (removed.shipment_legs) await ShipmentLegModel.write(keptLegs);

  const keptAsns = asns.filter((a) => !hit(a.shipmentId));
  removed.asns = asns.length - keptAsns.length;
  if (removed.asns) await AsnModel.write(keptAsns);

  const keptRejections = rejections.filter((r) => !hit(r.shipmentId));
  removed.rejections = rejections.length - keptRejections.length;
  if (removed.rejections) await ReceiptMatchRejectionModel.write(keptRejections);

  removed.receipts_unlinked = receipts.filter((r) => hit(r.matchedShipmentId)).length;
  if (removed.receipts_unlinked) {
    await ItemReceiptModel.write(receipts.map((r) => (hit(r.matchedShipmentId)
      ? { ...r, matchedShipmentId: null, confirmedBy: null, confirmedAt: null }
      : r)));
  }

  return removed;
}

module.exports = { cascadeShipmentDelete };
