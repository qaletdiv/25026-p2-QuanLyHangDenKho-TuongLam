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

// MODULE-SCOPED, and that is the whole point. `statuses` is shared reference data
// carrying a `module` column, and SIX names exist in both modules: Booking Pending,
// Booking Approved, Rejected, In Transit, Delivered, Cancelled. Building nameToId
// over ALL rows keyed on name alone let the later (SMS) row win, so every mainline
// write through idForName() stamped an SMS status id onto a mainline record —
// all 7 mainline_shipments held `sms_delivered` instead of `sh_delivered`, and two
// bookings held `sms_bk_approved` (backfilled by scripts/fix-mainline-status-ids.js,
// 2026-08-12).
//
// It hid for so long because idToName mapped both ids back to the SAME display
// name, so the UI read correctly and name-based logic (the Active/Done sets) kept
// working — only id-level and module-level logic broke. Filtering BOTH maps to
// mainline is deliberate: a foreign id now resolves to null and shows up, instead
// of silently rendering the right word for the wrong row.
//
// Names are unique WITHIN mainline (10 rows, 10 names; `Cancelled` is category
// 'both' and serves booking + shipment), so the module filter fully disambiguates.
const MODULE = 'mainline';

let _cache = null;
async function _maps() {
  if (_cache) return _cache;
  const all = await new BaseModel('migrated/statuses.json').read();
  const rows = (Array.isArray(all) ? all : []).filter((r) => r.module === MODULE);
  const nameToId = new Map(rows.map((r) => [r.name, r.id]));
  const idToName = new Map(rows.map((r) => [r.id, r.name]));
  _cache = { nameToId, idToName };
  return _cache;
}

async function idForName(name) { return (await _maps()).nameToId.get(name) || null; }
async function nameForId(id)   { return (await _maps()).idToName.get(id) || null; }

module.exports = { MAINLINE_BOOKING_STATUSES, MAINLINE_SHIPMENT_STATUSES, idForName, nameForId };
