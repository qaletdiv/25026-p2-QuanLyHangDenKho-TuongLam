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
 * (invoice_no, seq) rather than a position in a combined table.
 */

const M = require('./NriInvoiceModels');
const parser = require('./invoiceParser');
const chargeCodes = require('./chargeCodes');
const rateCard = require('./rateCard');
const lineClass = require('./lineClass');
const orderData = require('./orderData');
const svc = require('./nriInvoiceService');

const arr = v => (Array.isArray(v) ? v : []);
const norm = v => (v === undefined || v === null ? '' : String(v).trim());
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* -------------------------------------------------------- order master ----- */

// The CLASS depends on the order (channel x geography x marketplace), so the
// order master is a required input — not a nicety. Cached per process because it
// is ~33k rows; `POST /order-data/refresh` clears it.
let orderCache = null;

async function orderMaster() {
  if (orderCache) return orderCache;
  const workbook = process.env.NRI_ORDER_DATA_WORKBOOK
    || require('path').join(__dirname, '..', '..', 'NRI US_ALL Invoices 2026.xlsx');
  let master;
  try {
    master = await orderData.load({ workbook });
  } catch (e) {
    // Never fail an upload over this: the class simply comes back unresolved,
    // which the reconcile reports rather than hiding.
    master = { byOrder: new Map(), sources: [{ label: 'load failed', error: e.message }], orders: 0, covers: null };
  }
  orderCache = { master, index: lineClass.buildOrderIndex(master) };
  return orderCache;
}

exports.refreshOrderData = async (req, res) => {
  orderCache = null;
  const { master } = await orderMaster();
  res.json({ orders: master.orders, covers: master.covers, sources: master.sources });
};

exports.getOrderData = async (req, res) => {
  const { master } = await orderMaster();
  res.json({ orders: master.orders, covers: master.covers, sources: master.sources, csv_dir: orderData.DEFAULT_CSV_DIR });
};

async function indexes() {
  return { codeIndex: await chargeCodes.load(), rateIndex: await rateCard.load() };
}

/** Apply stored per-line decisions on top of the derived result. */
function applyOverrides(lines, overrides) {
  if (!overrides.length) return lines;
  const byKey = new Map(overrides.map(o => [`${o.invoice_no}|${o.seq}`, o]));
  return lines.map(l => {
    const o = byKey.get(`${l.invoice_no}|${l.seq}`);
    if (!o) return l;
    return {
      ...l,
      gl: o.gl === undefined || o.gl === null ? l.gl : o.gl,
      class: norm(o.class) || l.class,
      class_basis: o.class ? 'manual' : l.class_basis,
      class_confidence: o.class ? 'declared' : l.class_confidence,
      coding_status: (o.gl ?? l.gl) !== null && (norm(o.class) || l.class) ? 'coded' : l.coding_status,
      coding_reason: o.gl || o.class ? null : l.coding_reason,
      override_note: norm(o.note) || null,
      overridden_by: o.updated_by || null,
      overridden_at: o.updated_at || null,
    };
  });
}

/* ------------------------------------------------------------- handlers ---- */

// POST /nri-invoices/preview   (multipart: detail=<xlsx>, invoice=<pdf?>)
// Runs the whole reconcile and returns it WITHOUT saving. This is the screen the
// reviewer works from before committing anything.
exports.preview = async (req, res) => {
  const detail = req.files?.detail?.[0];
  const pdfFile = req.files?.invoice?.[0];
  if (!detail) return res.status(400).json({ error: 'A detail workbook is required (field name "detail").' });

  const entity = (norm(req.body?.entity) || 'US').toUpperCase();
  if (entity !== 'US') {
    return res.status(400).json({ error: 'Only the US entity is supported so far. CA needs its own detail-layout check first.' });
  }

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
  const result = svc.reconcile({ pdf, lines, entity, orderIndex: (await orderMaster()).index, codeIndex, rateIndex });

  result.source_file = detail.originalname;
  result.has_summary = !!pdf;
  res.json(result);
};

// POST /nri-invoices   (multipart, same fields as preview) — commit.
// The tie-out must balance unless ?force=true, because coding an invoice whose
// detail does not equal the bill is how a wrong number reaches the GL.
exports.create = async (req, res) => {
  const detail = req.files?.detail?.[0];
  const pdfFile = req.files?.invoice?.[0];
  if (!detail) return res.status(400).json({ error: 'A detail workbook is required (field name "detail").' });

  const entity = (norm(req.body?.entity) || 'US').toUpperCase();
  if (entity !== 'US') return res.status(400).json({ error: 'Only the US entity is supported so far.' });

  const force = norm(req.body?.force) === 'true' || req.query.force === 'true';

  let pdf = null;
  if (pdfFile) {
    try { pdf = await parser.parseInvoicePdf(pdfFile.buffer); }
    catch (e) { return res.status(400).json({ error: `Could not read the invoice PDF: ${e.message}` }); }
  }

  const invoiceNo = norm(pdf?.invoice_no) || norm(req.body?.invoice_no);
  if (!invoiceNo) {
    return res.status(400).json({
      error: 'No invoice number. Supply the invoice PDF, or pass invoice_no explicitly.',
      hint: 'The detail workbook does not contain the invoice number — only the PDF does.',
    });
  }

  let lines;
  try { lines = await parser.parseDetailWorkbook(detail.buffer, detail.originalname); }
  catch (e) { return res.status(400).json({ error: `Could not read the detail workbook: ${e.message}` }); }

  const { codeIndex, rateIndex } = await indexes();
  const result = svc.reconcile({ pdf, lines, entity, orderIndex: (await orderMaster()).index, codeIndex, rateIndex });

  if (result.tie_out.status === 'out_of_balance' && !force) {
    return res.status(422).json({
      error: 'tie_out_failed',
      message: result.tie_out.message,
      tie_out: result.tie_out,
      hint: 'Re-export the detail from NRI, or resend with force=true to load it anyway (it will stay flagged).',
    });
  }

  const now = new Date().toISOString();
  const header = {
    id: `nri_${entity.toLowerCase()}_${invoiceNo}`,
    invoice_no: invoiceNo,
    entity,
    ...(result.invoice || {}),
    invoice_no_source: pdf ? 'pdf' : 'manual',
    source_file: detail.originalname,
    has_summary: !!pdf,
    tie_out: result.tie_out,
    totals: result.totals,
    by_gl: result.by_gl,
    by_service: result.by_service,
    findings: result.findings,
    status: 'loaded',
    loaded_by: req.user?.email || null,
    loaded_at: now,
    submitted_by: null,
    submitted_at: null,
  };

  // Wholesale replace, keyed on the invoice — a re-upload corrects, never doubles.
  const invoices = arr(await M.invoices.read().catch(() => []));
  await M.invoices.write([...invoices.filter(i => i.id !== header.id), header]);

  const allLines = arr(await M.lines.read().catch(() => []));
  const stamped = result.lines.map(l => ({ invoice_id: header.id, invoice_no: invoiceNo, entity, ...l }));
  await M.lines.write([...allLines.filter(l => l.invoice_id !== header.id), ...stamped]);

  res.status(201).json({ ...header, lines: stamped.length });
};

// GET /nri-invoices — the loaded invoice list (headers only; lines are heavy).
exports.list = async (req, res) => {
  const invoices = arr(await M.invoices.read().catch(() => []));
  const entity = norm(req.query.entity).toUpperCase();
  const rows = invoices
    .filter(i => !entity || i.entity === entity)
    .map(({ by_gl, by_service, findings, tie_out, ...i }) => ({
      ...i,
      tie_out_status: tie_out?.status || null,
      tie_out_variance: tie_out?.total_variance ?? null,
      finding_count: arr(findings).length,
      blocker_count: arr(findings).filter(f => f.severity === 'blocker').length,
    }))
    .sort((a, b) => norm(b.invoice_date).localeCompare(norm(a.invoice_date)));
  res.json(rows);
};

// GET /nri-invoices/:id — one invoice with its coded lines and overrides applied.
exports.get = async (req, res) => {
  const invoices = arr(await M.invoices.read().catch(() => []));
  const header = invoices.find(i => i.id === req.params.id || i.invoice_no === req.params.id);
  if (!header) return res.status(404).json({ error: 'Invoice not loaded.' });

  const lines = arr(await M.lines.read().catch(() => [])).filter(l => l.invoice_id === header.id);
  const overrides = arr(await M.overrides.read().catch(() => [])).filter(o => o.invoice_no === header.invoice_no);
  const withOverrides = applyOverrides(lines, overrides);

  // Rollups are DERIVED at read so an override moves the GL summary immediately.
  const rolled = svc.summarise(withOverrides);
  res.json({
    ...header,
    by_gl: rolled.by_gl,
    by_service: rolled.by_service,
    findings: svc.findings(withOverrides, header.tie_out),
    lines: withOverrides,
    override_count: overrides.length,
  });
};

// PUT /nri-invoices/:invoiceNo/lines/:seq — record a human coding decision.
exports.setOverride = async (req, res) => {
  const invoiceNo = norm(req.params.invoiceNo);
  const seq = Number(req.params.seq);
  if (!invoiceNo || !Number.isInteger(seq) || seq < 1) return res.status(400).json({ error: 'Bad invoice/line reference.' });

  const invoices = arr(await M.invoices.read().catch(() => []));
  if (!invoices.some(i => i.invoice_no === invoiceNo)) return res.status(404).json({ error: 'Invoice not loaded.' });

  const { gl, class: cls, note } = req.body || {};
  const overrides = arr(await M.overrides.read().catch(() => []));
  const rest = overrides.filter(o => !(o.invoice_no === invoiceNo && o.seq === seq));

  // An empty body clears the override and the line reverts to the derived value.
  if (gl === null && !norm(cls) && !norm(note)) {
    await M.overrides.write(rest);
    return res.json({ cleared: true, invoice_no: invoiceNo, seq });
  }

  const row = {
    id: `nlo_${invoiceNo}_${seq}`,
    invoice_no: invoiceNo, seq,
    gl: gl === undefined || gl === null || gl === '' ? null : Number(gl),
    class: norm(cls) || null,
    note: norm(note) || null,
    updated_by: req.user?.email || null,
    updated_at: new Date().toISOString(),
  };
  await M.overrides.write([...rest, row]);
  res.json(row);
};

// POST /nri-invoices/:id/submit — freeze the invoice for posting.
exports.submit = async (req, res) => {
  const invoices = arr(await M.invoices.read().catch(() => []));
  const i = invoices.findIndex(x => x.id === req.params.id || x.invoice_no === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Invoice not loaded.' });
  const header = invoices[i];

  const lines = arr(await M.lines.read().catch(() => [])).filter(l => l.invoice_id === header.id);
  const overrides = arr(await M.overrides.read().catch(() => [])).filter(o => o.invoice_no === header.invoice_no);
  const final = applyOverrides(lines, overrides);

  const unresolved = final.filter(l => l.coding_status !== 'coded' && Math.abs(l.inv_amt) > 0.005);
  if (unresolved.length) {
    return res.status(422).json({
      error: 'uncoded_lines',
      message: `${unresolved.length} line(s) carrying value still have no GL or class.`,
      lines: unresolved.slice(0, 20).map(l => ({ seq: l.seq, service: l.service, amount: l.inv_amt, reason: l.coding_reason })),
    });
  }
  if (header.tie_out?.status === 'out_of_balance') {
    return res.status(422).json({ error: 'tie_out_failed', message: header.tie_out.message, tie_out: header.tie_out });
  }

  const rolled = svc.summarise(final);
  invoices[i] = {
    ...header,
    status: 'submitted',
    submitted_by: req.user?.email || null,
    submitted_at: new Date().toISOString(),
    by_gl: rolled.by_gl,
    by_service: rolled.by_service,
    // Zero-value buckets are dropped: the NRI files carry a blank trailing row,
    // and a $0.00 line with no GL is not something anyone should post.
    posting: rolled.by_gl
      .flatMap(g => g.classes.map(c => ({ gl: g.gl, gl_desc: g.gl_desc, class: c.class, amount: c.amount })))
      .filter(p => Math.abs(p.amount) > 0.005),
  };
  await M.invoices.write(invoices);
  res.json(invoices[i]);
};

// DELETE /nri-invoices/:id — un-load (corrections). Overrides are kept so a
// re-upload of the same invoice number restores the decisions.
exports.remove = async (req, res) => {
  const invoices = arr(await M.invoices.read().catch(() => []));
  const header = invoices.find(i => i.id === req.params.id || i.invoice_no === req.params.id);
  if (!header) return res.status(404).json({ error: 'Invoice not loaded.' });
  await M.invoices.write(invoices.filter(i => i.id !== header.id));
  const lines = arr(await M.lines.read().catch(() => []));
  await M.lines.write(lines.filter(l => l.invoice_id !== header.id));
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
exports.syncChargeCodes = async (req, res) => {
  const { sync } = require('./syncLegend');
  try {
    const r = await sync({ file: norm(req.body?.file) || undefined, dryRun: norm(req.body?.dry_run) === 'true' });
    res.json({
      source: r.source, read: r.read, written: r.written, dry_run: r.dryRun,
      defects: {
        duplicate_keys: r.defects.duplicates.map(d => d.raw),
        whitespace_keys: r.defects.whitespace,
        blank_us_class: r.defects.blankUsClass,
        blank_ca_class: r.defects.blankCaClass,
        no_gl: r.defects.noGl,
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
  const entity = (norm(req.query.entity) || 'US').toUpperCase();
  const invoices = arr(await M.invoices.read().catch(() => [])).filter(i => i.entity === entity);
  const ids = new Set(invoices.map(i => i.id));
  const allLines = arr(await M.lines.read().catch(() => [])).filter(l => ids.has(l.invoice_id));
  const overrides = arr(await M.overrides.read().catch(() => []));
  const lines = applyOverrides(allLines, overrides);

  const byGl = new Map();
  const byMonth = new Map();
  const monthlyFees = new Map();
  const storage = [];

  for (const l of lines) {
    const gk = `${l.gl ?? 'unmapped'}|${l.class || '(unclassed)'}|${l.month || '?'}`;
    const g = byGl.get(gk) || { gl: l.gl, gl_desc: l.gl_desc, class: l.class || '(unclassed)', month: l.month, lines: 0, amount: 0 };
    g.lines++; g.amount = round2(g.amount + l.inv_amt); byGl.set(gk, g);

    const m = byMonth.get(l.month || '?') || { month: l.month || '?', lines: 0, amount: 0 };
    m.lines++; m.amount = round2(m.amount + l.inv_amt); byMonth.set(l.month || '?', m);

    if (l.basis === 'per_month') {
      const k = `${l.service}|${l.month}`;
      const f = monthlyFees.get(k) || { service: l.service, month: l.month, count: 0, amount: 0, invoices: new Set() };
      f.count++; f.amount = round2(f.amount + l.inv_amt); f.invoices.add(l.invoice_no); monthlyFees.set(k, f);
    }
    if (l.basis === 'per_unit_month' && l.aging_multiple) {
      storage.push({
        invoice_no: l.invoice_no, month: l.month, units: l.units, charges: l.charges,
        effective_rate: l.effective_rate, aging_multiple: l.aging_multiple, premium: l.variance,
      });
    }
  }

  storage.sort((a, b) => norm(a.month).localeCompare(norm(b.month)));

  res.json({
    entity,
    invoices: invoices.length,
    lines: lines.length,
    total: round2(lines.reduce((s, l) => s + l.inv_amt, 0)),
    by_gl: [...byGl.values()].sort((a, b) => b.amount - a.amount),
    by_month: [...byMonth.values()].sort((a, b) => norm(a.month).localeCompare(norm(b.month))),
    duplicate_monthly_fees: [...monthlyFees.values()]
      .filter(f => f.count > 1)
      .map(f => ({ ...f, invoices: [...f.invoices] })),
    storage_aging: storage,
    storage_premium: round2(storage.reduce((s, x) => s + (x.premium || 0), 0)),
  });
};
