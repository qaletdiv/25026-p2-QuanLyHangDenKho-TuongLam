'use strict';
/**
 * NRI invoice verification — controller.
 *
 * Flow: upload the detail xlsx (+ the invoice PDF) -> tie the detail to the
 * invoice -> code every line to a GL and class -> validate each line against the
 * rate agreement -> review the findings -> submit.
 *
 * Writes only this module's tables. Re-uploading an invoice REPLACES its lines
 * wholesale (never appends), and human overrides survive because they key on
 * (invoiceNo, seq) rather than a position in a combined table.
 */

const M = require('./NriInvoiceModels');
const { models } = require('../../models');
const parser = require('./invoiceParser');
const chargeCodes = require('./chargeCodes');
const rateCard = require('./rateCard');
const lineClass = require('./lineClass');
const orderData = require('./orderData');
const svc = require('./nriInvoiceService');
const sources = require('./invoiceSources');

const arr = v => (Array.isArray(v) ? v : []);
const norm = v => (v === undefined || v === null ? '' : String(v).trim());
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* -------------------------------------------------------- order master ----- */

// The CLASS depends on the order (channel x geography x marketplace), so the
// order master is a required input — not a nicety. Cached per process because it
// is ~33k rows; `POST /order-data/refresh` clears it.
let orderCache = null;

async function orderMaster(entity = 'US') {
  const ent = norm(entity).toUpperCase() || 'US';
  if (orderCache && orderCache[ent]) return orderCache[ent];
  const workbook = process.env.NRI_ORDER_DATA_WORKBOOK
    || require('path').join(__dirname, '..', '..', 'storage', 'reference', 'nri', 'NRI US_ALL Invoices 2026.xlsx');
  let master;
  try {
    // Rows uploaded through the UI are this warehouse's own, and they are ingested
    // last (they win) — see orderData.load.
    const stored = arr(await M.orderMaster.read().catch(() => []))
      .filter((r) => !r.entity || String(r.entity).toUpperCase() === ent);
    master = await orderData.load({
      workbook, stored,
      storedLabel: `uploaded in the portal (${stored.length} rows)`,
    });
  } catch (e) {
    // Never fail an upload over this: the class simply comes back unresolved,
    // which the reconcile reports rather than hiding.
    master = { byOrder: new Map(), sources: [{ label: 'load failed', error: e.message }], orders: 0, covers: null };
  }
  orderCache = { ...(orderCache || {}), [ent]: { master, index: lineClass.buildOrderIndex(master) } };
  return orderCache[ent];
}

// Which entity is being asked about (?warehouse=nri-us | ?entity=US).
async function entityOf(req) {
  const asked = norm(req.query?.warehouse) || norm(req.body?.warehouse)
    || norm(req.query?.entity) || norm(req.body?.entity) || 'US';
  const src = await sources.find(asked);
  return String(src?.entity || asked).toUpperCase();
}

exports.refreshOrderData = async (req, res) => {
  orderCache = null;
  const { master } = await orderMaster(await entityOf(req));
  res.json({ orders: master.orders, covers: master.covers, sources: master.sources });
};

exports.getOrderData = async (req, res) => {
  const ent = await entityOf(req);
  const { master } = await orderMaster(ent);
  const stored = arr(await M.orderMaster.read().catch(() => []))
    .filter((r) => !r.entity || String(r.entity).toUpperCase() === ent);
  res.json({
    entity: ent,
    orders: master.orders, covers: master.covers, sources: master.sources,
    storedRows: stored.length,
    csvDir: orderData.DEFAULT_CSV_DIR,
  });
};

/**
 * POST /nri-invoices/order-data   (multipart: file=<xlsx|csv>)
 *
 * The order master is the ONLY source of channel (`OrderType`) and ship-to
 * country — neither appears on an invoice line — so without it the class cannot
 * be derived and lines come back `needsClass`. Uploading it here replaces the
 * dependency on a mapped G: drive.
 *
 * Rows are UPSERTED by order number within the warehouse's entity: dropping in a
 * later period tops the master up instead of wiping the earlier one, which is what
 * "coverage is the limiting factor" demands.
 */
exports.uploadOrderData = async (req, res) => {
  const file = req.files?.file?.[0] || req.files?.detail?.[0];
  if (!file) return res.status(400).json({ error: 'An order-data file is required (field name "file") — the workbook\'s "NRI Order data" sheet, or a period CSV.' });
  const ent = await entityOf(req);

  let rows;
  try {
    rows = await orderData.parseUploaded(file.buffer, file.originalname);
  } catch (e) {
    return res.status(400).json({ error: `Could not read the order data: ${e.message}` });
  }
  if (!rows.length) {
    return res.status(400).json({
      error: 'No order rows found. The file needs an "Order #" column, plus "OrderType" and "Ship To Country" to be useful for coding.',
    });
  }

  const existing = arr(await M.orderMaster.read().catch(() => []));
  const byKey = new Map(existing.map((r) => [`${String(r.entity || 'US').toUpperCase()}|${String(r.orderNo || '').toUpperCase()}`, r]));
  let added = 0, updated = 0, skipped = 0;
  for (const r of rows) {
    const orderNo = norm(r.orderNo);
    if (!orderNo) { skipped++; continue; }
    const key = `${ent}|${orderNo.toUpperCase()}`;
    const row = {
      entity: ent,
      orderNo,
      ref2: norm(r.ref2) || null,
      custCode: norm(r.custCode).toUpperCase() || null,
      custName: norm(r.custName).toUpperCase() || null,
      orderType: norm(r.orderType).toUpperCase() || null,
      country: norm(r.country).toUpperCase() || null,
      completed: orderData.isoDate(r.completed),
    };
    if (byKey.has(key)) { Object.assign(byKey.get(key), row); updated++; } else { byKey.set(key, row); added++; }
  }
  await M.orderMaster.write([...byKey.values()]);
  orderCache = null;   // the index is rebuilt from the new rows on the next read

  const { master } = await orderMaster(ent);
  const withChannel = rows.filter((r) => norm(r.orderType)).length;
  const withCountry = rows.filter((r) => norm(r.country)).length;
  res.json({
    entity: ent, file: file.originalname,
    read: rows.length, added, updated, skipped,
    withOrderType: withChannel, withCountry: withCountry,
    orders: master.orders, covers: master.covers,
  });
};

async function indexes() {
  return { codeIndex: await chargeCodes.load(), rateIndex: await rateCard.load() };
}

/** Apply stored per-line decisions on top of the derived result. */
function applyOverrides(lines, overrides) {
  if (!overrides.length) return lines;
  const byKey = new Map(overrides.map(o => [`${o.invoiceNo}|${o.seq}`, o]));
  return lines.map(l => {
    const o = byKey.get(`${l.invoiceNo}|${l.seq}`);
    if (!o) return l;
    return {
      ...l,
      gl: o.gl === undefined || o.gl === null ? l.gl : o.gl,
      class: norm(o.class) || l.class,
      classBasis: o.class ? 'manual' : l.classBasis,
      classConfidence: o.class ? 'declared' : l.classConfidence,
      codingStatus: (o.gl ?? l.gl) !== null && (norm(o.class) || l.class) ? 'coded' : l.codingStatus,
      codingReason: o.gl || o.class ? null : l.codingReason,
      overrideNote: norm(o.note) || null,
      overriddenBy: o.updatedBy || null,
      overriddenAt: o.updatedAt || null,
    };
  });
}

/* ------------------------------------------------- warehouses (sources) ---- */

// GET /nri-invoices/sources — the warehouses that bill us = the tabs under
// All Invoices, each with its invoice count so an empty one is obvious.
exports.listSources = async (req, res) => {
  const [rows, invoices] = await Promise.all([
    sources.list(),
    M.invoices.read().catch(() => []),
  ]);
  const counted = arr(invoices).reduce((m, i) => m.set(i.entity, (m.get(i.entity) || 0) + 1), new Map());
  res.json(rows.map((s) => ({ ...s, invoiceCount: counted.get(String(s.entity).toUpperCase()) || 0 })));
};

// POST /nri-invoices/sources — register another invoicing warehouse.
//
// It is a SHELL by design: `parser: null`, `uploadEnabled: false`. Registering a
// warehouse cannot invent a reader for a workbook layout nobody has seen, and
// guessing one would load a misread invoice into the GL. So the tab, the invoice
// list and its slice of the legend/rate card appear immediately, and uploads open
// when the format is mapped.
exports.addSource = async (req, res) => {
  const label = norm(req.body?.label);
  const code = sources.slug(req.body?.code || label);
  const entity = norm(req.body?.entity).toUpperCase() || code.toUpperCase().replace(/-/g, '_');
  const facilityId = norm(req.body?.facilityId) || null;
  if (!label) return res.status(400).json({ error: 'A warehouse name is required.' });
  if (!code) return res.status(400).json({ error: 'That name has no letters or digits to build a URL code from.' });

  const rows = await sources.list();
  if (rows.some((s) => s.code === code)) return res.status(409).json({ error: `A warehouse with the code "${code}" already exists.` });
  // The entity is the key the coding legend, the rate card and every stored
  // invoice id turn on — two warehouses sharing one would merge their invoices.
  if (rows.some((s) => String(s.entity).toUpperCase() === entity)) {
    return res.status(409).json({ error: `Entity "${entity}" is already used by ${rows.find((s) => String(s.entity).toUpperCase() === entity).label}.` });
  }
  if (facilityId) {
    const facilities = arr(await models.warehouse_facilities.read().catch(() => []));
    if (!facilities.some((f) => f.id === facilityId)) return res.status(400).json({ error: `Unknown facility "${facilityId}".` });
  }

  const row = { code, label, entity, facilityId, parser: null, uploadEnabled: false, note: null };
  await M.sources.write([...rows, row]);
  res.status(201).json(row);
};

// DELETE /nri-invoices/sources/:code — only while it holds no invoices. Removing
// a warehouse that has loaded invoices would orphan them (they key on entity),
// so that is refused rather than cascaded.
exports.removeSource = async (req, res) => {
  const code = sources.slug(req.params.code);
  const rows = await sources.list();
  const row = rows.find((s) => s.code === code);
  if (!row) return res.status(404).json({ error: 'Warehouse not found.' });
  const invoices = arr(await M.invoices.read().catch(() => []));
  const held = invoices.filter((i) => String(i.entity).toUpperCase() === String(row.entity).toUpperCase()).length;
  if (held) return res.status(409).json({ error: `${row.label} holds ${held} loaded invoice(s) — delete those first.` });
  await M.sources.write(rows.filter((s) => s.code !== code));
  res.status(204).send();
};

/* ------------------------------------------------------------- handlers ---- */

// POST /nri-invoices/preview   (multipart: detail=<xlsx>, invoice=<pdf?>)
// Runs the whole reconcile and returns it WITHOUT saving. This is the screen the
// reviewer works from before committing anything.
exports.preview = async (req, res) => {
  const detail = req.files?.detail?.[0];
  const pdfFile = req.files?.invoice?.[0];
  if (!detail) return res.status(400).json({ error: 'A detail workbook is required (field name "detail").' });

  // Which warehouse's invoice is this, and is its file layout mapped? Both answers
  // come from the registry now (data/nri/nri_invoice_sources.json) — this used to
  // be `if (entity !== 'US') 400`, so a second warehouse meant a code change.
  // `warehouse` is the URL code ('nri-us'); `entity` is still accepted for the
  // API's existing callers.
  const src = await sources.find(req.body?.warehouse || req.body?.entity || 'US');
  const gate = sources.uploadable(src, req.body?.warehouse || req.body?.entity || 'US');
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
  const entity = String(src.entity).toUpperCase();

  let pdf = null;
  if (pdfFile) {
    try { pdf = await parser.parseInvoicePdf(pdfFile.buffer); }
    catch (e) { return res.status(400).json({ error: `Could not read the invoice PDF: ${e.message}` }); }
    if (pdf.entity && pdf.entity !== entity) {
      return res.status(400).json({ error: `The PDF is an ${pdf.entity} invoice but ${entity} was selected.` });
    }
  }

  let lines;
  try { lines = await parser.parseDetailWorkbook(detail.buffer, detail.originalname); }
  catch (e) { return res.status(400).json({ error: `Could not read the detail workbook: ${e.message}` }); }
  if (!lines.length) return res.status(400).json({ error: 'The detail workbook has no charge lines.' });

  const { codeIndex, rateIndex } = await indexes();
  const result = svc.reconcile({ pdf, lines, entity, orderIndex: (await orderMaster(entity)).index, codeIndex, rateIndex });

  result.sourceFile = detail.originalname;
  result.hasSummary = !!pdf;
  res.json(result);
};

// POST /nri-invoices   (multipart, same fields as preview) — commit.
// The tie-out must balance unless ?force=true, because coding an invoice whose
// detail does not equal the bill is how a wrong number reaches the GL.
exports.create = async (req, res) => {
  const detail = req.files?.detail?.[0];
  const pdfFile = req.files?.invoice?.[0];
  if (!detail) return res.status(400).json({ error: 'A detail workbook is required (field name "detail").' });

  // Same registry gate as preview — a commit must never be reachable by a path
  // the preview refuses.
  const src = await sources.find(req.body?.warehouse || req.body?.entity || 'US');
  const gate = sources.uploadable(src, req.body?.warehouse || req.body?.entity || 'US');
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
  const entity = String(src.entity).toUpperCase();

  const force = norm(req.body?.force) === 'true' || req.query.force === 'true';

  let pdf = null;
  if (pdfFile) {
    try { pdf = await parser.parseInvoicePdf(pdfFile.buffer); }
    catch (e) { return res.status(400).json({ error: `Could not read the invoice PDF: ${e.message}` }); }
  }

  const invoiceNo = norm(pdf?.invoiceNo) || norm(req.body?.invoiceNo);
  if (!invoiceNo) {
    return res.status(400).json({
      error: 'No invoice number. Supply the invoice PDF, or pass invoiceNo explicitly.',
      hint: 'The detail workbook does not contain the invoice number — only the PDF does.',
    });
  }

  let lines;
  try { lines = await parser.parseDetailWorkbook(detail.buffer, detail.originalname); }
  catch (e) { return res.status(400).json({ error: `Could not read the detail workbook: ${e.message}` }); }

  const { codeIndex, rateIndex } = await indexes();
  const result = svc.reconcile({ pdf, lines, entity, orderIndex: (await orderMaster(entity)).index, codeIndex, rateIndex });

  if (result.tieOut.status === 'outOfBalance' && !force) {
    return res.status(422).json({
      error: 'tieOutFailed',
      message: result.tieOut.message,
      tieOut: result.tieOut,
      hint: 'Re-export the detail from NRI, or resend with force=true to load it anyway (it will stay flagged).',
    });
  }

  const now = new Date().toISOString();
  const header = {
    id: `nri_${entity.toLowerCase()}_${invoiceNo}`,
    invoiceNo: invoiceNo,
    entity,
    ...(result.invoice || {}),
    invoiceNoSource: pdf ? 'pdf' : 'manual',
    sourceFile: detail.originalname,
    hasSummary: !!pdf,
    tieOut: result.tieOut,
    totals: result.totals,
    byGl: result.byGl,
    byService: result.byService,
    findings: result.findings,
    status: 'loaded',
    loadedBy: req.user?.email || null,
    loadedAt: now,
    submittedBy: null,
    submittedAt: null,
  };

  // Wholesale replace, keyed on the invoice — a re-upload corrects, never doubles.
  const invoices = arr(await M.invoices.read().catch(() => []));
  await M.invoices.write([...invoices.filter(i => i.id !== header.id), header]);

  const allLines = arr(await M.lines.read().catch(() => []));
  const stamped = result.lines.map(l => ({ invoiceId: header.id, invoiceNo: invoiceNo, entity, ...l }));
  await M.lines.write([...allLines.filter(l => l.invoiceId !== header.id), ...stamped]);

  res.status(201).json({ ...header, lines: stamped.length });
};

// GET /nri-invoices — the loaded invoice list (headers only; lines are heavy).
exports.list = async (req, res) => {
  const invoices = arr(await M.invoices.read().catch(() => []));
  // `?warehouse=nri-us` (the URL code) or the older `?entity=US`; blank = all.
  const asked = norm(req.query.warehouse) || norm(req.query.entity);
  const entity = asked ? String((await sources.find(asked))?.entity || asked).toUpperCase() : '';
  const rows = invoices
    .filter(i => !entity || i.entity === entity)
    .map(({ byGl, byService, findings, tieOut, ...i }) => ({
      ...i,
      tieOutStatus: tieOut?.status || null,
      tieOutVariance: tieOut?.totalVariance ?? null,
      findingCount: arr(findings).length,
      blockerCount: arr(findings).filter(f => f.severity === 'blocker').length,
    }))
    .sort((a, b) => norm(b.invoiceDate).localeCompare(norm(a.invoiceDate)));
  res.json(rows);
};

// GET /nri-invoices/:id — one invoice with its coded lines and overrides applied.
exports.get = async (req, res) => {
  const invoices = arr(await M.invoices.read().catch(() => []));
  const header = invoices.find(i => i.id === req.params.id || i.invoiceNo === req.params.id);
  if (!header) return res.status(404).json({ error: 'Invoice not loaded.' });

  const lines = arr(await M.lines.read().catch(() => [])).filter(l => l.invoiceId === header.id);
  const overrides = arr(await M.overrides.read().catch(() => [])).filter(o => o.invoiceNo === header.invoiceNo);
  const withOverrides = applyOverrides(lines, overrides);

  // Rollups are DERIVED at read so an override moves the GL summary immediately.
  const rolled = svc.summarise(withOverrides);
  res.json({
    ...header,
    byGl: rolled.byGl,
    byService: rolled.byService,
    findings: svc.findings(withOverrides, header.tieOut),
    lines: withOverrides,
    overrideCount: overrides.length,
  });
};

// PUT /nri-invoices/:invoiceNo/lines/:seq — record a human coding decision.
exports.setOverride = async (req, res) => {
  const invoiceNo = norm(req.params.invoiceNo);
  const seq = Number(req.params.seq);
  if (!invoiceNo || !Number.isInteger(seq) || seq < 1) return res.status(400).json({ error: 'Bad invoice/line reference.' });

  const invoices = arr(await M.invoices.read().catch(() => []));
  if (!invoices.some(i => i.invoiceNo === invoiceNo)) return res.status(404).json({ error: 'Invoice not loaded.' });

  const { gl, class: cls, note } = req.body || {};
  const overrides = arr(await M.overrides.read().catch(() => []));
  const rest = overrides.filter(o => !(o.invoiceNo === invoiceNo && o.seq === seq));

  // An empty body clears the override and the line reverts to the derived value.
  if (gl === null && !norm(cls) && !norm(note)) {
    await M.overrides.write(rest);
    return res.json({ cleared: true, invoiceNo: invoiceNo, seq });
  }

  const row = {
    id: `nlo_${invoiceNo}_${seq}`,
    invoiceNo: invoiceNo, seq,
    gl: gl === undefined || gl === null || gl === '' ? null : Number(gl),
    class: norm(cls) || null,
    note: norm(note) || null,
    updatedBy: req.user?.email || null,
    updatedAt: new Date().toISOString(),
  };
  await M.overrides.write([...rest, row]);
  res.json(row);
};

// POST /nri-invoices/:id/submit — freeze the invoice for posting.
exports.submit = async (req, res) => {
  const invoices = arr(await M.invoices.read().catch(() => []));
  const i = invoices.findIndex(x => x.id === req.params.id || x.invoiceNo === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Invoice not loaded.' });
  const header = invoices[i];

  const lines = arr(await M.lines.read().catch(() => [])).filter(l => l.invoiceId === header.id);
  const overrides = arr(await M.overrides.read().catch(() => [])).filter(o => o.invoiceNo === header.invoiceNo);
  const final = applyOverrides(lines, overrides);

  const unresolved = final.filter(l => l.codingStatus !== 'coded' && Math.abs(l.invAmt) > 0.005);
  if (unresolved.length) {
    return res.status(422).json({
      error: 'uncodedLines',
      message: `${unresolved.length} line(s) carrying value still have no GL or class.`,
      lines: unresolved.slice(0, 20).map(l => ({ seq: l.seq, service: l.service, amount: l.invAmt, reason: l.codingReason })),
    });
  }
  if (header.tieOut?.status === 'outOfBalance') {
    return res.status(422).json({ error: 'tieOutFailed', message: header.tieOut.message, tieOut: header.tieOut });
  }

  const rolled = svc.summarise(final);
  invoices[i] = {
    ...header,
    status: 'submitted',
    submittedBy: req.user?.email || null,
    submittedAt: new Date().toISOString(),
    byGl: rolled.byGl,
    byService: rolled.byService,
    // Zero-value buckets are dropped: the NRI files carry a blank trailing row,
    // and a $0.00 line with no GL is not something anyone should post.
    posting: rolled.byGl
      .flatMap(g => g.classes.map(c => ({ gl: g.gl, glDesc: g.glDesc, class: c.class, amount: c.amount })))
      .filter(p => Math.abs(p.amount) > 0.005),
  };
  await M.invoices.write(invoices);
  res.json(invoices[i]);
};

// DELETE /nri-invoices/:id — un-load (corrections). Overrides are kept so a
// re-upload of the same invoice number restores the decisions.
exports.remove = async (req, res) => {
  const invoices = arr(await M.invoices.read().catch(() => []));
  const header = invoices.find(i => i.id === req.params.id || i.invoiceNo === req.params.id);
  if (!header) return res.status(404).json({ error: 'Invoice not loaded.' });
  await M.invoices.write(invoices.filter(i => i.id !== header.id));
  const lines = arr(await M.lines.read().catch(() => []));
  await M.lines.write(lines.filter(l => l.invoiceId !== header.id));
  res.json({ deleted: header.id, note: 'Line overrides retained for this invoice number.' });
};

/* ------------------------------------------------------- master data ------- */

// GET /nri-invoices/charge-codes — the coding legend the coder uses.
exports.getChargeCodes = async (req, res) => {
  res.json(arr(await M.chargeCodes.read().catch(() => [])));
};

// GET /nri-invoices/rate-card — the agreement, as the validator sees it.
exports.getRateCard = async (req, res) => {
  res.json(arr(await M.rateCard.read().catch(() => [])));
};

// POST /nri-invoices/charge-codes/sync — re-read the legend from the shared drive.
/**
 * POST /nri-invoices/charge-codes/sync
 *
 * The GL lookup basis. Three ways in, in order of precedence:
 *   1. an UPLOADED legend workbook (multipart `legend`) — what the UI sends, so
 *      finance can configure the coding without anyone having the G: drive mapped;
 *   2. an explicit `file` path;
 *   3. the shared-drive default.
 *
 * `dryRun=true` reports what it WOULD write plus the file's defects (duplicate
 * services, trailing-space keys, blank classes, missing GLs) — the legend is the
 * basis for every GL on every line, so it gets inspected before it is adopted.
 */
exports.syncChargeCodes = async (req, res) => {
  const { sync } = require('./syncLegend');
  const upload = req.files?.legend?.[0];
  try {
    const r = await sync({
      file: norm(req.body?.file) || undefined,
      buffer: upload ? upload.buffer : null,
      label: upload ? upload.originalname : null,
      dryRun: norm(req.body?.dryRun) === 'true',
    });
    res.json({
      source: r.source, read: r.read, written: r.written, dryRun: r.dryRun,
      defects: {
        duplicateKeys: r.defects.duplicates.map(d => d.raw),
        whitespaceKeys: r.defects.whitespace,
        blankUsClass: r.defects.blankUsClass,
        blankCaClass: r.defects.blankCaClass,
        noGl: r.defects.noGl,
      },
    });
  } catch (e) {
    res.status(400).json({ error: `Could not read the legend: ${e.message}` });
  }
};

/* ------------------------------------------------------------ analysis ----- */

// GET /nri-invoices/summary — cost per GL across loaded invoices, plus the
// cross-invoice checks that no single invoice can see (a monthly fee billed
// twice, the storage aging trend).
exports.summary = async (req, res) => {
  const asked = norm(req.query.warehouse) || norm(req.query.entity) || 'US';
  const entity = String((await sources.find(asked))?.entity || asked).toUpperCase();
  const invoices = arr(await M.invoices.read().catch(() => [])).filter(i => i.entity === entity);
  const ids = new Set(invoices.map(i => i.id));
  const allLines = arr(await M.lines.read().catch(() => [])).filter(l => ids.has(l.invoiceId));
  const overrides = arr(await M.overrides.read().catch(() => []));
  const lines = applyOverrides(allLines, overrides);

  const byGl = new Map();
  const byMonth = new Map();
  const monthlyFees = new Map();
  const storage = [];

  for (const l of lines) {
    const gk = `${l.gl ?? 'unmapped'}|${l.class || '(unclassed)'}|${l.month || '?'}`;
    const g = byGl.get(gk) || { gl: l.gl, glDesc: l.glDesc, class: l.class || '(unclassed)', month: l.month, lines: 0, amount: 0 };
    g.lines++; g.amount = round2(g.amount + l.invAmt); byGl.set(gk, g);

    const m = byMonth.get(l.month || '?') || { month: l.month || '?', lines: 0, amount: 0 };
    m.lines++; m.amount = round2(m.amount + l.invAmt); byMonth.set(l.month || '?', m);

    if (l.basis === 'per_month') {
      const k = `${l.service}|${l.month}`;
      const f = monthlyFees.get(k) || { service: l.service, month: l.month, count: 0, amount: 0, invoices: new Set() };
      f.count++; f.amount = round2(f.amount + l.invAmt); f.invoices.add(l.invoiceNo); monthlyFees.set(k, f);
    }
    if (l.basis === 'per_unit_month' && l.agingMultiple) {
      storage.push({
        invoiceNo: l.invoiceNo, month: l.month, units: l.units, charges: l.charges,
        effectiveRate: l.effectiveRate, agingMultiple: l.agingMultiple, premium: l.variance,
      });
    }
  }

  storage.sort((a, b) => norm(a.month).localeCompare(norm(b.month)));

  res.json({
    entity,
    invoices: invoices.length,
    lines: lines.length,
    total: round2(lines.reduce((s, l) => s + l.invAmt, 0)),
    byGl: [...byGl.values()].sort((a, b) => b.amount - a.amount),
    byMonth: [...byMonth.values()].sort((a, b) => norm(a.month).localeCompare(norm(b.month))),
    duplicateMonthlyFees: [...monthlyFees.values()]
      .filter(f => f.count > 1)
      .map(f => ({ ...f, invoices: [...f.invoices] })),
    storageAging: storage,
    storagePremium: round2(storage.reduce((s, x) => s + (x.premium || 0), 0)),
  });
};
