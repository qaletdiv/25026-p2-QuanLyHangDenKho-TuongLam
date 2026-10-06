'use strict';
/**
 * NRI ORDER DATA FROM NETSUITE — replaces pasting the "NRI Order data" sheet.
 * Two record types: Item Fulfillments (an order's charges) and Return
 * Authorizations (a return's charges) — both carry the order type + channel.
 *
 * The order data exists for one lookup: an invoice line's `Client Ref 1` (the
 * Item Fulfillment number, IF…) → the order's type and channel. Those ARE NetSuite
 * Item Fulfillments, so they are pulled from NetSuite (READ-ONLY —
 * integrationService.fetchNriItemFulfillments) instead of being pasted, and an
 * invoice upload first makes sure the data covers the invoice's period.
 *
 * Merge rule (into nri_order_master, per entity, keyed on the order number):
 *   - a NetSuite row REPLACES orderType / salesChannel / ref2 / custName /
 *     completed and is marked source 'netsuite' — it is the system of record;
 *   - custCode / country are kept (NetSuite's pull does not carry them);
 *   - a pasted row NetSuite does not return is KEPT (24 ECOM + 4 PREBOOK orders in
 *     the 2026 sheet are not in NetSuite at all) — nothing is ever deleted.
 *
 * New order types are PLACED in Rules → step 1 the moment they first appear, in
 * the column their orders' NetSuite sales channel says ("CA - Ecommerce" → Ecomm,
 * everything else → Wholesale), so a type is never coded by a column the page is
 * not showing. A type already placed is never moved — that is the team's call.
 *
 * How far each entity is synced is kept in _documents ('nri_order_sync').
 */

const { models } = require('../models');
const { txOptions } = require('../../database/txContext');
const store = require('../../database/modelStore');
const ns = require('../services/integrationService');
const svc = require('../services/nriBillingService');

const LOCATION_PREFIX = { CA: 'NRI CA', US: 'NRI US' };
const DOC = 'nri_order_sync';

const norm = (v) => (v === undefined || v === null ? '' : String(v).trim());
const upper = (v) => norm(v).toUpperCase();
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isEcomm = (channel) => /ecommerce|online/i.test(norm(channel));

// ⚠️ readDocument answers an EMPTY ARRAY for a document that does not exist yet.
// Setting log[entity] on that array is silently dropped by JSON.stringify (arrays
// serialise only their indices), which wrote '[]' and lost the sync record.
async function readLog() {
    const d = await store.readDocument(DOC);
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
}

/** What the portal holds for an entity, and how far NetSuite has been pulled. */
async function status(entity) {
    const log = (await readLog())[entity] || null;
    const rows = await models.nri_order_master.findAll({ where: { entity }, raw: true, attributes: ['source', 'completed'], ...txOptions() });
    const fromNs = rows.filter((r) => r.source === 'netsuite');
    const dates = fromNs.map((r) => r.completed).filter(Boolean).sort();
    return {
        entity,
        orders: rows.length,
        fromNetsuite: fromNs.length,
        fromFile: rows.length - fromNs.length,
        // the date the pull is known complete through — not the latest fulfilment,
        // which can sit days earlier simply because nothing shipped since
        syncedThrough: log ? log.through : null,
        lastSync: log ? { at: log.at, by: log.by, from: log.from, to: log.to, fetched: log.fetched, added: log.added, updated: log.updated } : null,
        latestFulfilment: dates[dates.length - 1] || null,
        locationPrefix: LOCATION_PREFIX[entity] || null,
    };
}

/** Place types not yet in any step-1 column, by their orders' majority channel. */
async function placeNewTypes(entity, fetched) {
    const rules = await models.nri_class_rules.findAll({ where: { entity }, raw: true, ...txOptions() });
    const placed = new Set(rules.filter((r) => r.kind === 'orderType').flatMap((r) => (r.conditions[0]?.values || []).map((v) => upper(v))));
    const votes = new Map();
    for (const r of fetched) {
        if (!r.orderType || placed.has(upper(r.orderType))) continue;
        const v = votes.get(r.orderType) || { ecomm: 0, other: 0 };
        const ecomm = r.channelHint ? r.channelHint === 'ecomm' : isEcomm(r.salesChannel);
        if (ecomm) v.ecomm++; else v.other++;
        votes.set(r.orderType, v);
    }
    if (!votes.size) return [];

    const codes = await models.nri_charge_codes.read();
    const classes = new Set(codes.map((c) => (entity === 'CA' ? c.classCa : c.classUs)).filter(Boolean));
    const online = [...classes].find((c) => /online/i.test(c)) || `${entity} - Online`;
    const whsle = [...classes].find((c) => /whsle/i.test(c)) || `${entity} - Whsle`;

    const added = [];
    const byClass = new Map();
    for (const [type, v] of votes) {
        const cls = v.ecomm > v.other ? online : whsle;
        byClass.set(cls, [...(byClass.get(cls) || []), type]);
        added.push({ type, channel: cls === online ? 'Ecomm' : 'Wholesale', orders: v.ecomm + v.other });
    }
    // step 1 is by MONTH, so place the type in the starting rules AND in every month
    // that has its own order-type columns — otherwise it would be coded only in some
    const now = new Date().toISOString();
    const otRules = rules.filter((r) => r.kind === 'orderType' && r.name !== '__empty__');
    const monthsWithOwn = [...new Set([null, ...otRules.map((r) => r.month || null)])];
    for (const month of monthsWithOwn) {
        for (const [cls, types] of byClass) {
            const rule = otRules.find((r) => (r.month || null) === month && r.setClass === cls);
            if (rule) {
                const values = [...new Set([...rule.conditions[0].values, ...types])].sort();
                await models.nri_class_rules.update(
                    { conditions: [{ field: 'orderType', op: 'is', values }], updatedAt: now, updatedBy: 'netsuite order sync' },
                    { where: { id: rule.id }, ...txOptions() },
                );
            } else {
                await models.nri_class_rules.create({
                    id: `ncr_${entity.toLowerCase()}_${month || 'base'}_ot_${cls === online ? 'online' : 'whsle'}_${Date.now()}`,
                    entity, month, seq: 0, kind: 'orderType', enabled: true, setClass: cls,
                    name: `${cls === online ? 'Ecomm' : 'Wholesale'} order types`,
                    conditions: [{ field: 'orderType', op: 'is', values: [...types].sort() }],
                    updatedAt: now, updatedBy: 'netsuite order sync',
                }, txOptions());
            }
        }
    }
    return added;
}

/**
 * Merge NetSuite rows (one record type) into nri_order_master for an entity.
 * Writes inside the caller's transaction. Returns counts.
 */
async function merge(entity, rows, recordType) {
    const all = await models.nri_order_master.read();
    const byKey = new Map(all.map((r) => [`${upper(r.entity || 'US')}|${upper(r.orderNo)}`, r]));
    let added = 0;
    let updated = 0;
    for (const r of rows) {
        if (!norm(r.orderNo)) continue;
        const k = `${entity}|${upper(r.orderNo)}`;
        const cur = byKey.get(k);
        // a value NetSuite does not have never wipes one already held — transfer-
        // order fulfillments carry no order type or channel, and the pasted sheet
        // labelled them (e.g. NRI's "ITEMFULFILLMENT")
        const keep = (v, field) => (v === null || v === undefined || v === '' ? (cur ? cur[field] ?? null : null) : v);
        const next = {
            orderNo: norm(r.orderNo),
            ref2: keep(r.ref2, 'ref2'),
            altRef: keep(r.altRef ? norm(r.altRef) : null, 'altRef'),
            custName: keep(r.custName ? upper(r.custName) : null, 'custName'),
            orderType: keep(r.orderType ? upper(r.orderType) : null, 'orderType'),
            salesChannel: keep(r.salesChannel, 'salesChannel'),
            completed: keep(r.completed, 'completed'),
            recordType,
            source: 'netsuite',
        };
        if (!cur) { byKey.set(k, { entity, custCode: null, country: null, ...next }); added++; continue; }
        if (Object.entries(next).some(([f, v]) => norm(cur[f]) !== norm(v))) { Object.assign(cur, next); updated++; }
    }
    if (added || updated) await models.nri_order_master.write([...byKey.values()]);
    const newTypes = await placeNewTypes(entity, rows.map((r) => ({ ...r, orderType: r.orderType ? upper(r.orderType) : null })));
    return { fetched: rows.length, added, updated, newTypes };
}

const sum = (a, b) => ({
    fetched: a.fetched + b.fetched, added: a.added + b.added, updated: a.updated + b.updated,
    newTypes: [...a.newTypes, ...b.newTypes],
});

/**
 * Pull Item Fulfillments AND Return Authorizations dated [from, to] at the entity's
 * locations, and merge them. Writes inside the caller's transaction.
 */
async function sync({ entity, from, to, by = null }) {
    const prefix = LOCATION_PREFIX[entity];
    if (!prefix) throw Object.assign(new Error(`No NetSuite locations are mapped for ${entity}.`), { status: 400 });
    const t0 = Date.now();
    const { locations, rows } = await ns.fetchNriItemFulfillments({ locationPrefix: prefix, from, to });
    const fulfilments = await merge(entity, rows, 'ItemShip');
    const ras = await ns.fetchNriReturnAuthorizations({ locationPrefix: prefix, from, to });
    const returns = await merge(entity, ras, 'RtnAuth');
    const total = sum(fulfilments, returns);

    const log = await readLog();
    const prev = log[entity];
    // `through` only advances over a CONTIGUOUS range — a pull of a later month
    // that skips a gap must not claim the gap is covered
    const through = prev && prev.through && from <= addDays(prev.through, 1)
        ? (to > prev.through ? to : prev.through)
        : to;
    log[entity] = { ...(prev || {}), through, from, to, at: new Date().toISOString(), by, fetched: total.fetched, added: total.added, updated: total.updated };
    await store.writeDocument(DOC, log);

    return {
        entity, from, to, locations: locations.map((l) => l.name),
        ...total,
        fulfilments: { fetched: fulfilments.fetched, added: fulfilments.added, updated: fulfilments.updated },
        returns: { fetched: returns.fetched, added: returns.added, updated: returns.updated },
        syncedThrough: through, seconds: Math.round((Date.now() - t0) / 100) / 10,
    };
}

/**
 * Which NetSuite record a Client Ref 1 names, by its shape (Lam, 2026-10-02):
 *   RMA92505 / "RMA #K0Z3WP82"  → Return Authorization (number / external ref)
 *   IF4041483465                → Item Fulfillment
 *   CA987809 / #CA987809        → Sales Order, by its web order # (otherrefnum)
 *   PO04728                     → Purchase Order — channel from its location
 * Anything else (cycle counts, "Overtime billing", GoBolt TO# …) names no record;
 * Exceptions and the service columns decide those.
 */
function refKind(entity, ref) {
    const r = norm(ref);
    if (/^RMA\d+$/i.test(r)) return 'raTranid';
    if (/^RMA\s*#/i.test(r)) return 'raOtherRef';
    if (/^IF\d+$/i.test(r)) return 'ifTranid';
    if (/^[A-Z]{2}$/.test(entity) && new RegExp(`^#?${entity}\\d+$`, 'i').test(r)) return 'soOtherRef';
    if (/^PO\d+$/i.test(r)) return 'poTranid';
    return null;
}

/**
 * Fetch the records these invoice lines QUOTE but the portal does not hold yet —
 * by Client Ref 2 (a Return Authorization's id) and by the shape of Client Ref 1
 * (refKind). A return is often billed months after its RA, and an order type can
 * hang on a sales order or PO no date-ranged pull covers. Only lines that do not
 * already resolve are looked up; READ-ONLY on NetSuite.
 *
 * @param {object[]} lines  invoice lines ({ clientRef1, clientRef2 })
 */
async function resolveRefs({ entity, lines }) {
    const none = { fetched: 0, added: 0, updated: 0, newTypes: [], asked: 0, byKind: {} };
    if (!LOCATION_PREFIX[entity] || !lines.length) return none;
    const held = await models.nri_order_master.findAll({ where: { entity }, raw: true, ...txOptions() });
    const idx = lookupIndex(held);
    const want = { raId: new Set(), raTranid: new Set(), raOtherRef: new Set(), ifTranid: new Set(), soOtherRef: new Set(), poTranid: new Set() };
    for (const l of lines) {
        if (lookup(idx, l)) continue;
        const r1 = norm(l.clientRef1);
        const r2 = norm(l.clientRef2);
        if (/^\d+$/.test(r2)) want.raId.add(r2);
        const kind = refKind(entity, r1);
        if (kind) want[kind].add(kind === 'raOtherRef' ? r1 : r1.toUpperCase());
    }
    const asked = Object.values(want).reduce((n, v) => n + v.size, 0);
    if (!asked) return none;

    const parts = [];
    if (want.raId.size || want.raTranid.size || want.raOtherRef.size) {
        const rows = await ns.fetchNriReturnAuthorizations({ ids: [...want.raId], tranids: [...want.raTranid], otherRefs: [...want.raOtherRef] });
        parts.push(['returns', await merge(entity, rows, 'RtnAuth')]);
    }
    if (want.ifTranid.size || want.soOtherRef.size || want.poTranid.size) {
        const got = await ns.fetchNriReferencedRecords({ ifTranids: [...want.ifTranid], soOtherRefs: [...want.soOtherRef], poTranids: [...want.poTranid] });
        if (got.itemShip.length) parts.push(['fulfilments', await merge(entity, got.itemShip, 'ItemShip')]);
        if (got.salesOrd.length) parts.push(['salesOrders', await merge(entity, got.salesOrd, 'SalesOrd')]);
        if (got.purchOrd.length) parts.push(['purchaseOrders', await merge(entity, got.purchOrd, 'PurchOrd')]);
    }
    const total = parts.reduce((a, [, p]) => sum(a, p), { fetched: 0, added: 0, updated: 0, newTypes: [] });
    return {
        ...total, asked,
        asks: Object.fromEntries(Object.entries(want).map(([k, v]) => [k, v.size]).filter(([, n]) => n)),
        byKind: Object.fromEntries(parts.map(([k, p]) => [k, { fetched: p.fetched, added: p.added, updated: p.updated }])),
    };
}

/** The coder's lookup (nriBillingService) — one rule for "resolved", used to decide what to fetch. */
const lookupIndex = (rows) => svc.orderTypeIndex(rows);
const lookup = (idx, l) => {
    const type = svc.orderTypeLookup(idx, l);
    return type === undefined ? null : { type };
};

/**
 * Make sure the entity's order data covers `through` (an invoice's period end) and
 * every Return Authorization the invoice's `lines` quote. Pulls from a week before
 * the last covered date (late-posted records) — or 1 January on the first run — to
 * today; then resolves any references still missing. A no-op when already current.
 */
async function ensureCurrent({ entity, through, lines = [], by = null }) {
    if (!LOCATION_PREFIX[entity] || !through) return { ran: false, reason: 'nothing to check' };
    const s = await status(entity);
    let result = { ran: false, syncedThrough: s.syncedThrough };
    if (!s.syncedThrough || s.syncedThrough < through) {
        const from = s.syncedThrough ? addDays(s.syncedThrough, -7) : `${through.slice(0, 4)}-01-01`;
        const to = today() > through ? today() : through;
        result = { ran: true, ...(await sync({ entity, from, to, by })) };
    }
    const refs = await resolveRefs({ entity, lines });
    if (refs.asked) result.refsResolved = { asked: refs.asked, asks: refs.asks, fetched: refs.fetched, added: refs.added, byKind: refs.byKind, newTypes: refs.newTypes };
    return result;
}

module.exports = { LOCATION_PREFIX, status, sync, refKind, resolveRefs, ensureCurrent, lookupIndex, lookup };
