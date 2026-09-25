'use strict';

// Warehouse → (facility, allocation channel) decomposition.
// ---------------------------------------------------------------------------
// The legacy `warehouses` master conflates TWO independent facts in one row:
//   "NRI US Reserved" = physical FACILITY ("NRI US") + allocation CHANNEL ("Reserved").
// The freight forwarder only cares about the physical destination (NRI US / NRI CA /
// Direct US / Direct CAN); Reserved/First is an internal inventory bucket.
//
// This module is the single source of truth for that split, shared by the migration
// (build-time) and the ingestion resolvers (runtime NS sync / WIP import) so both
// agree on facility ids and channel ids. See backend/database.dbml.

const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase().replace(/\s+/g, ' '));
const slug = (s) => 'fac_' + norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// Fixed allocation-channel vocabulary (orthogonal to physical destination).
const CHANNELS = [
  { id: 'ch_reserved', name: 'Reserved' },
  { id: 'ch_first',    name: 'First' },
];
const channelIdByName = new Map(CHANNELS.map((c) => [norm(c.name), c.id]));

// "NRI US Reserved"         → { facilityName: 'NRI US', channelName: 'Reserved' }
// "NRI CA First Inventory"  → { facilityName: 'NRI CA', channelName: 'First' }
// "Direct US"               → { facilityName: 'Direct US', channelName: null }
//
// ⚠️ The trailing " Inventory" is OPTIONAL and must stay that way. NetSuite
// names the First-channel locations "NRI CA First Inventory" / "NRI US First
// Inventory", and with the channel word anchored strictly at the end the whole
// string fell through as a facility name. That resolved to `fac_nri_ca_first_
// inventory`, which does not exist, so 14 POs synced with facilityId = null.
//
// Inventing that facility would have been the WRONG fix: it splits NRI CA's
// destination in two, breaks the (booking, facility, mode) shipment grain and
// the G3 same-consignment guard, and contradicts this module's whole purpose —
// "NRI CA First Inventory" is the First CHANNEL at the NRI CA FACILITY, and
// both of those already exist.
function splitWarehouseName(name) {
  if (name == null || name === '') return { facilityName: null, channelName: null };
  const m = String(name).trim().match(/^(.*\S)\s+(Reserved|First)(?:\s+Inventory)?$/i);
  if (m) {
    const ch = CHANNELS.find((c) => norm(c.name) === norm(m[2]));
    return { facilityName: m[1].trim(), channelName: ch ? ch.name : null };
  }
  return { facilityName: String(name).trim(), channelName: null };
}

// Build the normalized facility list + a legacy-warehouse-id → {facilityId,
// allocationChannelId} map from the legacy warehouses[] rows. Facility metadata
// (country/city/port) is carried over from the first legacy row of each facility.
function deriveFromWarehouses(warehouses) {
  const facById = new Map();
  const legacyMap = new Map();
  (Array.isArray(warehouses) ? warehouses : []).forEach((w) => {
    const { facilityName, channelName } = splitWarehouseName(w.name);
    if (!facilityName) return;
    const fid = slug(facilityName);
    if (!facById.has(fid)) {
      facById.set(fid, {
        id: fid,
        name: facilityName,
        country: w.country || null,
        city: w.city || null,
        portOfDischarge: w.portOfDischarge || '',
        address: w.address || '',
      });
    }
    legacyMap.set(w.id, {
      facilityId: fid,
      allocationChannelId: channelName ? channelIdByName.get(norm(channelName)) || null : null,
    });
  });
  return { facilities: [...facById.values()], channels: CHANNELS, legacyMap };
}

module.exports = { norm, slug, CHANNELS, channelIdByName, splitWarehouseName, deriveFromWarehouses };
