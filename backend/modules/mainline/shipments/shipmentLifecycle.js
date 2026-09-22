'use strict';

// When a mainline consignment stops being a PLAN, and what that closes.
//
// THE GATE IS "HANDED OVER", NOT "DEPARTED".
// `cargo_received_date` is Received at Port — the forwarder has the cargo. On the
// live rows it lands 0–32 days after the supplier's Cargo Ready date and 8–46 days
// BEFORE the vessel sails (46 on SHP-4), so gating on `etd_pol` alone would leave a
// month-and-a-half window where the goods sit at the port in the carrier's hands
// and the portal still offers Cancel. Received at Port is also the exact analogue
// of SMS's tracking number: the carrier has the box.
//
// ETD and the BL are kept in the predicate as BACKSTOPS, for a row where the
// forwarder recorded the sailing but skipped the handover date. The three are
// monotonic (received ≤ ETD ≤ BL issued, verified on all 8 live consignments), so
// "any of them present" needs no ordering logic.
//
// DELIBERATELY NOT IN THE PREDICATE:
//   • `po_legs.crd` / `bookings.cargo_ready_date` — CRD is the CARGO READY date,
//     a supplier plan that moves earlier and later (Lam, 2026-09-18). It is also
//     VENDOR-EDITABLE while the booking is pending, so gating on it would hand the
//     vendor a switch for opening and closing the guard.
//   • `carrier_reference` — SHP-1 carries one and has no other evidence at all;
//     including it would lock the exact shell row this is meant to let staff clear.
//   • the typed `status` word — it is hand-set (8 of 10 read "Delivered" because a
//     person typed it) and nothing stops setting it back, so a status-only rule is
//     one extra click to bypass. The controller surfaces a DISAGREEMENT between the
//     status and the evidence as a warning instead; see `statusDisagrees`.

const DASH = (d) => String(d).slice(0, 10);

/**
 * Why this consignment counts as handed over — [] means it is still only a plan.
 * Human-readable, because the refusal message quotes it back.
 * @returns {string[]}
 */
function handoverEvidence(shipment = {}) {
  const ev = [];
  if (shipment.cargo_received_date) ev.push(`received at port ${DASH(shipment.cargo_received_date)}`);
  if (shipment.etd_pol)             ev.push(`ETD ${DASH(shipment.etd_pol)}`);
  if (shipment.bl_no)               ev.push(`BL ${shipment.bl_no}`);
  return ev;
}

const isHandedOver = (shipment) => handoverEvidence(shipment).length > 0;

/** The typed status claims it moved but nothing records a handover — warn, don't block. */
const MOVED_STATUSES = new Set(['In Transit', 'At Port', 'Delivered', 'Received']);
const statusDisagrees = (shipment, statusName) =>
  MOVED_STATUSES.has(statusName) && !isHandedOver(shipment);

/** Posted landed-cost rows for this shipment (mainline posts one PER PO). */
const postedCostsFor = (shipmentId, landedCosts = []) =>
  landedCosts.filter((r) => r.module === 'mainline' && String(r.shipment_id) === String(shipmentId));

/** Item Receipts a human CONFIRMED against this shipment. */
const confirmedReceiptsFor = (shipmentId, receipts = []) =>
  receipts.filter((r) => String(r.matched_shipment_id) === String(shipmentId) && r.confirmed_at);

/**
 * Why this consignment may not be CANCELLED. [] = go ahead.
 *
 * Cancel withdraws a plan, so every blocker is a fact that says it is no longer
 * one: the carrier has it, NetSuite says it arrived, or finance has costed it.
 */
function cancelBlockers(shipment, { landedCosts = [], receipts = [] } = {}) {
  const why = [];
  const handover = handoverEvidence(shipment);
  if (handover.length) {
    why.push(`it has already been handed over to the carrier (${handover.join(', ')})`);
  }
  const confirmed = confirmedReceiptsFor(shipment.id, receipts);
  if (confirmed.length) {
    why.push(`NetSuite has ${confirmed.length} confirmed item receipt${confirmed.length === 1 ? '' : 's'} for it`);
  }
  const posted = postedCostsFor(shipment.id, landedCosts);
  if (posted.length) {
    why.push(`its landed cost is posted (${posted.length} PO row${posted.length === 1 ? '' : 's'})`);
  }
  return why;
}

/**
 * Why this consignment may not be DELETED. [] = go ahead.
 *
 * Delete erases the record, so it asks for one thing cancel does not: the
 * consignment must already be CANCELLED. That makes delete impossible as a first
 * click and gives the row a moment where someone said out loud that it is dead.
 * The other two blockers point at records OUTSIDE the portal's ownership, and each
 * names the deliberate reversal that opens the door.
 */
function deleteBlockers(shipment, statusName, { landedCosts = [], receipts = [] } = {}) {
  const why = [];
  if (statusName !== 'Cancelled') {
    why.push(`it is ${statusName || 'not cancelled'} — cancel it first, so deleting is never the first click`);
  }
  const posted = postedCostsFor(shipment.id, landedCosts);
  if (posted.length) {
    why.push('a landed cost has been posted and pushed to NetSuite — unpost it first (Landed Costs page)');
  }
  const confirmed = confirmedReceiptsFor(shipment.id, receipts);
  if (confirmed.length) {
    why.push('a confirmed item receipt is matched to it — unmatch that first');
  }
  return why;
}

module.exports = {
  handoverEvidence,
  isHandedOver,
  statusDisagrees,
  postedCostsFor,
  confirmedReceiptsFor,
  cancelBlockers,
  deleteBlockers,
};
