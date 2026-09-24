'use strict';

// Master-data name → id resolvers, shared by both ingestion paths.
// Read-only: if a name doesn't resolve, the caller records a warning (mirrors the
// migration script). New-season creation is a deliberate non-goal for Phase 2.
const { models } = require('../../models');
const { splitWarehouseName, channelIdByName } = require('./warehouseFacility');

const { norm, supplierKey } = require('../../utils/nameKey');

const makeMap = (rows, key, keyFn = norm) => {
  const m = new Map();
  (Array.isArray(rows) ? rows : []).forEach((r) => { if (r && r[key] != null) m.set(keyFn(r[key]), r.id); });
  return m;
};

async function loadResolvers() {
  const [sup, wh, modes, inco, seasons, facilities] = await Promise.all([
    models.suppliers.read(),
    models.warehouses.read(),
    models.modes.read(),
    models.incoterms.read(),
    models.seasons.read(),
    models.warehouse_facilities.read(),
  ]);
  // Suppliers key on supplierKey so a WIP sheet spelling ("Best Star Fashions Co Ltd")
  // resolves to the master row however NetSuite punctuates it ("…Co., Ltd."). Before
  // the 2026-08-12 dedupe both spellings existed as separate rows and each path found
  // "its own"; now there is one row per vendor and the lookup has to bridge the gap.
  const supplier  = makeMap(sup, 'name', supplierKey);
  const warehouse = makeMap(wh, 'name');
  const mode      = makeMap(modes, 'name');
  const incoterm  = makeMap(inco, 'name');
  const season    = makeMap(seasons, 'code');
  const facility  = makeMap(facilities, 'name');

  const warnings = [];
  const lookup = (map, kind, keyFn = norm) => (val, ctx) => {
    if (val == null || val === '') return null;
    const id = map.get(keyFn(val));
    if (id == null) warnings.push(`unresolved ${kind} "${val}"${ctx ? ' @ ' + ctx : ''}`);
    return id ?? null;
  };

  // Decompose a conflated warehouse name ("NRI US Reserved") into a physical
  // facilityId + an internal allocationChannelId. Used by both ingestion paths
  // when writing po_orders. See modules/po/warehouseFacility.js.
  const facilityChannel = (name, ctx) => {
    if (name == null || name === '') return { facilityId: null, allocationChannelId: null };
    const { facilityName, channelName } = splitWarehouseName(name);
    const facilityId = facilityName ? (facility.get(norm(facilityName)) || null) : null;
    if (!facilityId) warnings.push(`unresolved facility "${name}"${ctx ? ' @ ' + ctx : ''}`);
    return { facilityId, allocationChannelId: channelName ? (channelIdByName.get(norm(channelName)) || null) : null };
  };

  return {
    supplierId:  lookup(supplier, 'supplier', supplierKey),
    warehouseId: lookup(warehouse, 'warehouse'),
    modeId:      lookup(mode, 'mode'),
    incotermId:  lookup(incoterm, 'incoterm'),
    seasonId:    lookup(season, 'season'),
    facilityChannel,
    warnings,
  };
}

module.exports = { loadResolvers, norm };
