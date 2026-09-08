'use strict';

// GET /reports/sms — the SMS season KPI report, PO-grained (the full SMS order
// book). Every sms_po appears as ONE row: ordered/shipped/received rollups, a
// mutually-exclusive fulfillment KPI cascade, and HOD timeliness.
//
// SMS has no production schedule to grade against (that's a mainline concept);
// its time anchor is HOD (custbody8) — the handover-by date, the SMS "CRD".
// Timeliness compares the EARLIEST handover-to-courier (shipment.ship_date)
// against HOD; unshipped POs grade On Track / Overdue vs today.
//
// Shipped units are FLOORED AT RECEIVED (see shippedFor) — most of the live order
// book was received in NetSuite without a portal consignment ever being entered,
// and reading the portal record alone reported those seasons as 0% shipped with
// 99% received. `shipped_recorded_qty` keeps the unfloored figure.
//
// Like the mainline report this controller only EMITS rows — the client does the
// season filter, funnel, pivots and donuts. Everything here is derived at
// read-time; nothing is stored.

const M = require('../SmsModels');
const { poRollups } = require('../smsService');

const todayIso = () => new Date().toISOString().slice(0, 10);

// HOD timeliness — ISO date strings compare lexicographically.
//   shipped  → earliest handover on/before HOD = On Time, else Late
//   unshipped→ HOD still ahead = On Track, HOD passed = Overdue
function hodTimeliness(shipped, hod, earliestShip, today) {
  if (shipped > 0) {
    if (!earliestShip || !hod) return 'Unknown';
    return earliestShip <= hod ? 'On Time' : 'Late';
  }
  if (!hod) return 'Unknown';
  return hod < today ? 'Overdue' : 'On Track';
}

// Shipped units for a PO, floored at what actually ARRIVED.
//
// `recorded` is the portal's shipping record (Σ sms_shipment_pos.units, or the
// packed pcs when shipping data was uploaded). 83 of 120 live POs have NetSuite
// Item Receipts and NO portal shipment record at all — they were received before
// anyone entered SMS consignments here, and the NetSuite sync brings in POs and
// IRs, not shipments. Reading `recorded` alone made whole seasons report
// "SHIPPED 0 (0% of ordered)" beside "RECEIVED 99%", with every unit still counted
// as "to ship", and left them stuck in Overdue / out of Fully Shipped entirely.
//
// You cannot receive what was never shipped, so received is a FLOOR. The inferred
// floor is capped at `ordered`: an over-receipt (PO04800 — 352 received against 200
// ordered, receipt noise) must not push shipped above the order and drive
// `remaining_qty` negative. A genuine over-SHIP stays visible, because `recorded`
// itself is never capped (PO04823 ships 125 against 121 ordered and still reads 125).
function shippedFor(ordered, recorded, received) {
  return Math.max(recorded, Math.min(received, ordered));
}

// Mutually-exclusive UNIT split: WHERE this PO's ordered units actually are.
// Always sums to exactly `ordered`, so a pivot over these still reconciles to the
// season's ordered total.
//
// This exists because `kpi_status` answers a different question. It is a PO-level
// state, so a pivot that sums `ordered_qty` by status files a PO's ENTIRE quantity
// under one label: Shanghai Pucci FW27 reported "Partially Shipped 230" when 929 of
// 937 units had arrived and only 8 were outstanding (PO04818 short-shipped 2 SKUs);
// FW26 reported 412 against a real gap of 5. Same shape as the mainline report,
// which splits leg quantity into mutually-exclusive rows for the same reason.
//
// Both ends are capped at `ordered` so an over-receipt (PO04800: 352 received
// against 200 ordered) or an over-ship (PO04823: 125 against 121) can never make a
// supplier's row exceed its own total. The uncapped figures stay on the row as
// shipped_qty / received_qty.
function unitSplit(ordered, shipped, received, hod, today) {
  const units_received   = Math.min(received, ordered);
  const units_in_transit = Math.max(0, Math.min(shipped, ordered) - units_received);
  const rest             = Math.max(0, ordered - units_received - units_in_transit);
  // the not-shipped remainder is graded on HOD, the same anchor hod_timeliness uses
  const units_overdue    = hod && hod < today ? rest : 0;
  return { units_received, units_in_transit, units_overdue, units_to_ship: rest - units_overdue };
}

// The flattened, mutually-exclusive KPI bucket (each PO counted once, so the
// pivots reconcile to the PO total).
//
// NB Received is tested FIRST, so 'Fully Shipped' means "all boxes out, receipts
// not all in yet" — a transient state, not "everything that ever shipped". A fully
// received PO is Received, never Fully Shipped; that is what keeps the buckets
// mutually exclusive and the pivots reconciling.
function kpiStatusFor(ordered, shipped, received, hod, today) {
  if (ordered > 0 && received >= ordered) return 'Received';
  if (ordered > 0 && shipped >= ordered) return 'Fully Shipped';
  if (shipped > 0) return 'Partially Shipped';
  return hod && hod < today ? 'Overdue' : 'Not Shipped';
}

async function getSmsReport(req, res) {
  const [pos, poLines, shipments, shipmentPos, receipts, receiptLines, packingCartons,
         suppliers, seasons, facilities, channels] = await Promise.all([
    M.pos.read(), M.poLines.read(), M.shipments.read(), M.shipmentPos.read(),
    M.receipts.read().catch(() => []), M.receiptLines.read().catch(() => []), M.packingCartons.read().catch(() => []),
    M.suppliers.read().catch(() => []), M.seasons.read(), M.facilities.read(), M.allocationChannels.read().catch(() => []),
  ]);

  const rollups = poRollups({ poLines, shipmentPos, receipts, receiptLines, packingCartons });
  const supName    = new Map(suppliers.map((s) => [s.id, s.name]));
  const seasonCode = new Map(seasons.map((s) => [s.id, s.code]));
  const facName    = new Map(facilities.map((f) => [f.id, f.name]));
  const chanName   = new Map(channels.map((c) => [c.id, c.name]));

  // earliest handover-to-courier per PO (shipment.ship_date across its consignments)
  const shipById = new Map(shipments.map((s) => [s.id, s]));
  const earliestShipByPo = new Map();
  shipmentPos.forEach((j) => {
    const sd = (shipById.get(j.shipment_id) || {}).ship_date;
    if (!sd) return;
    const cur = earliestShipByPo.get(j.po_number);
    if (!cur || sd < cur) earliestShipByPo.set(j.po_number, sd);
  });

  // does a portal shipment record exist at all for this PO? (the junction, not the
  // units — a PO can be on a consignment with 0 units declared)
  const hasShipRecord = new Set(shipmentPos.map((j) => j.po_number));

  const today = todayIso();
  const rows = pos.map((po) => {
    const ordered  = rollups.ordered.get(po.po_number) || 0;
    const recorded = rollups.shipped.get(po.po_number) || 0;
    const received = rollups.received.get(po.po_number) || 0;
    const shipped  = shippedFor(ordered, recorded, received);
    const earliestShip = earliestShipByPo.get(po.po_number) || null;
    const fulfillment = received >= ordered && ordered > 0 ? 'received'
      : shipped >= ordered && ordered > 0 ? 'fully_shipped'
      : shipped > 0 ? 'partially_shipped' : 'not_shipped';
    return {
      po_number:  po.po_number,
      trn_number: po.trn_number || null,
      supplier:   supName.get(po.supplier_id) || null,
      season:     seasonCode.get(po.season_id) || null,
      facility:   facName.get(po.facility_id) || null,
      channel:    chanName.get(po.allocation_channel_id) || null,
      hod:        po.hod || null,
      ship_method: po.ship_method || null,
      ordered_qty:  ordered,
      shipped_qty:  shipped,
      // the portal's own shipping record, unfloored — the two differ exactly on the
      // POs that need a consignment entered, so this is the cleanup worklist
      shipped_recorded_qty: recorded,
      has_shipment_record: hasShipRecord.has(po.po_number),
      received_qty: received,
      remaining_qty: ordered - shipped,
      ...unitSplit(ordered, shipped, received, po.hod, today),
      lot_count:  rollups.lots.get(po.po_number) || 0,
      earliest_ship_date: earliestShip,
      fulfillment,
      // HOD grades the HANDOVER event, which needs a ship_date — so it keys on the
      // RECORDED units, not the floored ones. A PO inferred-shipped from receipts has
      // no handover date to grade, and inventing one from a receipt date would grade
      // the wrong event. Consequence to know: those POs read kpi_status Received with
      // hod_timeliness Overdue — "arrived, but no handover was ever logged" — which
      // is what the data says and is unchanged from before this floor existed.
      hod_timeliness: hodTimeliness(recorded, po.hod, earliestShip, today),
      kpi_status:     kpiStatusFor(ordered, shipped, received, po.hod, today),
    };
  });

  res.json(rows);
}

module.exports = { getSmsReport };
