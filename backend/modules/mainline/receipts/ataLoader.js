'use strict';

// Read-side wrapper around `ataByShipment` for the three REPORT endpoints
// (KPI report, transit times, forecast). mainlineShipmentController already has
// the receipt tables in its own `_ctx`, so it calls the resolver directly; the
// report controllers each loaded a different subset of joins, and without this
// each would need its own copy of the three reads plus the poByLeg map — three
// chances to drift on the pool passed to a COMPETITIVE matcher.
//
// The matcher is competitive (an IR consumed by one consignment is unavailable to
// the next), so `shipments` MUST be the whole mainline_shipments table. That is
// true of every caller today — reports are not vendor-scoped — but pass the
// unfiltered table if that ever changes, or one caller's ATA would disagree with
// another's for the same shipment.
//
// Returns Map(shipment_id → { date, method, confirmed }) — see mainlineReceiptMatch.

const BaseModel = require('../../../models/BaseModel');
const { ataByShipment } = require('./mainlineReceiptMatch');

const readM = (f) => new BaseModel(`migrated/${f}.json`).read().catch(() => []);

async function loadAtaByShipment({ shipments, shipLegs, legs }) {
  const [itemReceipts, itemReceiptLines, rejections] = await Promise.all([
    readM('mainline_item_receipts'),
    readM('mainline_item_receipt_lines'),
    // a human "no" on a suggested (IR × shipment) pair — honoured here too, else a
    // rejected match would still drive the arrival date behind every report
    readM('mainline_receipt_match_rejections'),
  ]);
  return ataByShipment({
    mlShipments: shipments,
    mlShipmentLegs: shipLegs,
    mlReceipts: itemReceipts,
    mlReceiptLines: itemReceiptLines,
    mlRejections: rejections,
    poByLeg: new Map(legs.map((l) => [l.id, l.po_number])),
  });
}

// The one precedence rule for "when did this consignment actually land", shared by
// every consumer: the ATTRIBUTED Item Receipt date wins, the typed header column is
// the fallback (a stopgap from before receipts synced). Same order as
// mainlineShipmentService — two rules for one field is how two screens start
// quoting different arrival dates.
//   ataMatch: the Map above; shipment: a RAW mainline_shipments row
// → { ata, ata_source: 'netsuite' | 'manual' | null }
function effectiveAta(ataMatch, shipment) {
  const irAta = (ataMatch.get(shipment.id) || {}).date || null;
  return {
    ata: irAta || shipment.ata || null,
    ata_source: irAta ? 'netsuite' : (shipment.ata ? 'manual' : null),
  };
}

module.exports = { loadAtaByShipment, effectiveAta };
