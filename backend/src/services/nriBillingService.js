'use strict';
/**
 * NRI billing — the `NRI CA_ALL Invoices 2026.xlsx` workbook, as code. PURE: no
 * req/res, no database. The controller loads the rows and hands them in.
 *
 * Workbook → code:
 *
 *   Power Query merge Service ⟕ "NRI Invoice Coding"
 *       → Netsuite GL, Description, Class (NRI CAN)      legendIndex() + codeLine()
 *   Revised Class   = IF(ISBLANK(Manual Class Override), Class (NRI CAN), override)
 *   Revised GL Code = IF(ISBLANK(Manual GL Override), Netsuite GL, override)
 *   Revised GL Desc = override ? XLOOKUP(override, Coding[GL], Coding[Description])
 *                              : Description
 *   MMM-YYYY        = TEXT(Completed, "mmm-yyyy")
 *   Order Type      = VLOOKUP(Client Ref 1, 'NRI Order data'!A:J, 10, FALSE)
 *   Pivot           = Σ Charges, rows Revised GL Code + Revised GL Desc,
 *                     columns Revised Class, filter Source.Name    glByClass()
 *
 * Verified against the workbook: the 2026 CA year codes to the same Revised
 * Class / GL / GL Desc on every line, and Sept 15 pivots to $76,850.43
 * (CA - Online $46,190.69 · CA - Whsle $30,659.74) — see the module doc.
 *
 * ONE ADDITION, and only for files not yet booked: CLASS RULES. In the workbook
 * every new invoice arrives coded to the legend's blanket class (CA - Whsle for
 * nearly everything) and the team hand-types CA - Online over ~60% of the lines —
 * 32,344 manual overrides in 2026. The rules below reproduce that hand coding
 * from the order type and the reference, so a new file arrives ~coded. They NEVER
 * apply to a `locked` (booked) file, and a manual override always beats them.
 */

const DASH_CLASS = null;

const norm = (v) => (v === undefined || v === null ? '' : String(v).replace(/\s+/g, ' ').trim());
const nkey = (v) => norm(v).toLowerCase();
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** TEXT(date, "mmm-yyyy"). */
const monthLabel = (iso) => (iso ? `${MON[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}` : null);

// ─── Class rules (unbooked files only) ───────────────────────────────────────
// The rules are DATA (nri_class_rules), maintained on All Invoices → Rules. A rule
// is { name, enabled, conditions: [{ field, op, values }], setClass }; ALL its
// conditions must match, and a condition matches when ANY of its values does
// (trim + case-insensitive). First enabled matching rule, in `seq` order, wins.

const RULE_FIELDS = ['orderType', 'service', 'clientRef1', 'clientRef2', 'customer'];
const RULE_OPS = ['is', 'startsWith', 'contains'];

/**
 * The starting set — what the team's 2026 hand coding did, measured on the CA
 * workbook. Seeded into nri_class_rules once (scripts/create-nri-billing-tables.js)
 * and edited in the UI from then on; nothing reads this at request time.
 * GoBolt is two rules because it is "starts with TO#" OR "contains gobolt".
 */
const DEFAULT_RULES = {
    CA: [
        // step 1, by order type — two columns; a charge with no order (storage,
        // labour, returns on an RMA) falls through to the service columns
        { kind: 'orderType', name: 'Wholesale order types', conditions: [{ field: 'orderType', op: 'is', values: ['PREBOOK', 'WHOLESALE', 'AT ONCE', 'PROMO'] }], setClass: 'CA - Whsle' },
        { kind: 'orderType', name: 'Ecomm order types', conditions: [{ field: 'orderType', op: 'is', values: ['ECOM'] }], setClass: 'CA - Online' },
        {
            kind: 'custom',
            name: 'GoBolt transfer orders (TO#)',
            conditions: [
                { field: 'service', op: 'is', values: ['Warehouse Labour', 'Overtime', 'Repackaging', 'Pallet Prep'] },
                { field: 'clientRef1', op: 'startsWith', values: ['TO#'] },
            ],
            setClass: 'CA - Online',
        },
        {
            kind: 'custom',
            name: 'GoBolt transfers by name',
            conditions: [
                { field: 'service', op: 'is', values: ['Warehouse Labour', 'Overtime', 'Repackaging', 'Pallet Prep'] },
                { field: 'clientRef1', op: 'contains', values: ['gobolt'] },
            ],
            setClass: 'CA - Online',
        },
        // the Ecomm column; a service in neither column takes the legend's default
        { kind: 'serviceColumn', name: 'Ecomm services', conditions: [{ field: 'service', op: 'is', values: ['Restock', 'Returns', 'Service Center Labor'] }], setClass: 'CA - Online' },
    ],
    US: [],
};

/** Evaluation order is FIXED by kind — see models/NriClassRules.js. */
const RULE_KINDS = ['orderType', 'custom', 'serviceColumn'];
const kindRank = (k) => { const i = RULE_KINDS.indexOf(k); return i < 0 ? 1 : i; };

function conditionMatches(c, ctx) {
    const v = nkey(ctx[c.field]);
    const vals = (c.values || []).map(nkey).filter(Boolean);
    if (c.op === 'is') return vals.some((x) => x === v);
    if (c.op === 'startsWith') return vals.some((x) => v.startsWith(x));
    if (c.op === 'contains') return vals.some((x) => v.includes(x));
    return false;
}
const ruleMatches = (rule, ctx) => (rule.conditions || []).length > 0
    && rule.conditions.every((c) => conditionMatches(c, ctx));

/** The rule context of a line — the only fields a condition may test. */
const ruleContext = (line, orderType) => ({
    orderType, service: line.service, clientRef1: line.clientRef1, clientRef2: line.clientRef2, customer: line.customer,
});

// ─── Inputs ──────────────────────────────────────────────────────────────────

/**
 * The coding legend (nri_charge_codes) → lookups. First match wins on both, as
 * VLOOKUP / XLOOKUP do; matching is trim + case-insensitive (the legend carries
 * stray trailing spaces — see lib/nriChargeCodes.js).
 */
function legendIndex(chargeCodes, entity) {
    const byService = new Map();
    const descByGl = new Map();
    for (const c of chargeCodes) {
        const k = nkey(c.service);
        const gl = c.gl === null || c.gl === undefined ? null : Number(c.gl);
        if (k && !byService.has(k)) {
            byService.set(k, {
                gl,
                description: c.glDesc || null,
                class: (entity === 'CA' ? c.classCa : c.classUs) || null,
            });
        }
        if (gl !== null && !descByGl.has(gl)) descByGl.set(gl, c.glDesc || null);
    }
    return { byService, descByGl };
}

/**
 * A reference as NRI and NetSuite both write it: upper-case, no spaces, no leading
 * "#" — so "#CA987809" (a sales order's Other Ref #), "CA987809" (NRI's Client
 * Ref 1) and "RMA #K0Z3WP82" / "RMA#K0Z3WP82" each meet as one key.
 */
const refKey = (v) => norm(v).toUpperCase().replace(/\s+/g, '').replace(/^#+/, '');

/**
 * Order master rows → the lookup an invoice line's Client Ref 1 / 2 resolves by.
 * THE ONE implementation — lib/nriOrderSync.js uses it to decide what still needs
 * fetching, so "resolved" means the same thing to the fetch and to the coder.
 * (They were two copies, and the coder's Client Ref 2 test had lost its `\d`.)
 *
 * First key wins, in this order:
 *   1. a record's own number           IF4041483465 · RMA92505 · PO04728 · SO…
 *   2. a return's external reference   "RMA #K0Z3WP82" · "#CA984653" (the RA)
 *   3. a sales order's web order #     "#CA987809" — after the RA, so a return
 *                                      that HAS an RA is coded by the RA
 *   4. the NetSuite internal id        Client Ref 2 — rows pulled from NetSuite only
 *                                      (a pasted sheet's Ref2 is not guaranteed one)
 */
function orderTypeIndex(orders) {
    const m = new Map();
    const put = (k, v) => { if (k && !m.has(k)) m.set(k, v); };
    const so = (o) => o.recordType === 'SalesOrd';
    for (const o of orders) put(refKey(o.orderNo), o.orderType || null);
    for (const o of orders) if (!so(o)) put(refKey(o.altRef), o.orderType || null);
    for (const o of orders) if (so(o)) put(refKey(o.altRef), o.orderType || null);
    for (const o of orders) if (o.source === 'netsuite' && /^\d+$/.test(norm(o.ref2))) put(`ID:${norm(o.ref2)}`, o.orderType || null);
    return m;
}

/**
 * Client Ref 1 as a number / external ref, else Client Ref 2 as a NetSuite id.
 * `undefined` = the line resolves to nothing held; `null` = it resolves to a record
 * with no order type (a transfer-order fulfillment) — held, so nothing to fetch.
 */
function orderTypeLookup(orderTypes, line) {
    const r1 = refKey(line.clientRef1);
    if (r1 && orderTypes.has(r1)) return orderTypes.get(r1);
    const r2 = norm(line.clientRef2);
    if (/^\d+$/.test(r2) && orderTypes.has(`ID:${r2}`)) return orderTypes.get(`ID:${r2}`);
    return undefined;
}

function orderTypeOf(orderTypes, line) {
    return orderTypeLookup(orderTypes, line) ?? null;
}

/** A DB row (DECIMAL as string) → numbers. The one place that conversion happens. */
function toLine(r) {
    return {
        id: r.id, fileId: r.fileId, seq: Number(r.seq),
        orderId: r.orderId, clientRef1: r.clientRef1, clientRef2: r.clientRef2,
        customer: r.customer, poNumber: r.poNumber, docDate: r.docDate, completed: r.completed,
        units: num(r.units), value: num(r.value), service: r.service,
        charges: num(r.charges), taxes: num(r.taxes), invAmt: num(r.invAmt),
        classOverride: r.classOverride || null,
        glOverride: r.glOverride === null || r.glOverride === undefined || r.glOverride === '' ? null : Number(r.glOverride),
    };
}

// ─── Coding ──────────────────────────────────────────────────────────────────

/**
 * @param {object} ctx { entity, legend: legendIndex(), orderTypes: Map, lockedFiles: Set<fileId>,
 *                      rules: nri_class_rules rows (any order; disabled ones are skipped) }
 * @returns {(line) => codedLine}
 */
/**
 * GL Codes page settings, effective by month: (month 'YYYY-MM') → { from, map, whsle }
 * from the latest saved month at or before it, or null when none applies (use the
 * legend). `map` = service → GL; `whsle` = service → GL on a wholesale order, only
 * where it differs. See models/NriGlRules.js.
 */
function glMonthResolver(glRules) {
    const byMonth = new Map();
    for (const r of glRules) {
        if (!byMonth.has(r.month)) byMonth.set(r.month, { map: new Map(), whsle: new Map() });
        const m = byMonth.get(r.month);
        m.map.set(nkey(r.service), Number(r.gl));
        const w = r.glWholesaleOrder === null || r.glWholesaleOrder === undefined || r.glWholesaleOrder === '' ? null : Number(r.glWholesaleOrder);
        if (w !== null && w !== Number(r.gl)) m.whsle.set(nkey(r.service), w);
    }
    const months = [...byMonth.keys()].sort();
    const memo = new Map();
    const resolve = (month) => {
        if (!month) return null;
        if (memo.has(month)) return memo.get(month);
        let hit = null;
        for (const m of months) if (m <= month) hit = m;
        const out = hit ? { from: hit, ...byMonth.get(hit) } : null;
        memo.set(month, out);
        return out;
    };
    resolve.months = months;
    return resolve;
}

/**
 * The channel rules in force for a period-end month — EACH KIND resolved on its own
 * (Rules page, 2026-10-01: step 1, exceptions and step 2 are all by month): for a
 * kind, the rows of the latest saved month at or before the target, else its rows
 * with month NULL (the starting rules). A month that deliberately has NONE of a
 * kind (every exception removed) is stored as one placeholder row named
 * EMPTY_SET, so "set to nothing" is not mistaken for "not set".
 *
 * resolve(month) → { rules: enabled rules to evaluate, all: rows to show,
 *                    from: { [kind]: month | null } }
 */
const EMPTY_SET = '__empty__';
function ruleMonthResolver(rules) {
    const byKind = new Map(RULE_KINDS.map((k) => [k, rules.filter((r) => r.kind === k)]));
    const monthsOf = (rs) => [...new Set(rs.map((r) => r.month).filter(Boolean))].sort();
    const kindMonths = new Map([...byKind].map(([k, rs]) => [k, monthsOf(rs)]));
    const memo = new Map();
    const resolve = (month) => {
        const key = month || '';
        if (memo.has(key)) return memo.get(key);
        const from = {};
        const all = [];
        for (const [k, rs] of byKind) {
            let hit = null;
            if (month) for (const m of kindMonths.get(k)) if (m <= month) hit = m;
            from[k] = hit;
            all.push(...rs.filter((r) => (hit ? r.month === hit : !r.month) && r.name !== EMPTY_SET));
        }
        all.sort((x, y) => kindRank(x.kind) - kindRank(y.kind) || x.seq - y.seq);
        const out = { from, all, rules: all.filter((r) => r.enabled !== false) };
        memo.set(key, out);
        return out;
    };
    resolve.months = monthsOf(rules);
    return resolve;
}

function buildCoder({ entity, legend, orderTypes, lockedFiles, rules = [], glRules = [], fileMonths = new Map() }) {
    const rulesFor = ruleMonthResolver(rules);
    // GL Codes page: service → GL by period-end month, for files NOT marked Booked
    const glFor = glMonthResolver(glRules);
    // lazy: lib/nriOrderSync requires this module
    const { refKind } = require('../lib/nriOrderSync');
    return function codeLine(line) {
        const map = legend.byService.get(nkey(line.service)) || null;
        const held = orderTypeLookup(orderTypes, line);   // undefined = not held · null = held, no type
        const orderType = held || null;
        const locked = lockedFiles.has(line.fileId);
        const month = fileMonths.get(line.fileId);

        let revisedClass = map ? map.class : DASH_CLASS;
        let classSource = map ? 'legend' : 'unmapped';
        let ruleId = null;
        if (line.classOverride) {
            revisedClass = line.classOverride;
            classSource = 'manual';
        } else if (!locked) {
            const ctx = ruleContext(line, orderType);
            const rule = rulesFor(month).rules.find((r) => ruleMatches(r, ctx));
            if (rule) { revisedClass = rule.setClass; classSource = `rule:${rule.name}`; ruleId = rule.id; }
        }

        // A WHOLESALE ORDER = the line resolves to an order whose type step 1 (Rules,
        // in force for the month) codes Wholesale — e.g. a fulfillment of a PREBOOK.
        const step1 = orderType && !locked
            ? rulesFor(month).rules.find((r) => r.kind === 'orderType' && ruleMatches(r, ruleContext(line, orderType)))
            : null;
        const wholesaleOrder = !!(step1 && /whsle/i.test(step1.setClass || ''));

        // GL: a hand-coded GL wins; else, on a file not Booked, the GL Codes page —
        // its wholesale-order GL on a wholesale order, its GL otherwise; else the
        // coding legend — which is all a Booked file is ever coded by
        const monthGl = !locked ? glFor(month) : null;
        const pageGl = monthGl ? monthGl.map.get(nkey(line.service)) : undefined;
        const whsleGl = monthGl ? monthGl.whsle.get(nkey(line.service)) : undefined;
        let revisedGl;
        let glSource;
        if (line.glOverride !== null) { revisedGl = line.glOverride; glSource = 'manual'; }
        else if (whsleGl !== undefined && wholesaleOrder) { revisedGl = whsleGl; glSource = 'wholesaleOrder'; }
        else if (pageGl !== undefined && pageGl !== (map ? map.gl : null)) { revisedGl = pageGl; glSource = 'rule'; }
        else { revisedGl = map ? map.gl : null; glSource = map ? 'legend' : 'unmapped'; }
        const revisedGlDesc = glSource === 'legend' ? map.description : (revisedGl !== null ? legend.descByGl.get(revisedGl) ?? null : null);

        const flags = [];
        if (!map && revisedGl === null) flags.push('unmappedService');
        if (revisedGl !== null && !legend.descByGl.has(revisedGl)) flags.push('unknownGl');
        if (!revisedClass) flags.push('noClass');
        if (!line.completed) flags.push('noCompletedDate');
        if (Math.abs(round2(line.charges + line.taxes) - line.invAmt) > 0.011) flags.push('totalMismatch');
        // NOT SURE — the review asks the uploader (controller questionsFor). Never on a
        // Booked file, and never once a person has answered (the answer is a hand coding).
        if (!locked) {
            const quotesOrder = !!refKind(entity, line.clientRef1);
            if (!line.classOverride && quotesOrder && held === undefined) flags.push('orderNotFound');
            else if (!line.classOverride && quotesOrder && held === null) flags.push('orderNoType');
            // a wholesale line of a service with a wholesale-order GL, but no order behind it:
            // fulfilment work, or an extra charge?
            if (line.glOverride === null && whsleGl !== undefined && !orderType && /whsle/i.test(revisedClass || '')) flags.push('glWholesaleAsk');
        }

        return {
            ...line,
            netsuiteGl: map ? map.gl : null,
            description: map ? map.description : null,
            defaultClass: map ? map.class : null,
            revisedClass,
            revisedGl,
            revisedGlDesc,
            month: monthLabel(line.completed),
            orderType,
            classSource,
            ruleId,
            glSource,
            flags,
        };
    };
}

// ─── Pivot: Σ Charges by Revised GL × Revised Class ──────────────────────────

/** Whsle first, then Online, then the rest — the order the finance pivot reads. */
function classOrder(a, b) {
    const rank = (c) => (c === null ? 9 : /whsle/i.test(c) ? 0 : /online/i.test(c) ? 1 : 2);
    return rank(a) - rank(b) || String(a).localeCompare(String(b));
}

/**
 * @returns {{ classes: (string|null)[], rows: {gl, glDesc, cells: Record<cls, number>, total}[], totals }}
 *   `null` in `classes` is the "(no class)" column — kept IN the grand total so
 *   the total always equals the invoice, never folded into a real class.
 */
function glByClass(coded, value = 'charges') {
    const classSet = new Set();
    const byGl = new Map();
    for (const l of coded) {
        const k = l.revisedGl === null ? 'null' : String(l.revisedGl);
        if (!byGl.has(k)) byGl.set(k, { gl: l.revisedGl, glDesc: l.revisedGlDesc, cells: {}, total: 0, lines: 0 });
        const g = byGl.get(k);
        const c = l.revisedClass || null;
        classSet.add(c);
        const ck = c === null ? '' : c;
        g.cells[ck] = (g.cells[ck] || 0) + l[value];
        g.total += l[value];
        g.lines++;
    }
    const classes = [...classSet].sort(classOrder);
    const rows = [...byGl.values()]
        .sort((a, b) => (a.gl === null) - (b.gl === null) || (a.gl ?? 0) - (b.gl ?? 0))
        .map((g) => ({
            gl: g.gl, glDesc: g.glDesc, lines: g.lines,
            cells: Object.fromEntries(Object.entries(g.cells).map(([c, v]) => [c, round2(v)])),
            total: round2(g.total),
        }));
    const totals = { cells: {}, total: 0, lines: coded.length };
    for (const c of classes) {
        const ck = c === null ? '' : c;
        totals.cells[ck] = round2(rows.reduce((s, r) => s + (r.cells[ck] || 0), 0));
    }
    totals.total = round2(rows.reduce((s, r) => s + r.total, 0));
    return { classes, rows, totals };
}

// ─── Rate check rollup ───────────────────────────────────────────────────────

const PROBLEM = new Set(['overcharge', 'undercharge']);

/** Per-service rollup of the rate check, worst first. */
function rateSummary(checked) {
    const by = new Map();
    const verdicts = {};
    for (const l of checked) {
        const v = l.rateCheck.verdict;
        verdicts[v] = verdicts[v] || { lines: 0, charges: 0, variance: 0 };
        verdicts[v].lines++;
        verdicts[v].charges += l.charges;
        if (l.rateCheck.variance !== null) verdicts[v].variance += l.rateCheck.variance;

        if (!by.has(l.service)) {
            by.set(l.service, { service: l.service, lines: 0, charges: 0, units: 0, verdicts: {}, variance: 0, rateCodes: new Set(), terms: new Map(), offCard: { lines: 0, units: 0 } });
        }
        const s = by.get(l.service);
        s.lines++;
        s.charges += l.charges;
        s.units += l.units;
        s.verdicts[v] = (s.verdicts[v] || 0) + 1;
        if (PROBLEM.has(v)) s.variance += l.rateCheck.variance;
        for (const c of l.rateCheck.rateCodes) s.rateCodes.add(c);

        // THE WORKING, from the RATE CARD (never from what NRI billed): each line adds
        // to the card line it was priced against — Σ quantity × card rate, a tier
        // range for storage, or the card's own words where it gives no number. Lines
        // whose service is not on the card at all are only counted.
        const c = l.rateCheck.calc;
        if (c) {
            const t = s.terms.get(c.code) || { ...c, lines: 0, units: 0, expected: 0, min: 0, max: 0 };
            t.lines++;
            t.units += l.units;
            t.expected += l.rateCheck.expected || 0;
            if (c.basis === 'tier') { t.min += c.min; t.max += c.max; }
            s.terms.set(c.code, t);
        } else {
            s.offCard.lines++;
            s.offCard.units += l.units;
        }
    }
    const round4 = (n) => Math.round(n * 10000) / 10000;
    const services = [...by.values()].map(({ terms, offCard, ...s }) => ({
        ...s,
        calc: {
            terms: [...terms.values()].map((t) => ({
                ...t, units: round4(t.units), expected: round2(t.expected), min: round2(t.min), max: round2(t.max),
            })).sort((a, b) => b.expected - a.expected),
            offCard: { lines: offCard.lines, units: round4(offCard.units) },
        },
        charges: round2(s.charges),
        variance: round2(s.variance),
        rateCodes: [...s.rateCodes],
        flagged: (s.verdicts.overcharge || 0) + (s.verdicts.undercharge || 0),
    })).sort((a, b) => b.flagged - a.flagged || Math.abs(b.variance) - Math.abs(a.variance) || b.charges - a.charges);
    for (const v of Object.values(verdicts)) { v.charges = round2(v.charges); v.variance = round2(v.variance); }
    return { verdicts, services };
}

/**
 * How much of the invoice the rate card actually covered. "0 overcharges" means
 * nothing if most of the money was never checkable, so every line lands in
 * exactly one bucket and the buckets always sum to the selection:
 *
 *   verified        billed = contract
 *   flagged         billed ≠ contract (over or under)
 *   qtyUnsupported  hourly: rate on the card, but the hour count does not tie
 *   tierBlend       storage billed as one blended line inside the tier range —
 *                   plausible, but the aging mix behind it is not on the invoice
 *   passthrough     freight / materials billed at market — the card has no price
 *   notInAgreement  service the card is silent on, or prices with no number
 */
const BUCKET_OF = {
    ok: 'verified',
    overcharge: 'flagged',
    undercharge: 'flagged',
    qtyUnsupported: 'qtyUnsupported',
    tierBlend: 'tierBlend',
    passthrough: 'passthrough',
    noContractRate: 'notInAgreement',
    noRateOnCard: 'notInAgreement',
};
const BUCKETS = ['verified', 'flagged', 'qtyUnsupported', 'tierBlend', 'passthrough', 'notInAgreement'];

function rateBuckets(checked) {
    const out = Object.fromEntries(BUCKETS.map((b) => [b, { lines: 0, charges: 0, variance: 0 }]));
    for (const l of checked) {
        const b = out[BUCKET_OF[l.rateCheck.verdict] || 'notInAgreement'];
        b.lines++;
        b.charges += l.charges;
        if (l.rateCheck.variance !== null) b.variance += l.rateCheck.variance;
    }
    for (const b of Object.values(out)) { b.charges = round2(b.charges); b.variance = round2(b.variance); }
    return out;
}

// ─── Duplicate files ─────────────────────────────────────────────────────────

/**
 * The same NRI charge appearing in two files. Found in the 2026 workbook:
 * `NRI CA Invoice June 1 2026.csv` IS the May 16–31 invoice again (every
 * completion date in May; identical lines apart from a printed footer row and
 * re-encoded accents), so the workbook's all-files pivot counts $14,838.78 twice.
 *
 * A charge's fingerprint is (OrderID, Service, Completed, Units, Charges) — the
 * customer/reference text is excluded because it is exactly what re-encoding
 * changes. A pair is reported when it shares at least 20 lines AND at least half
 * of the smaller file: one shared line is coincidence, half a file is a re-send.
 */
const fingerprint = (l) => [norm(l.orderId), nkey(l.service), l.completed, l.units, l.charges].join('|');

function duplicateFiles(lines, { minShared = 20, minShare = 0.5 } = {}) {
    const sizes = new Map();
    const firstFile = new Map();
    const pairs = new Map();
    for (const l of lines) {
        sizes.set(l.fileId, (sizes.get(l.fileId) || 0) + 1);
        const fp = fingerprint(l);
        const first = firstFile.get(fp);
        if (first === undefined) { firstFile.set(fp, l.fileId); continue; }
        if (first === l.fileId) continue;
        const k = `${first}\u0000${l.fileId}`;
        const p = pairs.get(k) || { a: first, b: l.fileId, shared: 0, charges: 0 };
        p.shared++;
        p.charges += l.charges;
        pairs.set(k, p);
    }
    return [...pairs.values()]
        .map((p) => ({ ...p, charges: round2(p.charges), share: p.shared / Math.min(sizes.get(p.a), sizes.get(p.b)) }))
        .filter((p) => p.shared >= minShared && p.share >= minShare)
        .sort((x, y) => y.charges - x.charges);
}

// ─── Line filtering (drill-down + bulk override share it) ────────────────────

/**
 * filter: { gl, cls, service, verdict, flag, q }. `gl`/`cls` accept the string
 * 'null' for the unmapped row / the no-class column, so a pivot cell can always
 * be drilled.
 */
function lineFilter(f = {}) {
    const has = (k) => f[k] !== undefined && f[k] !== null && f[k] !== '';
    const q = has('q') ? nkey(f.q) : null;
    return (l) => {
        if (has('gl') && (f.gl === 'null' ? l.revisedGl !== null : l.revisedGl !== Number(f.gl))) return false;
        if (has('cls') && (f.cls === 'null' ? !!l.revisedClass : l.revisedClass !== f.cls)) return false;
        if (has('service') && l.service !== f.service) return false;
        if (has('verdict') && (!l.rateCheck || l.rateCheck.verdict !== f.verdict)) return false;
        if (has('bucket') && (!l.rateCheck || BUCKET_OF[l.rateCheck.verdict] !== f.bucket)) return false;
        if (has('flag') && !l.flags.includes(f.flag)) return false;
        if (has('rule') && l.ruleId !== f.rule) return false;
        if (has('glSource') && l.glSource !== f.glSource) return false;
        if (has('classSource') && !String(l.classSource).startsWith(f.classSource)) return false;
        if (q && ![l.orderId, l.clientRef1, l.clientRef2, l.customer, l.poNumber, l.service]
            .some((v) => nkey(v).includes(q))) return false;
        return true;
    };
}

module.exports = {
    DEFAULT_RULES, RULE_FIELDS, RULE_OPS, RULE_KINDS, kindRank, glMonthResolver, ruleMonthResolver, EMPTY_SET, ruleMatches, ruleContext, legendIndex, refKey, orderTypeIndex, orderTypeLookup, orderTypeOf, toLine, buildCoder, glByClass, rateSummary,
    lineFilter, duplicateFiles, rateBuckets, BUCKET_OF, monthLabel, round2,
};
