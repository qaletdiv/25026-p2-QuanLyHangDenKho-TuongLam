const { suppliers, couriers, incoterms, statuses, warehouses, modes } = require('../models/MasterDataModel');
const BaseModel = require('../models/BaseModel');

// Normalized destination master data (mainline module). Read-only for now — the
// migration / ingestion own these files. warehouse_facilities = physical destinations
// (NRI US, NRI CA, …); allocation_channels = internal buckets (Reserved/First).
const warehouseFacilities = new BaseModel('migrated/warehouse_facilities.json');
const allocationChannels  = new BaseModel('migrated/allocation_channels.json');
const ports               = new BaseModel('migrated/ports.json');
const containerTypes      = new BaseModel('migrated/container_types.json');
// Per-season production schedule — the On Time / At Risk / Late gates for reports.
// One row per season: { season_id, ontime_by, atrisk_by }. Editable master data —
// the team sets the cutoffs each season (like suppliers/couriers).
const productionSchedules = new BaseModel('migrated/production_schedules.json');
const seasonsModel        = new BaseModel('migrated/seasons.json');

async function getSuppliers(req, res) {
    res.json(await suppliers.read().catch(() => []));
}
async function putSuppliers(req, res) {
    await suppliers.write(req.body);
    res.json({ success: true });
}

async function getCouriers(req, res) {
    res.json(await couriers.read().catch(() => []));
}
async function putCouriers(req, res) {
    await couriers.write(req.body);
    res.json({ success: true });
}

async function getIncoterms(req, res) {
    res.json(await incoterms.read().catch(() => []));
}
async function putIncoterms(req, res) {
    await incoterms.write(req.body);
    res.json({ success: true });
}

async function getStatuses(req, res) {
    res.json(await statuses.read().catch(() => []));
}
async function putStatuses(req, res) {
    await statuses.write(req.body);
    res.json({ success: true });
}

async function getWarehouses(req, res) {
    res.json(await warehouses.read().catch(() => []));
}
async function putWarehouses(req, res) {
    await warehouses.write(req.body);
    res.json({ success: true });
}

async function getModes(req, res) {
    res.json(await modes.read().catch(() => []));
}
async function putModes(req, res) {
    await modes.write(req.body);
    res.json({ success: true });
}

async function getWarehouseFacilities(req, res) {
    res.json(await warehouseFacilities.read().catch(() => []));
}
async function getAllocationChannels(req, res) {
    res.json(await allocationChannels.read().catch(() => []));
}
async function getPorts(req, res) {
    res.json(await ports.read().catch(() => []));
}
async function getContainerTypes(req, res) {
    res.json(await containerTypes.read().catch(() => []));
}
// One row per season (left-joined onto seasons so a NEW season from PO/WIP sync
// automatically appears with empty cutoffs, ready to be set). `season` (the code,
// e.g. FW26) is display-only enrichment — never stored back (3NF).
async function getProductionSchedules(req, res) {
    const [rows, seasons] = await Promise.all([
        productionSchedules.read().catch(() => []),
        seasonsModel.read().catch(() => []),
    ]);
    const byId = new Map(rows.map((r) => [r.season_id, r]));
    res.json(seasons.map((s) => ({
        season_id: s.id,
        season:    s.code || s.id,
        ontime_by: (byId.get(s.id) || {}).ontime_by || null,
        atrisk_by: (byId.get(s.id) || {}).atrisk_by || null,
    })));
}
// Production pre-loads next season here (before any PO exists for it). The row
// goes into the SEASONS table — the schedule stays keyed on season_id (3NF).
// Ingestion resolvers match seasons by code, so a season created here is found
// (not duplicated) when its first WIP/NetSuite sync arrives.
async function postSeason(req, res) {
    const code = String(req.body.code || '').trim();
    const seasons = await seasonsModel.read().catch(() => []);
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (seasons.some((s) => norm(s.code) === norm(code))) {
        return res.status(400).json({ success: false, error: `Season '${code}' already exists` });
    }
    const season = { id: `season_${norm(code).replace(/[^a-z0-9]+/g, '_')}`, code };
    if (seasons.some((s) => s.id === season.id)) {
        return res.status(400).json({ success: false, error: `Season id '${season.id}' already exists` });
    }
    seasons.push(season);
    await seasonsModel.write(seasons);
    res.status(201).json(season);
}
async function putProductionSchedules(req, res) {
    const seasons = await seasonsModel.read().catch(() => []);
    const seasonIds = new Set(seasons.map((s) => s.id));
    const rows = [];
    for (const r of req.body) {
        if (!seasonIds.has(r.season_id)) {
            return res.status(400).json({ success: false, error: `Unknown season_id '${r.season_id}'` });
        }
        if (r.ontime_by && r.atrisk_by && r.atrisk_by < r.ontime_by) {
            return res.status(400).json({ success: false, error: `At Risk cutoff (${r.atrisk_by}) cannot be before On Time cutoff (${r.ontime_by})` });
        }
        // store only the facts — the season code lives in seasons (3NF)
        rows.push({ season_id: r.season_id, ontime_by: r.ontime_by || null, atrisk_by: r.atrisk_by || null });
    }
    await productionSchedules.write(rows);
    res.json({ success: true });
}

module.exports = {
    getSuppliers, putSuppliers,
    getCouriers,  putCouriers,
    getIncoterms, putIncoterms,
    getStatuses,  putStatuses,
    getWarehouses, putWarehouses,
    getModes,      putModes,
    getWarehouseFacilities, getAllocationChannels,
    getPorts, getContainerTypes,
    getProductionSchedules, putProductionSchedules, postSeason
};
