'use strict';

// GET /reports/sms/forecast — incoming-quantity forecast for SMS POs.
//
// Each PO is expected to arrive on its Expected Receive Date (NS duedate, stored
// on sms_pos.expected_received_date). Incoming quantity = ordered − received, i.e.
// the units still to land at the destination facility. The client buckets these
// by ISO week and breaks them down by facility (mirroring the mainline forecast's
// week × warehouse matrix). PO-grained rows are emitted; all aggregation and the
// season filter happen client-side. Derived at read-time; nothing stored.
//
// Forecast date (like mainline projecting unbooked legs onto a projected E-DEL):
// use the Expected Receive Date when it has synced, else fall back to HOD (every
// SMS PO has one) so the projected ordered quantity still lands on the timeline.
// `date_basis` = 'expected' (real NS date) | 'projected' (HOD fallback) so the UI
// can flag projected weeks; incoming qty is projected in BOTH cases.

const M = require('../SmsModels');
const { poRollups } = require('../smsService');

async function getSmsForecast(req, res) {
  const [pos, poLines, shipmentPos, receipts, receiptLines, packingCartons,
         suppliers, seasons, facilities, channels] = await Promise.all([
    M.pos.read(), M.poLines.read(), M.shipmentPos.read(),
    M.receipts.read().catch(() => []), M.receiptLines.read().catch(() => []), M.packingCartons.read().catch(() => []),
    M.suppliers.read().catch(() => []), M.seasons.read(), M.facilities.read(), M.allocationChannels.read().catch(() => []),
  ]);

  const rollups = poRollups({ poLines, shipmentPos, receipts, receiptLines, packingCartons });
  const supName    = new Map(suppliers.map((s) => [s.id, s.name]));
  const seasonCode = new Map(seasons.map((s) => [s.id, s.code]));
  const facName    = new Map(facilities.map((f) => [f.id, f.name]));
  const chanName   = new Map(channels.map((c) => [c.id, c.name]));

  const rows = pos.map((po) => {
    const ordered  = rollups.ordered.get(po.po_number) || 0;
    const received = rollups.received.get(po.po_number) || 0;
    const expected = po.expected_received_date || null;
    const forecastDate = expected || po.hod || null;
    return {
      po_number:  po.po_number,
      supplier:   supName.get(po.supplier_id) || null,
      season:     seasonCode.get(po.season_id) || null,
      facility:   facName.get(po.facility_id) || null,
      channel:    chanName.get(po.allocation_channel_id) || null,
      expected_received_date: expected,
      hod:          po.hod || null,
      forecast_date: forecastDate,                       // expected date, else HOD
      date_basis:   expected ? 'expected' : (po.hod ? 'projected' : null),
      ordered_qty:  ordered,
      received_qty: received,
      incoming_qty: Math.max(0, ordered - received),   // projected units still to arrive
    };
  });

  res.json(rows);
}

module.exports = { getSmsForecast };
