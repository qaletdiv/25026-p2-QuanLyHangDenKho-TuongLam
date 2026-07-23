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

// The flattened, mutually-exclusive KPI bucket (each PO counted once, so the
// pivots reconcile to the PO total).
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

  const today = todayIso();
  const rows = pos.map((po) => {
    const ordered  = rollups.ordered.get(po.po_number) || 0;
    const shipped  = rollups.shipped.get(po.po_number) || 0;
    const received = rollups.received.get(po.po_number) || 0;
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
      received_qty: received,
      remaining_qty: ordered - shipped,
      lot_count:  rollups.lots.get(po.po_number) || 0,
      earliest_ship_date: earliestShip,
      fulfillment,
      hod_timeliness: hodTimeliness(shipped, po.hod, earliestShip, today),
      kpi_status:     kpiStatusFor(ordered, shipped, received, po.hod, today),
    };
  });

  res.json(rows);
}

module.exports = { getSmsReport };
