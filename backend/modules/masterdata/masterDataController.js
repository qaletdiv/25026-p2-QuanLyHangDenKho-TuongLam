const { models } = require('../../models');
const suppliers = models.suppliers;
const couriers = models.couriers;
const incoterms = models.incoterms;
const statuses = models.legacy_statuses;
const warehouses = models.warehouses;
const modes = models.modes;
const { supplierKey } = require('../../utils/nameKey');

// Normalized destination master data (mainline module). Read-only for now — the
// migration / ingestion own these files. warehouse_facilities = physical destinations
// (NRI US, NRI CA, …); allocation_channels = internal buckets (Reserved/First).
const warehouseFacilities = models.warehouse_facilities;
const allocationChannels  = models.allocation_channels;
// One row ('default'): the CI's Notify Party — see putNotifyParty.
const notifyParty         = models.notify_party;
const ports               = models.ports;
const containerTypes      = models.container_types;
// Per-season production schedule — the On Time / At Risk / Late gates for reports.
// One row per season: { seasonId, ontimeBy, atriskBy }. Editable master data —
// the team sets the cutoffs each season (like suppliers/couriers).
const productionSchedules = models.production_schedules;
const seasonsModel        = models.seasons;

async function getSuppliers(req, res) {
    res.json(await suppliers.read().catch(() => []));
}
// suppliers.name is declared `unique` in database.dbml but the JSON stack can't
// enforce it, so the check lives here — otherwise nothing stops a second row for a
// vendor that already exists (which is how six punctuation-variant duplicates got
// in via the SMS NetSuite sync; merged 2026-08-12). Compared on supplierKey, so
// "Best Star Fashions Co Ltd" and "Best Star Fashions Co., Ltd." collide. The key
// is computed here and never stored — it is derived from `name`.
async function putSuppliers(req, res) {
    const seen = new Map();
    for (const row of Array.isArray(req.body) ? req.body : []) {
        const key = supplierKey(row && row.name);
        if (!key) continue;                       // blank rows are the "Add" placeholder
        if (seen.has(key)) {
            return res.status(400).json({
                success: false,
                error: `Duplicate supplier: "${row.name}" is the same as "${seen.get(key)}".`,
            });
        }
        seen.set(key, row.name);
    }
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
// The destination's DOCUMENT fields — consignee address, port of discharge and
// notify party are what ciGenerator/plGenerator print (the legacy `warehouses`
// table is not read by either, which is why those cells came out blank).
//
// EDIT ONLY: a facility is a FK target for po_orders, sms_pos, sms_shipments and
// mainline_shipments, and rows here are created by the migration / PO ingestion.
// BaseModel.write replaces the whole table, so an id missing from the body would
// delete a destination that live records point at — refused rather than left to
// fail as a deferred FK violation at COMMIT. Fields outside EDITABLE are carried
// over from the stored row, so a stale client cannot blank one it never showed.
const FACILITY_EDITABLE = ['name', 'country', 'city', 'address', 'portOfDischarge'];

async function putWarehouseFacilities(req, res) {
    const current = await warehouseFacilities.read().catch(() => []);
    const incoming = (Array.isArray(req.body) ? req.body : []).filter((f) => f && f.id);
    const sent = new Set(incoming.map((f) => f.id));
    if (sent.size !== incoming.length) {
        return res.status(400).json({ success: false, error: 'Duplicate destination id in request' });
    }
    const missing = current.filter((f) => !sent.has(f.id)).map((f) => f.name || f.id);
    const unknown = incoming.filter((f) => !current.some((c) => c.id === f.id)).map((f) => f.name || f.id);
    if (missing.length || unknown.length) {
        return res.status(400).json({
            success: false,
            error: 'Destinations cannot be added or removed here — they are created by the PO ingestion. '
                + `Only their address, ports and notify party are editable. (${
                    [missing.length ? `missing: ${missing.join(', ')}` : '',
                        unknown.length ? `unknown: ${unknown.join(', ')}` : ''].filter(Boolean).join('; ')})`,
        });
    }
    const byId = new Map(incoming.map((f) => [f.id, f]));
    await warehouseFacilities.write(current.map((f) => {
        const patch = byId.get(f.id) || {};
        const next = { ...f };
        FACILITY_EDITABLE.forEach((k) => { if (k in patch) next[k] = patch[k]; });
        return next;
    }));
    res.json({ success: true });
}
// NOTIFY PARTY — a SINGLETON. It is always tentree, whatever the destination,
// supplier or module, so it is one row rather than a column repeated on each
// facility (which would have been five copies of one fact). The PUT takes the
// same array shape as every other master-data screen and keeps the first row.
async function getNotifyParty(req, res) {
    res.json(await notifyParty.read().catch(() => []));
}
async function putNotifyParty(req, res) {
    const row = (Array.isArray(req.body) ? req.body : [])[0];
    if (!row) return res.status(400).json({ success: false, error: 'Notify party is required' });
    await notifyParty.write([{ id: 'default', name: row.name, address: row.address || '' }]);
    res.json({ success: true });
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
    const byId = new Map(rows.map((r) => [r.seasonId, r]));
    res.json(seasons.map((s) => ({
        seasonId: s.id,
        season:    s.code || s.id,
        ontimeBy: (byId.get(s.id) || {}).ontimeBy || null,
        atriskBy: (byId.get(s.id) || {}).atriskBy || null,
    })));
}
// Production pre-loads next season here (before any PO exists for it). The row
// goes into the SEASONS table — the schedule stays keyed on seasonId (3NF).
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
        if (!seasonIds.has(r.seasonId)) {
            return res.status(400).json({ success: false, error: `Unknown seasonId '${r.seasonId}'` });
        }
        if (r.ontimeBy && r.atriskBy && r.atriskBy < r.ontimeBy) {
            return res.status(400).json({ success: false, error: `At Risk cutoff (${r.atriskBy}) cannot be before On Time cutoff (${r.ontimeBy})` });
        }
        // store only the facts — the season code lives in seasons (3NF)
        rows.push({ seasonId: r.seasonId, ontimeBy: r.ontimeBy || null, atriskBy: r.atriskBy || null });
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
    getWarehouseFacilities, putWarehouseFacilities,
    getNotifyParty, putNotifyParty, getAllocationChannels,
    getPorts, getContainerTypes,
    getProductionSchedules, putProductionSchedules, postSeason
};
