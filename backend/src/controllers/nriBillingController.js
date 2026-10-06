'use strict';
/**
 * NRI billing — rate cards, the year's uploaded invoice reports, and cost per GL.
 * Mounted at /nri-billing. The workbook flow (`NRI CA_ALL Invoices 2026.xlsx`)
 * as three screens:
 *
 *   Rate Cards  GET|POST /rate-cards          the agreement each line is checked against
 *   Uploads     GET|POST /files, PATCH|DELETE /files/:id
 *   Results     GET /results, GET /lines, PUT /lines/override
 *
 * Owns nri_contract_rates, nri_contract_terms, nri_billing_files,
 * nri_billing_lines. READS nri_charge_codes (the coding legend) and
 * nri_order_master (Order Type) — both maintained by the /nri-invoices module,
 * so there is one legend and one order master, not two that can disagree.
 *
 * Everything coded (class, GL, description, month, rate verdict) is DERIVED per
 * request from the stored lines; only NRI's own figures and the two manual
 * overrides are stored.
 */

const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const { models } = require('../models');
const { currentTransaction } = require('../../database/txContext');
const parser = require('../lib/nriBillingParser');
const rates = require('../lib/nriBillingRates');
const svc = require('../services/nriBillingService');
const orderSync = require('../lib/nriOrderSync');
const oldRateCard = require('../lib/nriRateCard');

const ENTITIES = ['CA', 'US'];
const STORE_DIR = path.join(__dirname, '..', '..', 'storage', 'reference', 'nri-billing');

const tx = () => ({ transaction: currentTransaction() });
const norm = (v) => (v === undefined || v === null ? '' : String(v).trim());
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function entityOf(v, fallback = 'CA') {
    const e = norm(v).toUpperCase().replace(/^NRI[-\s]?/, '');
    return ENTITIES.includes(e) ? e : fallback;
}
function badRequest(res, error) { return res.status(400).json({ error }); }

const slug = (s) => norm(s).replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase();

function fileRow(f) {
    return {
        id: f.id, entity: f.entity, fileName: f.fileName, invoiceNo: f.invoiceNo,
        periodEnd: f.periodEnd, reportDate: f.reportDate, lineCount: Number(f.lineCount),
        charges: num(f.charges), taxes: num(f.taxes), invAmt: num(f.invAmt),
        locked: !!f.locked, uploadedAt: f.uploadedAt, uploadedBy: f.uploadedBy,
        hasOriginal: !!f.storedPath,
        confirmedAt: f.confirmedAt || null,
        confirmedBy: f.confirmedBy || null,
    };
}

// ─── shared context: legend, order types, card ───────────────────────────────

async function context(entity) {
    const [codes, orders, card, rules, glRules] = await Promise.all([
        models.nri_charge_codes.read(),
        models.nri_order_master.findAll({ where: { entity }, raw: true }),
        models.nri_contract_rates.findAll({ where: { entity }, raw: true }),
        models.nri_class_rules.findAll({ where: { entity }, order: [['seq', 'ASC']], raw: true }),
        models.nri_gl_rules.findAll({ where: { entity }, raw: true }),
    ]);
    return {
        rules,
        glRules,
        codes,
        legend: svc.legendIndex(codes, entity),
        serviceNames: new Map(codes.map((c) => [norm(c.service).toLowerCase(), norm(c.service)])),
        orderTypes: svc.orderTypeIndex(orders),
        card: rates.cardIndex(card.map((r) => ({ ...r, rate: num(r.rate) }))),
        cardLoaded: card.length > 0,
    };
}

/** Code + rate-check a set of lines. `lockedFiles` = Set of fileIds frozen from rules. */
const MONTH_RE = /^\d{4}-\d{2}$/;
const nextMonth = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

/** fileId → its invoice's period-end month (YYYY-MM) — the month GL settings key on. */
const monthsOf = (files) => new Map(files.map((f) => [f.id, f.periodEnd ? String(f.periodEnd).slice(0, 7) : null]));

function codeAll(lines, entity, ctx, lockedFiles, fileMonths = new Map()) {
    const codeLine = svc.buildCoder({ entity, legend: ctx.legend, orderTypes: ctx.orderTypes, lockedFiles, rules: ctx.rules, glRules: ctx.glRules, fileMonths });
    return lines.map((l) => {
        const c = codeLine(l);
        c.rateCheck = rates.checkLine(c, entity, ctx.card);
        return c;
    });
}

/**
 * The files a request is about: `?files=id1,id2` (the Source.Name slicer), else
 * `?month=YYYY-MM` (files whose period ends in that month), else every file of
 * the entity.
 */
async function selectFiles(entity, q) {
    const all = (await models.nri_billing_files.findAll({ where: { entity }, raw: true }))
        .map(fileRow)
        .sort((a, b) => String(b.periodEnd || '').localeCompare(String(a.periodEnd || '')) || a.fileName.localeCompare(b.fileName));
    const ids = norm(q.files).split(',').map(norm).filter(Boolean);
    let chosen = all;
    if (ids.length) chosen = all.filter((f) => ids.includes(f.id));
    else if (/^\d{4}-\d{2}$/.test(norm(q.month))) chosen = all.filter((f) => String(f.periodEnd || '').startsWith(q.month));
    return { all, chosen };
}

async function loadLines(fileIds) {
    if (!fileIds.length) return [];
    const rows = await models.nri_billing_lines.findAll({
        where: { fileId: { [Op.in]: fileIds } },
        order: [['fileId', 'ASC'], ['seq', 'ASC']],
        raw: true,
    });
    return rows.map(svc.toLine);
}

// ─── Rate cards ──────────────────────────────────────────────────────────────

exports.getRateCards = async (req, res) => {
    const [rateRows, termRows] = await Promise.all([
        models.nri_contract_rates.findAll({ order: [['entity', 'ASC'], ['seq', 'ASC']], raw: true }),
        models.nri_contract_terms.findAll({ order: [['entity', 'ASC'], ['kind', 'ASC'], ['seq', 'ASC']], raw: true }),
    ]);
    const out = {};
    for (const e of ENTITIES) {
        out[e] = {
            entity: e,
            rates: rateRows.filter((r) => r.entity === e).map((r) => ({ ...r, rate: num(r.rate) })),
            info: termRows.filter((t) => t.entity === e && t.kind === 'info'),
            rules: termRows.filter((t) => t.entity === e && t.kind === 'rule'),
            // which card codes the line check actually uses, so the page can show
            // the NRI services each rate validates
            serviceMap: Object.entries(rates.SERVICE_RATES[e] || {}).map(([service, s]) => ({
                service, basis: s.basis,
                codes: [...(s.fixed ? [`${e}-${s.fixed}`] : []), ...s.codes.map((c) => `${e}-${c}`)],
            })),
        };
    }
    res.json(out);
};

/** POST /rate-cards (multipart: file=<rate card xlsx>, entity?) — replaces that entity's card. */
exports.uploadRateCard = async (req, res) => {
    const file = req.file || req.files?.file?.[0];
    if (!file) return badRequest(res, 'A rate card workbook is required (field name "file").');
    let parsed;
    try {
        parsed = await parser.parseRateCard(file.buffer, req.body?.entity ? entityOf(req.body.entity) : null);
    } catch (e) {
        return res.status(e.status || 400).json({ error: `Could not read the rate card: ${e.message}` });
    }
    if (!parsed.rates.length) return badRequest(res, 'The "Rate Card" sheet has no rows with a Rate Code.');
    if (req.body?.entity && entityOf(req.body.entity) !== parsed.entity) {
        return badRequest(res, `This is the ${parsed.entity} card (its rate codes say so), but it was uploaded as ${entityOf(req.body.entity)}.`);
    }
    const dup = parsed.rates.map((r) => r.id).filter((id, i, a) => a.indexOf(id) !== i);
    if (dup.length) return badRequest(res, `Duplicate rate codes on the card: ${[...new Set(dup)].join(', ')}.`);

    const { entity } = parsed;
    await models.nri_contract_rates.destroy({ where: { entity }, ...tx() });
    await models.nri_contract_terms.destroy({ where: { entity }, ...tx() });
    await models.nri_contract_rates.bulkCreate(parsed.rates, tx());
    if (parsed.terms.length) await models.nri_contract_terms.bulkCreate(parsed.terms, tx());
    oldRateCard.reload();   // the /nri-invoices validator reads this same card
    res.json({
        entity,
        rates: parsed.rates.length,
        priced: parsed.rates.filter((r) => r.rate !== null).length,
        info: parsed.terms.filter((t) => t.kind === 'info').length,
        rules: parsed.terms.filter((t) => t.kind === 'rule').length,
    });
};

// ─── Uploaded invoice files ──────────────────────────────────────────────────

// ─── Order data (Order Type lookup) — pulled from NetSuite ───────────────────

/** GET /order-data?entity=CA — how much is held and how far NetSuite is synced. */
exports.orderDataStatus = async (req, res) => {
    res.json(await orderSync.status(entityOf(req.query.entity)));
};

/**
 * POST /order-data/sync { entity, from?, to? } — pull Item Fulfillments from
 * NetSuite (read-only) and merge them in. Default range: from a week before what
 * is already covered (or 1 January), to today.
 */
exports.syncOrderData = async (req, res) => {
    const entity = entityOf(req.body.entity);
    const st = await orderSync.status(entity);
    const to = req.body.to || new Date().toISOString().slice(0, 10);
    const from = req.body.from
        || (st.syncedThrough
            ? new Date(Date.parse(`${st.syncedThrough}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10)
            : `${to.slice(0, 4)}-01-01`);
    if (from > to) return badRequest(res, "'from' is after 'to'.");
    try {
        const result = await orderSync.sync({ entity, from, to, by: req.user?.email || null });
        // and every record (RA / IF / sales order / PO) the files already held quote
        // but nobody fetched
        const files = await models.nri_billing_files.findAll({ where: { entity }, raw: true, attributes: ['id'] });
        const held = await loadLines(files.map((f) => f.id));
        result.refsResolved = await orderSync.resolveRefs({ entity, lines: held });
        res.json(result);
    } catch (e) {
        const status = e.status || 502;
        res.status(status).json({ error: status === 502 ? `NetSuite did not answer: ${e.response?.status || e.message}` : e.message });
    }
};

exports.listFiles = async (req, res) => {
    const entity = entityOf(req.query.entity);
    const { all } = await selectFiles(entity, {});
    const orders = await models.nri_order_master.count({ where: { entity } });
    res.json({ entity, files: all, orderDataRows: orders });
};

function summarise(parsed) {
    const sum = (k) => svc.round2(parsed.lines.reduce((s, l) => s + l[k], 0));
    const dates = parsed.lines.map((l) => l.completed).filter(Boolean).sort();
    return {
        invoiceNo: parsed.invoiceNo,
        periodEnd: parsed.periodEnd || dates[dates.length - 1] || null,
        reportDate: parsed.reportDate,
        lineCount: parsed.lines.length,
        charges: sum('charges'), taxes: sum('taxes'), invAmt: sum('invAmt'),
        firstCompleted: dates[0] || null, lastCompleted: dates[dates.length - 1] || null,
        skipped: parsed.skipped,
    };
}

const overrideKey = (l) => `${norm(l.orderId)}|${norm(l.service)}`;

/**
 * POST /files (multipart: file=<NRI Invoice Details Report .csv>, entity, dryRun?)
 *
 * Re-uploading a file already held (same file name, or same invoice number)
 * REPLACES its lines and CARRIES the manual overrides across by
 * (OrderID, Service) — unique per file on all 52,705 lines of 2026 — so a
 * corrected re-send from NRI does not throw away the team's coding. A booked
 * (locked) file is refused: unlock it first, deliberately.
 *
 * `dryRun=true` parses + codes + rate-checks and saves nothing.
 */
exports.uploadFile = async (req, res) => {
    const file = req.file || req.files?.file?.[0];
    if (!file) return badRequest(res, 'Choose the NRI invoice report (field name "file").');
    if (!/\.(csv|xlsx|xls)$/i.test(file.originalname)) return badRequest(res, 'Expected the NRI report as .csv (or .xlsx).');
    const entity = entityOf(req.body?.entity, null);
    if (!entity) return badRequest(res, "Say which warehouse this is for: entity 'CA' or 'US'.");

    let parsed;
    try {
        parsed = parser.parseInvoiceReport(file.buffer, file.originalname);
    } catch (e) {
        return res.status(e.status || 400).json({ error: e.message });
    }
    if (!parsed.lines.length) return badRequest(res, 'The report has a header but no charge lines.');

    const fileName = path.basename(file.originalname);
    const summary = summarise(parsed);

    const existing = await models.nri_billing_files.findAll({ where: { entity }, raw: true });
    const prior = existing.find((f) => f.fileName === fileName)
        || (parsed.invoiceNo && existing.find((f) => f.invoiceNo === parsed.invoiceNo));

    if (prior && prior.locked) {
        return res.status(409).json({
            error: 'locked',
            message: `"${prior.fileName}" is marked as booked. Unlock it on the Uploads page before replacing it.`,
        });
    }

    const id = prior ? prior.id : `nbf_${entity.toLowerCase()}_${parsed.invoiceNo || slug(fileName)}`;

    // carry overrides across a re-upload
    const carried = new Map();
    if (prior) {
        const old = await models.nri_billing_lines.findAll({
            where: { fileId: prior.id, [Op.or]: [{ classOverride: { [Op.ne]: null } }, { glOverride: { [Op.ne]: null } }] },
            raw: true,
        });
        for (const o of old) carried.set(overrideKey(o), { classOverride: o.classOverride, glOverride: o.glOverride });
    }
    let kept = 0;
    const lines = parsed.lines.map((l) => {
        const ov = carried.get(overrideKey(l));
        if (ov) kept++;
        return { ...l, id: `${id}_${l.seq}`, fileId: id, classOverride: ov ? ov.classOverride : null, glOverride: ov ? ov.glOverride : null };
    });

    // the order data must cover this invoice's period before its lines are coded —
    // pull from NetSuite through the period end if it does not yet. A NetSuite
    // failure never blocks the upload: it is reported, and coding proceeds on what
    // is held.
    let orderData;
    try {
        orderData = await orderSync.ensureCurrent({ entity, through: summary.periodEnd, lines: parsed.lines, by: req.user?.email || null });
    } catch (e) {
        orderData = { ran: false, error: `Could not refresh order data from NetSuite: ${e.response?.status ? `NetSuite ${e.response.status}` : e.message}` };
    }

    // code + rate check, so the uploader sees the result before (or as) it lands
    const ctx = await context(entity);
    const coded = codeAll(lines.map(svc.toLine), entity, ctx, new Set(), new Map([[id, summary.periodEnd ? summary.periodEnd.slice(0, 7) : null]]));
    const pivot = svc.glByClass(coded);
    const rateCheck = svc.rateSummary(coded);
    const flags = {};
    for (const l of coded) for (const f of l.flags) flags[f] = (flags[f] || 0) + 1;

    // the same invoice already held under another name? (June 1 2026 = May 31 2026)
    const others = existing.filter((f) => !prior || f.id !== prior.id);
    const otherLines = await loadLines(others.map((f) => f.id));
    const names = new Map(others.map((f) => [f.id, f.fileName]));
    const duplicates = svc.duplicateFiles([...otherLines, ...lines.map(svc.toLine)])
        .filter((p) => p.b === id || p.a === id)
        .map((p) => ({ fileId: p.a === id ? p.b : p.a, fileName: names.get(p.a === id ? p.b : p.a), shared: p.shared, share: p.share, charges: p.charges }));

    const payload = {
        id, entity, fileName, ...summary, duplicates,
        replaces: prior ? { id: prior.id, fileName: prior.fileName, lineCount: Number(prior.lineCount) } : null,
        overridesCarried: kept, overridesDropped: carried.size - kept,
        pivot, rateCheck: { verdicts: rateCheck.verdicts, buckets: svc.rateBuckets(coded), services: rateCheck.services.slice(0, 15) },
        flags, cardLoaded: ctx.cardLoaded, orderData,
    };
    if (String(req.body?.dryRun) === 'true') return res.json({ ...payload, dryRun: true });
    if (duplicates.length && String(req.body?.force) !== 'true') {
        const d = duplicates[0];
        return res.status(409).json({
            ...payload,
            error: 'duplicate',
            message: `${d.shared} of these lines (${d.charges.toFixed(2)}) are already in "${d.fileName}" — this looks like the same invoice sent twice. Upload anyway only if NRI really billed them twice.`,
        });
    }

    // keep the original file: the year's reports must stay readable
    const dir = path.join(STORE_DIR, entity.toLowerCase());
    fs.mkdirSync(dir, { recursive: true });
    const storedPath = path.join(dir, fileName);
    fs.writeFileSync(storedPath, file.buffer);

    if (prior) {
        await models.nri_billing_lines.destroy({ where: { fileId: prior.id }, ...tx() });
        await models.nri_billing_files.destroy({ where: { id: prior.id }, ...tx() });
    }
    await models.nri_billing_files.create({
        id, entity, fileName,
        invoiceNo: summary.invoiceNo, periodEnd: summary.periodEnd, reportDate: summary.reportDate,
        lineCount: summary.lineCount, charges: summary.charges, taxes: summary.taxes, invAmt: summary.invAmt,
        locked: false,
        uploadedAt: new Date().toISOString(),
        uploadedBy: req.user?.email || null,
        storedPath: path.relative(path.join(__dirname, '..', '..'), storedPath),
    }, tx());
    for (let i = 0; i < lines.length; i += 2000) {
        await models.nri_billing_lines.bulkCreate(lines.slice(i, i + 2000), tx());
    }
    res.status(prior ? 200 : 201).json(payload);
};

/** PATCH /files/:id { locked } — mark a file booked in NetSuite (or reopen it). */
exports.updateFile = async (req, res) => {
    const f = await models.nri_billing_files.findByPk(req.params.id, tx());
    if (!f) return res.status(404).json({ error: 'File not found.' });
    if (typeof req.body.locked === 'boolean') f.locked = req.body.locked;
    await f.save(tx());
    res.json(fileRow(f.get({ plain: true })));
};

exports.removeFile = async (req, res) => {
    const f = await models.nri_billing_files.findByPk(req.params.id, { raw: true, ...tx() });
    if (!f) return res.status(404).json({ error: 'File not found.' });
    if (f.locked) return res.status(409).json({ error: 'locked', message: 'This file is marked as booked. Unlock it before deleting.' });
    await models.nri_billing_lines.destroy({ where: { fileId: f.id }, ...tx() });
    await models.nri_billing_files.destroy({ where: { id: f.id }, ...tx() });
    res.json({ deleted: f.id, lines: Number(f.lineCount) });
};

/** GET /files/:id/original — the file exactly as NRI sent it. */
exports.downloadOriginal = async (req, res) => {
    const f = await models.nri_billing_files.findByPk(req.params.id, { raw: true });
    if (!f || !f.storedPath) return res.status(404).json({ error: 'No original file is stored for this upload.' });
    const abs = path.resolve(path.join(__dirname, '..', '..'), f.storedPath);
    if (!abs.startsWith(path.resolve(STORE_DIR)) || !fs.existsSync(abs)) {
        return res.status(404).json({ error: 'The original file is missing from storage.' });
    }
    res.download(abs, f.fileName);
};

// ─── Results ─────────────────────────────────────────────────────────────────

async function codedFor(entity, q) {
    const { all, chosen } = await selectFiles(entity, q);
    const ctx = await context(entity);
    const lines = await loadLines(chosen.map((f) => f.id));
    const locked = new Set(chosen.filter((f) => f.locked).map((f) => f.id));
    return { all, chosen, ctx, coded: codeAll(lines, entity, ctx, locked, monthsOf(chosen)) };
}

/** GET /results?entity=CA&files=a,b | &month=YYYY-MM — cost per GL by channel. */
exports.results = async (req, res) => {
    const entity = entityOf(req.query.entity);
    const { all, chosen, ctx, coded } = await codedFor(entity, req.query);

    const sum = (k) => svc.round2(coded.reduce((s, l) => s + l[k], 0));
    const classSources = {};
    const flags = {};
    for (const l of coded) {
        const k = l.classSource.startsWith('rule:') ? 'rule' : l.classSource;
        classSources[k] = classSources[k] || { lines: 0, charges: 0 };
        classSources[k].lines++;
        classSources[k].charges += l.charges;
        for (const f of l.flags) flags[f] = (flags[f] || 0) + 1;
    }
    for (const v of Object.values(classSources)) v.charges = svc.round2(v.charges);

    // per-file totals from the LINES, so the list beside the pivot cannot disagree with it
    const perFile = new Map(chosen.map((f) => [f.id, { charges: 0, lines: 0 }]));
    for (const l of coded) { const p = perFile.get(l.fileId); p.charges += l.charges; p.lines++; }

    res.json({
        entity,
        files: all,
        selected: chosen.map((f) => ({ ...f, charges: svc.round2(perFile.get(f.id).charges), lineCount: perFile.get(f.id).lines })),
        totals: { lines: coded.length, charges: sum('charges'), taxes: sum('taxes'), invAmt: sum('invAmt') },
        pivot: svc.glByClass(coded),
        rateCheck: { ...svc.rateSummary(coded), buckets: svc.rateBuckets(coded) },
        classSources,
        flags,
        duplicates: svc.duplicateFiles(coded).map((p) => ({
            ...p,
            aName: chosen.find((f) => f.id === p.a)?.fileName,
            bName: chosen.find((f) => f.id === p.b)?.fileName,
        })),
        cardLoaded: ctx.cardLoaded,
        orderDataRows: ctx.orderTypes.size,
        rules: ctx.rules.filter((r) => r.enabled).map((r) => ({ id: r.id, name: r.name, setClass: r.setClass })),
        // choices for the override pickers: every class the legend or the lines
        // use, and every GL the legend can describe
        classes: [...new Set([
            ...[...ctx.legend.byService.values()].map((m) => m.class),
            ...coded.map((l) => l.revisedClass),
            ...(entity === 'CA' ? ['CA - Whsle', 'CA - Online'] : ['US - Whsle', 'US - Online']),
        ].filter(Boolean))].sort(),
        glOptions: [...ctx.legend.descByGl].map(([gl, glDesc]) => ({ gl, glDesc })).sort((a, b) => a.gl - b.gl),
    });
};

const LINE_FIELDS = ['id', 'fileId', 'seq', 'orderId', 'clientRef1', 'clientRef2', 'customer', 'poNumber',
    'docDate', 'completed', 'units', 'value', 'service', 'charges', 'taxes', 'invAmt',
    'netsuiteGl', 'description', 'defaultClass', 'classOverride', 'glOverride',
    'revisedClass', 'revisedGl', 'revisedGlDesc', 'month', 'orderType', 'classSource', 'glSource', 'flags', 'rateCheck'];
const pick = (l) => Object.fromEntries(LINE_FIELDS.map((k) => [k, l[k]]));

/** GET /lines?entity&files|month&gl&cls&service&verdict&flag&q&page&pageSize — the drill-down. */
exports.lines = async (req, res) => {
    const entity = entityOf(req.query.entity);
    const { chosen, coded } = await codedFor(entity, req.query);
    const match = coded.filter(svc.lineFilter(req.query));
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 100, 1), 500);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const names = new Map(chosen.map((f) => [f.id, f.fileName]));
    res.json({
        total: match.length,
        charges: svc.round2(match.reduce((s, l) => s + l.charges, 0)),
        page, pageSize,
        lines: match.slice((page - 1) * pageSize, page * pageSize).map((l) => ({ ...pick(l), fileName: names.get(l.fileId) })),
    });
};

/**
 * PUT /lines/override { entity, files|month, filter | lineIds, classOverride?, glOverride? }
 *
 * The workbook's two manual columns. Applies to the listed `lineIds`, or to
 * EVERY line matching `filter` (the same filter the drill-down shows — "set all
 * of this cell to CA - Online" is how the team actually codes a file). A key
 * that is present with `null` CLEARS that override; an absent key leaves it.
 * Lines in a booked (locked) file are refused, not skipped — a partial write on
 * a booked month is the one outcome nobody wants.
 */
exports.setOverride = async (req, res) => {
    const b = req.body || {};
    const entity = entityOf(b.entity);
    const patch = {};
    if ('classOverride' in b) patch.classOverride = norm(b.classOverride) || null;
    if ('glOverride' in b) patch.glOverride = b.glOverride === null || b.glOverride === '' ? null : Number(b.glOverride);
    if (!Object.keys(patch).length) return badRequest(res, 'Nothing to set: send classOverride and/or glOverride (null clears).');
    if (patch.glOverride !== undefined && patch.glOverride !== null) {
        const codes = await models.nri_charge_codes.read();
        if (!codes.some((c) => Number(c.gl) === patch.glOverride)) {
            return badRequest(res, `GL ${patch.glOverride} is not in the coding legend, so it would have no description.`);
        }
    }

    const { chosen, coded } = await codedFor(entity, { files: b.files, month: b.month });
    let target;
    if (Array.isArray(b.lineIds) && b.lineIds.length) {
        const want = new Set(b.lineIds.map(String));
        target = coded.filter((l) => want.has(l.id));
    } else if (b.filter && typeof b.filter === 'object') {
        target = coded.filter(svc.lineFilter(b.filter));
    } else {
        return badRequest(res, 'Say which lines: lineIds, or a filter.');
    }
    if (!target.length) return badRequest(res, 'No lines match.');

    const lockedIds = new Set(chosen.filter((f) => f.locked).map((f) => f.id));
    const blocked = target.filter((l) => lockedIds.has(l.fileId));
    if (blocked.length) {
        return res.status(409).json({
            error: 'locked',
            message: `${blocked.length} of these lines belong to a booked file. Unlock it on the Uploads page first.`,
        });
    }

    const ids = target.map((l) => l.id);
    for (let i = 0; i < ids.length; i += 5000) {
        await models.nri_billing_lines.update(patch, { where: { id: { [Op.in]: ids.slice(i, i + 5000) } }, ...tx() });
    }
    res.json({ updated: ids.length, charges: svc.round2(target.reduce((s, l) => s + l.charges, 0)), patch });
};

// ─── Channel rules ───────────────────────────────────────────────────────────

/**
 * Validate and normalise one rule from the client; throws a 400 naming what is
 * wrong. express-validator checks the envelope; this checks the nested shape.
 */
function normalizeRule(r, i) {
    const bad = (msg) => { const e = new Error(`Rule ${i + 1}: ${msg}`); e.status = 400; throw e; };
    if (!r || typeof r !== 'object') bad('is not an object.');
    const name = norm(r.name);
    if (!name) bad('needs a name.');
    const setClass = norm(r.setClass);
    if (!setClass) bad('needs the channel it sets.');
    const kind = norm(r.kind) || 'custom';
    if (!svc.RULE_KINDS.includes(kind)) bad(`has an unknown kind "${kind}".`);
    if (!Array.isArray(r.conditions) || !r.conditions.length) bad('needs at least one condition.');
    // the two page-managed kinds have a fixed shape — one "is" condition on one field
    const fixed = { orderType: 'orderType', serviceColumn: 'service' }[kind];
    if (fixed && (r.conditions.length !== 1 || r.conditions[0].field !== fixed || r.conditions[0].op !== 'is')) {
        bad(kind === 'orderType' ? 'an order-type column must be one "Order type is …" condition.' : 'a service column must be one "NRI service is …" condition.');
    }
    // an EMPTY column is a real state (everything dragged out of it) — it is
    // simply not stored, rather than refused
    if (fixed && !(r.conditions[0].values || []).map(norm).filter(Boolean).length) return null;
    const conditions = r.conditions.map((c, j) => {
        if (!svc.RULE_FIELDS.includes(c && c.field)) bad(`condition ${j + 1} tests an unknown field "${c && c.field}".`);
        if (!svc.RULE_OPS.includes(c.op)) bad(`condition ${j + 1} has an unknown test "${c.op}".`);
        const values = (Array.isArray(c.values) ? c.values : []).map(norm).filter(Boolean);
        if (!values.length) bad(`condition ${j + 1} has no values.`);
        return { field: c.field, op: c.op, values: [...new Set(values)] };
    });
    return { kind, name: name.slice(0, 120), enabled: r.enabled !== false, conditions, setClass: setClass.slice(0, 60) };
}

/**
 * GET /rules?entity=CA — the rules, each with what it does:
 *   live    lines it codes NOW (files not Booked, no manual override)
 *   ifOpen  lines it WOULD code if every file were open — the impact preview,
 *           since every 2026 CA file is Booked and "live" alone reads zero
 *   changes of those, how many it moves off the legend's default channel
 */
exports.getRules = async (req, res) => {
    const entity = entityOf(req.query.entity);
    const { all } = await selectFiles(entity, {});
    const ctx = await context(entity);
    // the SERVICE COLUMNS are by period-end month (default: the latest month with files)
    const fileMonth = monthsOf(all);
    const withFiles = [...new Set([...fileMonth.values()].filter(Boolean))].sort();
    const latest = withFiles[withFiles.length - 1] || new Date().toISOString().slice(0, 7);
    const month = MONTH_RE.test(norm(req.query.month)) ? norm(req.query.month) : latest;
    const resolver = svc.ruleMonthResolver(ctx.rules);
    const inForce = resolver(month);
    const savedMonths = resolver.months;
    const lines = await loadLines(all.map((f) => f.id));
    const locked = new Set(all.filter((f) => f.locked).map((f) => f.id));
    const tally = (coded) => {
        const m = {};
        for (const l of coded) {
            if (!l.ruleId) continue;
            const t = (m[l.ruleId] = m[l.ruleId] || { lines: 0, charges: 0, changes: 0, changedCharges: 0 });
            t.lines++;
            t.charges += l.charges;
            if (l.revisedClass !== l.defaultClass) { t.changes++; t.changedCharges += l.charges; }
        }
        for (const t of Object.values(m)) { t.charges = svc.round2(t.charges); t.changedCharges = svc.round2(t.changedCharges); }
        return m;
    };
    const coder = (lockedFiles) => svc.buildCoder({ entity, legend: ctx.legend, orderTypes: ctx.orderTypes, lockedFiles, rules: ctx.rules, glRules: ctx.glRules, fileMonths: monthsOf(all) });
    const live = tally(lines.map(coder(locked)));
    const ifOpen = tally(lines.map(coder(new Set())));
    const zero = { lines: 0, charges: 0, changes: 0, changedCharges: 0 };
    res.json({
        entity,
        fields: svc.RULE_FIELDS,
        ops: svc.RULE_OPS,
        files: { total: all.length, booked: locked.size },
        classes: [...new Set([
            ...[...ctx.legend.byService.values()].map((m) => m.class),
            ...(entity === 'CA' ? ['CA - Whsle', 'CA - Online'] : ['US - Whsle', 'US - Online']),
        ].filter(Boolean))].sort(),
        // values seen in the data, offered as picks instead of typing
        suggestions: {
            orderType: [...new Set([...ctx.orderTypes.values()].filter(Boolean))].sort(),
            service: [...new Set(lines.map((l) => l.service))].sort(),
        },
        // every rule IN FORCE for the month — each section resolved on its own
        rules: inForce.all.map((r) => ({ ...r, live: live[r.id] || zero, ifOpen: ifOpen[r.id] || zero })),
        services: serviceCards(lines, ctx),
        monthInfo: {
            month,
            // per section: set for this month, inherited from an earlier one, or the starting rules
            sections: Object.fromEntries(svc.RULE_KINDS.map((k) => {
                const from = inForce.from[k];
                return [k, { source: from === month ? 'own' : from ? 'inherited' : 'base', inheritedFrom: from && from !== month ? from : null }];
            })),
            months: [...new Set([...withFiles, nextMonth(latest), ...savedMonths])].sort().map((m) => {
                const inMonth = all.filter((f) => fileMonth.get(f.id) === m);
                return { month: m, files: inMonth.length, booked: inMonth.filter((f) => f.locked).length, saved: savedMonths.includes(m) };
            }),
        },
    });
};

/**
 * One card per NRI service for the two columns: just the service and the coding
 * legend's default channel (where an unplaced service sits). The page is for
 * GENERAL rules, so it deliberately carries no money or line counts.
 * Every service billed so far plus every service the legend knows.
 */
function serviceCards(lines, ctx) {
    const by = new Map();
    const add = (name) => {
        const k = norm(name).toLowerCase();
        if (!k || by.has(k)) return;
        by.set(k, { service: norm(name), defaultClass: ctx.legend.byService.get(k)?.class ?? null });
    };
    for (const l of lines) add(l.service);
    for (const k of ctx.legend.byService.keys()) add(ctx.serviceNames.get(k) || k);
    // a service ADDED on GL Codes (not billed yet, not in the legend) gets a card too,
    // so its channel can be set before its first invoice
    for (const r of ctx.glRules) add(r.service);
    return [...by.values()].sort((x, y) => x.service.localeCompare(y.service));
}

/** PUT /rules { entity, rules: [...] } — replaces the entity's rules, in order. */
exports.saveRules = async (req, res) => {
    const entity = entityOf(req.body.entity);
    // the service columns are saved FOR A MONTH (null = the base columns); order-type
    // and exception rules are the same for every month
    const month = req.body.month ? norm(req.body.month) : null;
    if (month && !MONTH_RE.test(month)) return badRequest(res, "'month' must be YYYY-MM.");
    // which SECTIONS to write for the month — only those the user changed, so editing
    // an exception never gives the month its own order-type or service columns
    const saveKinds = Array.isArray(req.body.saveKinds)
        ? req.body.saveKinds.filter((k) => svc.RULE_KINDS.includes(k))
        : svc.RULE_KINDS;
    if (!saveKinds.length) return badRequest(res, 'Nothing to save.');
    let clean;
    try {
        clean = (req.body.rules || []).map(normalizeRule).filter(Boolean)
            .filter((r) => saveKinds.includes(r.kind));
        // both two-column steps: a value (an order type, a service) sits in ONE column only
        for (const kind of ['orderType', 'serviceColumn']) {
            const seen = new Map();
            for (const r of clean.filter((x) => x.kind === kind)) {
                for (const v of r.conditions[0].values) {
                    const k = v.toLowerCase();
                    if (seen.has(k) && seen.get(k) !== r.setClass) {
                        return res.status(400).json({ error: `"${v}" is in both the ${seen.get(k)} and ${r.setClass} columns.` });
                    }
                    seen.set(k, r.setClass);
                }
            }
        }
        // the evaluation order is fixed by kind; position only orders within a kind
        clean = clean.map((r, i) => ({ r, i }))
            .sort((a, b) => svc.kindRank(a.r.kind) - svc.kindRank(b.r.kind) || a.i - b.i)
            .map((x) => x.r);
    } catch (e) {
        return res.status(e.status || 400).json({ error: e.message });
    }
    const now = new Date().toISOString();
    const tag = month || 'base';
    const by = (req.user && req.user.email) || null;
    const rows = clean.map((r, i) => ({
        ...r, month, entity, seq: i + 1,
        id: `ncr_${entity.toLowerCase()}_${tag}_${r.kind}_${i + 1}`,
        updatedAt: now, updatedBy: by,
    }));
    // a section saved EMPTY (e.g. every exception removed for this month) is stored
    // as one placeholder, so the month does not fall back to inheriting
    for (const k of saveKinds) {
        if (rows.some((r) => r.kind === k)) continue;
        rows.push({
            id: `ncr_${entity.toLowerCase()}_${tag}_${k}_empty`, entity, month, seq: 0, kind: k,
            name: svc.EMPTY_SET, enabled: false, conditions: [], setClass: '', updatedAt: now, updatedBy: by,
        });
    }
    // replace THIS month's rows of the saved sections; every other month stays
    await models.nri_class_rules.destroy({ where: { entity, kind: saveKinds, month }, ...tx() });
    await models.nri_class_rules.bulkCreate(rows, tx());
    res.json({ entity, month, sections: saveKinds, saved: rows.filter((r) => r.name !== svc.EMPTY_SET).length });
};

/** DELETE /rules/month?entity=CA&month=YYYY-MM — drop everything set for a month; it inherits again. */
exports.clearRuleMonth = async (req, res) => {
    const entity = entityOf(req.query.entity);
    const month = norm(req.query.month);
    if (!MONTH_RE.test(month)) return badRequest(res, "'month' must be YYYY-MM.");
    const n = await models.nri_class_rules.destroy({ where: { entity, month }, ...tx() });
    res.json({ entity, month, removed: n });
};

// ─── GL Codes: which GL each NRI service posts to, by month ──────────────────

/**
 * GET /gl-codes?entity=CA&month=YYYY-MM — the GL each NRI service posts to in one
 * PERIOD-END MONTH (default: the latest month with files).
 *
 * Per service: the coding legend's GL (what Booked files are coded by), the GL in
 * force for the month (its own settings, else the latest earlier month's, else the
 * legend — `source` says which), lines billed in that month's files, and how many
 * the team recoded BY HAND to another GL. `months` lists every month with files plus
 * the next one, so a change can be set up before its invoice arrives.
 */
exports.getGlCodes = async (req, res) => {
    const entity = entityOf(req.query.entity);
    const { all } = await selectFiles(entity, {});
    const ctx = await context(entity);
    const fileMonth = monthsOf(all);
    const withFiles = [...new Set([...fileMonth.values()].filter(Boolean))].sort();
    const latest = withFiles[withFiles.length - 1] || new Date().toISOString().slice(0, 7);
    const saved = [...new Set(ctx.glRules.map((r) => r.month))].sort();
    const monthList = [...new Set([...withFiles, nextMonth(latest), ...saved])].sort();
    const month = MONTH_RE.test(norm(req.query.month)) ? norm(req.query.month) : latest;

    const resolve = svc.glMonthResolver(ctx.glRules);
    const inForce = resolve(month);                         // { from, map } | null
    const own = ctx.glRules.filter((r) => r.month === month);
    const meta = own[0] || null;

    const files = all.filter((f) => fileMonth.get(f.id) === month);
    const lines = await loadLines(files.map((f) => f.id));

    const rows = new Map();
    const row = (name) => {
        const k = norm(name).toLowerCase();
        if (!rows.has(k)) {
            const m = ctx.legend.byService.get(k) || null;
            const set = inForce ? inForce.map.get(k) : undefined;
            rows.set(k, {
                service: ctx.serviceNames.get(k) || norm(name),
                legendGl: m ? m.gl : null,
                legendDesc: m ? m.description : null,
                gl: set !== undefined ? set : (m ? m.gl : null),   // the GL in force this month
                // the GL on a WHOLESALE ORDER, where it differs (null = same as `gl`)
                glWholesaleOrder: inForce && inForce.whsle.has(k) ? inForce.whsle.get(k) : null,
                lines: 0,
                handRecoded: 0,
                handTo: {},
            });
        }
        return rows.get(k);
    };
    for (const k of ctx.legend.byService.keys()) row(ctx.serviceNames.get(k) || k);
    // services the month's own / inherited settings name (e.g. one ADDED on this page) —
    // not every month's, or a service added for October would read "no GL" in September
    if (inForce) for (const k of inForce.map.keys()) row(ctx.serviceNames.get(k) || ctx.glRules.find((r) => norm(r.service).toLowerCase() === k)?.service || k);
    for (const l of lines) {
        const r = row(l.service);
        r.lines++;
        if (l.glOverride !== null && l.glOverride !== r.gl) {
            r.handRecoded++;
            r.handTo[l.glOverride] = (r.handTo[l.glOverride] || 0) + 1;
        }
    }
    res.json({
        entity,
        month,
        months: monthList.map((m) => {
            const inMonth = all.filter((f) => fileMonth.get(f.id) === m);
            return { month: m, files: inMonth.length, booked: inMonth.filter((f) => f.locked).length, saved: saved.includes(m) };
        }),
        // where this month's GLs come from: its own settings, an earlier month's, or the legend
        source: inForce ? (inForce.from === month ? 'own' : 'inherited') : 'legend',
        inheritedFrom: inForce && inForce.from !== month ? inForce.from : null,
        savedAt: meta ? meta.updatedAt : null,
        savedBy: meta ? meta.updatedBy : null,
        files: { total: files.length, booked: files.filter((f) => f.locked).length, names: files.map((f) => f.fileName), ids: files.map((f) => f.id) },
        glOptions: [...ctx.legend.descByGl].map(([gl, glDesc]) => ({ gl, glDesc })).sort((x, y) => x.gl - y.gl),
        // services with no GL at all first — they are the ones that need a decision
        services: [...rows.values()].sort((x, y) => {
            const noGl = (r) => (r.gl === null ? 0 : 1);
            return noGl(x) - noGl(y) || x.service.localeCompare(y.service);
        }),
    });
};

/**
 * PUT /gl-codes { entity, month, services: [{ service, gl, glWholesaleOrder? }] } — save the month's
 * COMPLETE service → GL list (it carries forward to later months until another
 * month is saved). gl null = the legend's GL. A GL the legend cannot describe is
 * refused, so every posted line keeps a GL description.
 */
exports.saveGlCodes = async (req, res) => {
    const entity = entityOf(req.body.entity);
    const month = norm(req.body.month);
    if (!MONTH_RE.test(month)) return badRequest(res, "'month' must be YYYY-MM.");
    const codes = await models.nri_charge_codes.read();
    const legend = svc.legendIndex(codes, entity);
    const rows = [];
    const seen = new Set();
    for (const [i, x] of (req.body.services || []).entries()) {
        const service = norm(x && x.service);
        if (!service) return badRequest(res, `Row ${i + 1} has no service.`);
        if (seen.has(service.toLowerCase())) return badRequest(res, `"${service}" is listed twice.`);
        seen.add(service.toLowerCase());
        const base = legend.byService.get(service.toLowerCase());
        const gl = x && x.gl !== null && x.gl !== undefined && x.gl !== '' ? Number(x.gl) : (base ? base.gl : null);
        if (gl === null) continue;   // not in the legend and no GL chosen — stays uncoded
        if (!Number.isInteger(gl) || !legend.descByGl.has(gl)) {
            return badRequest(res, `GL ${x.gl} for "${service}" is not in the coding legend, so it would have no description.`);
        }
        const w = x && x.glWholesaleOrder !== null && x.glWholesaleOrder !== undefined && x.glWholesaleOrder !== '' ? Number(x.glWholesaleOrder) : null;
        if (w !== null && (!Number.isInteger(w) || !legend.descByGl.has(w))) {
            return badRequest(res, `GL ${x.glWholesaleOrder} (wholesale orders) for "${service}" is not in the coding legend.`);
        }
        rows.push({ service, gl, glWholesaleOrder: w !== null && w !== gl ? w : null });
    }
    const now = new Date().toISOString();
    await models.nri_gl_rules.destroy({ where: { entity, month }, ...tx() });
    await models.nri_gl_rules.bulkCreate(rows.map((r, i) => ({
        ...r, id: `ngr_${entity.toLowerCase()}_${month}_${i + 1}`, entity, month, updatedAt: now, updatedBy: req.user?.email || null,
    })), tx());
    res.json({ entity, month, saved: rows.length });
};

/** DELETE /gl-codes?entity=CA&month=YYYY-MM — drop a month's own settings; it inherits again. */
exports.clearGlCodes = async (req, res) => {
    const entity = entityOf(req.query.entity);
    const month = norm(req.query.month);
    if (!MONTH_RE.test(month)) return badRequest(res, "'month' must be YYYY-MM.");
    const n = await models.nri_gl_rules.destroy({ where: { entity, month }, ...tx() });
    res.json({ entity, month, removed: n });
};

// ─── Review after upload: confirm each service's channel + GL for the month ──

/** The in-force service → side and service → GL maps for a month, with where each came from. */
function monthSettings(ctx, month) {
    const r = svc.ruleMonthResolver(ctx.rules)(month);
    const g = svc.glMonthResolver(ctx.glRules)(month);
    const online = (cls) => /online/i.test(cls || '');
    const side = new Map();
    for (const rule of r.rules.filter((x) => x.kind === 'serviceColumn')) {
        for (const v of rule.conditions[0]?.values || []) side.set(norm(v).toLowerCase(), online(rule.setClass) ? 'online' : 'whsle');
    }
    return {
        side, sideFrom: r.from.serviceColumn,
        gl: g ? g.map : new Map(), glFrom: g ? g.from : null,
    };
}

/**
 * How each service was set, month by month, up to and including `month` — from the
 * months that saved their OWN settings (the starting rules are a default, not a
 * decision, so they are left out). Returns service key → runs of equal values,
 * oldest first: [{ from:'2026-02', to:'2026-07', value:'whsle' }, …].
 */
function settingHistory(ctx, month) {
    const runs = (byMonth) => {
        const out = new Map();
        for (const [k, perMonth] of byMonth) {
            const list = [];
            for (const [m, value] of [...perMonth].sort(([a], [b]) => a.localeCompare(b))) {
                const last = list[list.length - 1];
                if (last && last.value === value) last.to = m; else list.push({ from: m, to: m, value });
            }
            out.set(k, list);
        }
        return out;
    };
    const put = (map, k, m, v) => { if (!map.has(k)) map.set(k, new Map()); map.get(k).set(m, v); };
    const sides = new Map();
    for (const r of ctx.rules) {
        if (r.kind !== 'serviceColumn' || !r.month || r.month > month || r.name === svc.EMPTY_SET) continue;
        for (const v of r.conditions[0]?.values || []) put(sides, norm(v).toLowerCase(), r.month, /online/i.test(r.setClass || '') ? 'online' : 'whsle');
    }
    const gls = new Map();
    for (const r of ctx.glRules) {
        if (!r.month || r.month > month) continue;
        put(gls, norm(r.service).toLowerCase(), r.month, Number(r.gl));
    }
    return { channel: runs(sides), gl: runs(gls) };
}

/**
 * The lines the portal is NOT SURE about, grouped into questions for the uploader
 * (Lam, 2026-10-05: "if not sure, portal need to ask users"). An answer becomes a
 * hand coding on exactly those lines — a one-off, never a month setting.
 *   channel  the line quotes an order (IF / RMA / web order / PO) and the portal
 *            cannot find its order type — NetSuite does not have it, or it carries
 *            none. Grouped by Client Ref 1: one order, one answer.
 *   gl       a wholesale line of a service with a GL for wholesale orders (GL Codes),
 *            but no order behind it — fulfilment work, or an extra charge?
 *            Grouped by service + Client Ref 1.
 */
const ASK_FLAGS = ['orderNotFound', 'orderNoType', 'glWholesaleAsk'];
function questionsFor(coded, ctx, month) {
    const whsle = (svc.glMonthResolver(ctx.glRules)(month) || { whsle: new Map() }).whsle;
    const by = new Map();
    for (const l of coded) {
        const flag = l.flags.find((f) => ASK_FLAGS.includes(f));
        if (!flag) continue;
        const ref = norm(l.clientRef1) || '(blank)';
        const kind = flag === 'glWholesaleAsk' ? 'gl' : 'channel';
        const key = kind === 'gl' ? `gl:${norm(l.service).toLowerCase()}|${ref}` : `channel:${ref}`;
        const q = by.get(key) || {
            key, kind, ref, why: flag,
            clientRef2: norm(l.clientRef2) || null, customer: norm(l.customer) || null,
            services: [], lineIds: [], lines: 0, charges: 0,
            channel: /online/i.test(l.revisedClass || '') ? 'online' : 'whsle',   // what the portal used meanwhile
            gl: l.revisedGl,
            glWholesaleOrder: kind === 'gl' ? whsle.get(norm(l.service).toLowerCase()) ?? null : null,
        };
        if (!q.services.includes(l.service)) q.services.push(l.service);
        q.lineIds.push(l.id);
        q.lines++;
        q.charges += l.charges;
        by.set(key, q);
    }
    return [...by.values()]
        .map((q) => ({ ...q, charges: svc.round2(q.charges) }))
        .sort((a, b) => a.kind.localeCompare(b.kind) || b.charges - a.charges);
}

/**
 * GET /files/:id/review — every NRI service on this invoice with the channel and GL
 * the portal will use for it (the HINT), and where that hint comes from, so the
 * uploader confirms or corrects before relying on the Cost per GL.
 *
 * Channel here is the SERVICE COLUMN (step 2) — it only decides the lines that have
 * no order type and match no exception; `byOrder` says how many lines step 1 or an
 * exception decide instead, so nobody thinks the column re-codes them.
 *
 * `check` lists why a service needs a person (Lam, 2026-10-02 — "quite a lot of
 * things to verify"); a service with none is decided and the popup folds it away:
 *   'noGl'           no GL anywhere — must be picked
 *   'channelVaries'  lines the service column decides, and the team has put this
 *                    service on BOTH sides in earlier months
 *   'channelNew'     lines the service column decides, and no month has ever set it
 *   'glVaries'       the team has posted this service to more than one GL
 * On Sept 15 that is 2–3 services of 28; the other ~12,470 lines follow NetSuite,
 * an exception, or a setting that has never changed.
 */
exports.fileReview = async (req, res) => {
    const f = await models.nri_billing_files.findByPk(req.params.id, { raw: true });
    if (!f) return res.status(404).json({ error: 'File not found.' });
    const entity = f.entity;
    const month = f.periodEnd ? String(f.periodEnd).slice(0, 7) : null;
    const ctx = await context(entity);
    const lines = await loadLines([f.id]);
    const coded = codeAll(lines, entity, ctx, new Set(), new Map([[f.id, month]]));
    const kindOf = new Map(ctx.rules.map((r) => [r.id, r.kind]));
    const set = monthSettings(ctx, month);
    const hist = settingHistory(ctx, month || '9999-12');

    const by = new Map();
    for (const l of coded) {
        const k = norm(l.service).toLowerCase();
        const r = by.get(k) || { service: l.service, lines: 0, charges: 0, byOrder: 0, refsColumn: new Map(), refsAll: new Map() };
        r.lines++;
        r.charges += l.charges;
        const kind = l.ruleId ? kindOf.get(l.ruleId) : null;
        const decidedByRef = kind === 'orderType' || kind === 'custom';
        if (decidedByRef) r.byOrder++;
        // the Client Ref 1s behind the row — those the channel toggle decides come first
        const ref = norm(l.clientRef1) || '(blank)';
        for (const m of decidedByRef ? [r.refsAll] : [r.refsColumn, r.refsAll]) m.set(ref, (m.get(ref) || 0) + l.charges);
        by.set(k, r);
    }
    const services = [...by.entries()].map(([k, r]) => {
        const m = ctx.legend.byService.get(k) || null;
        const pageSide = set.side.get(k);
        const pageGl = set.gl.get(k);
        const gl = pageGl !== undefined ? pageGl : (m ? m.gl : null);
        const channelRuns = hist.channel.get(k) || [];
        const glRuns = hist.gl.get(k) || [];
        const byColumn = r.lines - r.byOrder;
        const check = [];
        if (gl === null) check.push('noGl');
        if (byColumn > 0 && new Set(channelRuns.map((x) => x.value)).size > 1) check.push('channelVaries');
        if (byColumn > 0 && !channelRuns.length && !pageSide && !m) check.push('channelNew');
        if (new Set(glRuns.map((x) => x.value)).size > 1) check.push('glVaries');
        const refs = [...(r.refsColumn.size ? r.refsColumn : r.refsAll)].sort((x, y) => y[1] - x[1]);
        return {
            references: refs.slice(0, 5).map(([x]) => x),
            referenceCount: refs.length,
            service: ctx.serviceNames.get(k) || r.service,
            lines: r.lines,
            charges: svc.round2(r.charges),
            byOrder: r.byOrder,
            channel: pageSide || (m && /online/i.test(m.class || '') ? 'online' : 'whsle'),
            channelHint: pageSide ? (set.sideFrom === month ? 'own' : set.sideFrom ? `from:${set.sideFrom}` : 'starting') : 'legend',
            gl,
            glHint: pageGl !== undefined ? (set.glFrom === month ? 'own' : `from:${set.glFrom}`) : (m ? 'legend' : 'none'),
            legendGl: m ? m.gl : null,
            check,
            channelHistory: channelRuns,
            glHistory: glRuns,
        };
    }).sort((a, b) => (a.gl === null ? 0 : 1) - (b.gl === null ? 0 : 1) || b.check.length - a.check.length || b.charges - a.charges);

    res.json({
        file: fileRow(f),
        month,
        locked: !!f.locked,
        services,
        questions: questionsFor(coded, ctx, month),
        glOptions: [...ctx.legend.descByGl].map(([gl, glDesc]) => ({ gl, glDesc })).sort((a, b) => a.gl - b.gl),
    });
};

/**
 * POST /files/:id/confirm { services: [{ service, channel: 'whsle'|'online', gl }],
 *                          answers: [{ lineIds, channel?, gl? }] }   — one per review question
 *
 * The uploader's answers are MERGED into the month's settings: only when a service's
 * channel or GL differs from what is in force is the month given its own service
 * columns / GL list (written whole, so it carries forward like any save). A service
 * with no GL is refused. Then the file is stamped confirmed.
 */
exports.confirmFile = async (req, res) => {
    const f = await models.nri_billing_files.findByPk(req.params.id, { raw: true, ...tx() });
    if (!f) return res.status(404).json({ error: 'File not found.' });
    if (f.locked) return res.status(409).json({ error: 'locked', message: 'This file is marked as booked — its coding is fixed. Reopen it on Uploads to review it.' });
    const entity = f.entity;
    const month = f.periodEnd ? String(f.periodEnd).slice(0, 7) : null;
    if (!MONTH_RE.test(month || '')) return badRequest(res, 'This file has no period-end month.');
    const ctx = await context(entity);
    const set = monthSettings(ctx, month);
    const classes = [...new Set([...ctx.legend.byService.values()].map((m) => m.class).filter(Boolean))];
    const ONLINE = classes.find((c) => /online/i.test(c)) || `${entity} - Online`;
    const WHSLE = classes.find((c) => /whsle/i.test(c)) || `${entity} - Whsle`;

    // the month's full lists as they stand (legend fills what no setting names)
    const sides = new Map();
    const gls = new Map();
    const names = new Map();
    for (const [k, m] of ctx.legend.byService) {
        names.set(k, ctx.serviceNames.get(k) || k);
        sides.set(k, /online/i.test(m.class || '') ? 'online' : 'whsle');
        if (m.gl !== null) gls.set(k, m.gl);
    }
    for (const [k, v] of set.side) { sides.set(k, v); if (!names.has(k)) names.set(k, k); }
    for (const [k, v] of set.gl) { gls.set(k, v); if (!names.has(k)) names.set(k, k); }
    for (const r of ctx.glRules) { const k = norm(r.service).toLowerCase(); if (!names.has(k) || names.get(k) === k) names.set(k, norm(r.service)); }

    // the not-sure lines must ALL be answered — each answer is a hand coding on its lines
    const lines = await loadLines([f.id]);
    const coded = codeAll(lines, entity, ctx, new Set(), new Map([[f.id, month]]));
    const asked = new Set(questionsFor(coded, ctx, month).flatMap((q) => q.lineIds));
    const fileLineIds = new Set(lines.map((l) => l.id));
    const lineAnswers = [];
    for (const [i, a] of (Array.isArray(req.body.answers) ? req.body.answers : []).entries()) {
        const ids = (Array.isArray(a && a.lineIds) ? a.lineIds : []).map(norm).filter((id) => fileLineIds.has(id));
        if (!ids.length) return badRequest(res, `Answer ${i + 1} names no line of this file.`);
        const patch = {};
        if (a.channel !== undefined && a.channel !== null) {
            if (a.channel !== 'online' && a.channel !== 'whsle') return badRequest(res, `Answer ${i + 1}: channel must be whsle or online.`);
            patch.classOverride = a.channel === 'online' ? ONLINE : WHSLE;
        }
        if (a.gl !== undefined && a.gl !== null && a.gl !== '') {
            const g = Number(a.gl);
            if (!Number.isInteger(g) || !ctx.legend.descByGl.has(g)) return badRequest(res, `Answer ${i + 1}: GL ${a.gl} is not in the coding legend.`);
            patch.glOverride = g;
        }
        if (!Object.keys(patch).length) return badRequest(res, `Answer ${i + 1} sets nothing.`);
        lineAnswers.push({ ids, patch });
        ids.forEach((id) => asked.delete(id));
    }
    if (asked.size) {
        return res.status(400).json({ error: `${asked.size} line${asked.size === 1 ? '' : 's'} still need${asked.size === 1 ? 's' : ''} an answer — see "Questions" at the top of the review.` });
    }

    let channelChanged = 0;
    let glChanged = 0;
    for (const [i, x] of (req.body.services || []).entries()) {
        const service = norm(x && x.service);
        const k = service.toLowerCase();
        if (!service) return badRequest(res, `Row ${i + 1} has no service.`);
        if (!names.has(k)) names.set(k, service);
        const ch = x.channel === 'online' ? 'online' : x.channel === 'whsle' ? 'whsle' : null;
        if (!ch) return badRequest(res, `"${service}" needs a channel.`);
        const gl = x.gl === null || x.gl === undefined || x.gl === '' ? null : Number(x.gl);
        if (gl === null) return badRequest(res, `"${service}" has no GL — pick one before confirming.`);
        if (!Number.isInteger(gl) || !ctx.legend.descByGl.has(gl)) return badRequest(res, `GL ${x.gl} for "${service}" is not in the coding legend.`);
        if (sides.get(k) !== ch) { sides.set(k, ch); channelChanged++; }
        if (gls.get(k) !== gl) { gls.set(k, gl); glChanged++; }
    }

    const now = new Date().toISOString();
    const by = req.user?.email || null;
    if (channelChanged) {
        const list = (s) => [...sides].filter(([, v]) => v === s).map(([k]) => names.get(k)).sort();
        await models.nri_class_rules.destroy({ where: { entity, kind: 'serviceColumn', month }, ...tx() });
        const rows = [['whsle', WHSLE, 'Wholesale services'], ['online', ONLINE, 'Ecomm services']]
            .map(([s, cls, name], i) => ({
                id: `ncr_${entity.toLowerCase()}_${month}_serviceColumn_${i + 1}`, entity, month, seq: i + 1,
                kind: 'serviceColumn', enabled: true, setClass: cls, name,
                conditions: [{ field: 'service', op: 'is', values: list(s) }], updatedAt: now, updatedBy: by,
            }))
            .filter((r) => r.conditions[0].values.length);
        await models.nri_class_rules.bulkCreate(rows, tx());
    }
    if (glChanged) {
        // the month's GL list is rewritten whole — the wholesale-order GLs in force go with it
        const inForce = svc.glMonthResolver(ctx.glRules)(month);
        const whsle = inForce ? inForce.whsle : new Map();
        await models.nri_gl_rules.destroy({ where: { entity, month }, ...tx() });
        await models.nri_gl_rules.bulkCreate([...gls].map(([k, gl], i) => ({
            id: `ngr_${entity.toLowerCase()}_${month}_${i + 1}`, entity, month, service: names.get(k), gl,
            glWholesaleOrder: whsle.has(k) && whsle.get(k) !== gl ? whsle.get(k) : null, updatedAt: now, updatedBy: by,
        })), tx());
    }
    for (const a of lineAnswers) {
        await models.nri_billing_lines.update(a.patch, { where: { id: a.ids, fileId: f.id }, ...tx() });
    }
    await models.nri_billing_files.update({ confirmedAt: now, confirmedBy: by }, { where: { id: f.id }, ...tx() });
    res.json({ id: f.id, month, channelChanged, glChanged, answered: lineAnswers.reduce((n, a) => n + a.ids.length, 0), confirmedAt: now });
};
