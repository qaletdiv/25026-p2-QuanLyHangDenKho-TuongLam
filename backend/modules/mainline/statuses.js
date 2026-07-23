'use strict';

// Mainline status vocabulary, categorized (booking vs shipment) per the redesigned
// `statuses` table (module + category + sort_order). Names map to ids in the
// categorized migrated/statuses.json at runtime. Two orthogonal axes: the stored
// PROGRESS status (below) and a derived TIMELINESS status (On Time/At Risk/Late,
// computed from E-DEL vs the production schedule) — see the reports module.
const BaseModel = require('../../models/BaseModel');

const MAINLINE_BOOKING_STATUSES = ['No Booking', 'Booking Pending', 'Booking Approved', 'Cancelled', 'Rejected'];
// PROGRESS pipeline for a physical shipment. "In Transit" is one stored state;
// the UI renders "On Air" / "On the Water" from the shipment's mode.
const MAINLINE_SHIPMENT_STATUSES = ['Ready to Ship', 'In Transit', 'At Port', 'Delivered', 'Received', 'Cancelled'];

let _cache = null;
async function _maps() {
  if (_cache) return _cache;
  const rows = await new BaseModel('migrated/statuses.json').read();
  const nameToId = new Map(rows.map((r) => [r.name, r.id]));
  const idToName = new Map(rows.map((r) => [r.id, r.name]));
  _cache = { nameToId, idToName };
  return _cache;
}

async function idForName(name) { return (await _maps()).nameToId.get(name) || null; }
async function nameForId(id)   { return (await _maps()).idToName.get(id) || null; }

module.exports = { MAINLINE_BOOKING_STATUSES, MAINLINE_SHIPMENT_STATUSES, idForName, nameForId };
