'use strict';
/**
 * Parsers for the two documents NRI sends per invoice.
 *
 *   PDF  — the SUMMARY. Carries the invoice number, dates, terms, FX rate, a
 *          per-service subtotal and the tax breakdown. None of that is in the
 *          xlsx, which is why the workbook has no invoice number and no way to
 *          prove the detail file is complete.
 *   xlsx — the SOURCE. Line-level detail.
 *
 * The xlsx parse reproduces the workbook's Power Query steps (promote headers,
 * drop Column3, keep [Order] non-blank, drop repeated header rows) so the loader
 * is a faithful replacement rather than a reinterpretation — with ONE deliberate
 * deviation: the header row is detected instead of assumed at a fixed offset.
 * See `parseDetailWorkbook`.
 *
 * Verified on invoice 48872: 3,775 lines, Σ Charges $39,511.77 = the PDF
 * SubTotal, Σ Inv. Amt $39,648.09 = the PDF Total, and the same line count the
 * existing Power Query pipeline produces.
 */

const xl = require('./xlsxStream');

const norm = v => (v === undefined || v === null ? '' : String(v).trim());
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/** "$3,899.01" -> 3899.01 ; "($52.40)" -> -52.40 ; "" -> null */
function parseMoney(s) {
  const t = norm(s);
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t);
  const digits = t.replace(/[()$,\s-]/g, '');
  if (!/^\d*\.?\d+$/.test(digits)) return null;
  const n = Number(digits);
  return neg ? -n : n;
}

/** "08/31/2026" -> "2026-08-31" */
function parseUsDate(s) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(norm(s));
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/* ------------------------------------------------------------------- PDF ---- */

/** Group a page's text items into visual lines, left-to-right. */
async function pdfLines(buffer, maxPages) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  const out = [];
  const pages = Math.min(doc.numPages, maxPages || doc.numPages);
  for (let p = 1; p <= pages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const items = tc.items
      .filter(i => norm(i.str))
      .map(i => ({ x: Math.round(i.transform[4]), y: Math.round(i.transform[5]), s: norm(i.str) }));
    const lines = [];
    for (const it of items) {
      let l = lines.find(L => Math.abs(L.y - it.y) <= 3);
      if (!l) { l = { y: it.y, items: [] }; lines.push(l); }
      l.items.push(it);
    }
    lines.sort((a, b) => b.y - a.y);
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      out.push(l.items);
    }
  }
  return out;
}

/** Value that follows a label on the same visual line. */
function after(lines, label) {
  const re = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  for (const items of lines) {
    const i = items.findIndex(t => re.test(t.s));
    if (i !== -1 && items[i + 1]) return items.slice(i + 1).map(t => t.s).join(' ');
  }
  return null;
}

/**
 * Parse the invoice PDF. Returns the header plus `services` (per-service
 * subtotals), which is the control set the detail must tie to.
 */
async function parseInvoicePdf(buffer) {
  const lines = await pdfLines(buffer);
  const flat = lines.map(items => items.map(t => t.s).join('  '));

  const entity = flat.some(l => /NRI\s+USA\s+LLC/i.test(l)) ? 'US'
    : flat.some(l => /NRI\s+(CANADA|DISTRIBUTION.*CANADA|CAN)\b/i.test(l)) ? 'CA' : null;

  const services = [];
  let subtotal = null, taxes = null, total = null;
  const taxLines = [];
  let inTable = false;

  for (const items of lines) {
    const label = items[0] ? items[0].s : '';
    const amount = parseMoney(items[items.length - 1] ? items[items.length - 1].s : '');

    if (/^Service$/i.test(label)) { inTable = true; continue; }
    if (/^SubTotal:/i.test(label)) { subtotal = amount; inTable = false; continue; }
    if (/^Total\s*Taxes:/i.test(label)) { taxes = amount; continue; }
    if (/^Total:/i.test(label)) { total = amount; continue; }
    if (/^Taxes:/i.test(label)) { inTable = false; continue; }
    if (/^(State|Federal|Provincial|GST|HST|PST|VAT)\b/i.test(label) && amount !== null) {
      taxLines.push({ label, amount }); continue;
    }
    // A service row: label on the left, one money value on the right, nothing else.
    if (inTable && amount !== null && items.length >= 2 && !/^(Page|PLEASE|LLC#)/i.test(label)) {
      services.push({ service: label, amount });
    }
  }

  return {
    entity,
    invoice_no: (after(lines, 'Invoice:') || '').split(/\s+/)[0] || null,
    invoice_date: parseUsDate(after(lines, 'Invoice Date:')),
    ending_date: parseUsDate(after(lines, 'Ending Date:')),
    payment_terms: norm(after(lines, 'Payment Terms:')) || null,
    due_date: parseUsDate(after(lines, 'Payment Due By:')),
    fx_rate: Number(norm(after(lines, 'Exchange Rate:'))) || null,
    subtotal, taxes, total,
    tax_lines: taxLines,
    services,
    is_credit: (total !== null && total < 0),
  };
}

/* ------------------------------------------------------------------ xlsx ---- */

const DETAIL_COLUMNS = ['Order', 'Client Ref 1', 'Client Ref 2', 'Customer', 'PO Number',
  'Doc. Date', 'Completed', 'Units', 'Value', 'Service', 'Charges', 'Taxes', 'Inv.  Amt'];

function toLine(get, source) {
  const numOf = v => (typeof v === 'number' && isFinite(v) ? v : null);
  const strOf = v => (v && v.error ? null : (v === undefined || v === null || v === '' ? null : String(v).trim()));
  const dateOf = v => (typeof v === 'number' ? xl.excelSerialToISO(v) : (strOf(v) || null));

  const completed = dateOf(get('Completed'));
  return {
    source_name: source || null,
    order: strOf(get('Order')),
    client_ref_1: strOf(get('Client Ref 1')),
    client_ref_2: strOf(get('Client Ref 2')),
    customer: strOf(get('Customer')),
    po_number: strOf(get('PO Number')),
    doc_date: dateOf(get('Doc. Date')),
    completed,
    month: completed ? completed.slice(0, 7) : null,
    units: numOf(get('Units')),
    value: numOf(get('Value')),
    service: strOf(get('Service')),
    charges: round2(numOf(get('Charges')) || 0),
    taxes: round2(numOf(get('Taxes')) || 0),
    inv_amt: round2(numOf(get('Inv.  Amt')) || 0),
  };
}

/**
 * A SINGLE NRI invoice workbook (the file logistics drops in the folder).
 * Mirrors the M function `Transform File`.
 */
async function parseDetailWorkbook(buffer, label) {
  const wb = xl.openBuffer(buffer, label);
  const sst = await xl.sharedStrings(wb);
  const index = await xl.sheetIndex(wb);
  const sheet = index.has('Sheet') ? 'Sheet' : [...index.keys()][0];

  const rows = [];
  let header = null, scanned = 0;
  await xl.eachRow(wb, sheet, sst, (n, cells) => {
    if (!header) {
      // DELIBERATE DEVIATION from the workbook, which hardcodes Table.Skip(7).
      // That 7 was measured against a 2025 exemplar (the `Sample File` query still
      // points at the 2025 folder) and the 2026 files put the header on sheet row
      // 7, so a blind skip lands past it. Detecting the header instead is immune
      // to NRI moving the banner, which they have already done once.
      const labels = cells.map(c => norm(c && c.error ? '' : c));
      if (labels.includes('Service') && labels.includes('Charges')) header = labels;
      else if (++scanned > 40) throw new Error('no header row containing Service + Charges in the first 40 rows');
      return true;
    }
    const get = name => { const i = header.indexOf(name); return i === -1 ? undefined : cells[i]; };
    if (!norm(get('Order'))) return;                    // [Order] <> null and <> ""
    if (norm(get('Client Ref 1')) === 'Client Ref 1') return;  // repeated header row
    rows.push(toLine(get, label));
  });

  if (!header) throw new Error('could not find the detail header row');
  return rows;
}

/**
 * The COMBINED `NRI *_ALL Invoices` workbook — what the Power Query pipeline
 * produces today. Used to backfill history and to regression-test the loader
 * against numbers the team already trusts. `Source.Name` identifies the invoice.
 */
async function parseCombinedWorkbook(pathOrBuffer, opts) {
  const wb = typeof pathOrBuffer === 'string' ? xl.open(pathOrBuffer) : xl.openBuffer(pathOrBuffer);
  const sst = await xl.sharedStrings(wb);
  const index = await xl.sheetIndex(wb);
  const sheet = (opts && opts.sheet)
    || ['NRI_All Invoices', 'NRI_ALL Invoices', 'Summary_Coded'].find(s => index.has(s))
    || [...index.keys()].find(s => /invoice/i.test(s) && !/coding/i.test(s));
  if (!sheet) throw new Error('no invoice detail sheet; sheets: ' + [...index.keys()].join(', '));

  const rows = [];
  let header = null;
  await xl.eachRow(wb, sheet, sst, (n, cells) => {
    if (!header) { header = cells.map(c => norm(c && c.error ? '' : c)); return true; }
    const get = name => { const i = header.indexOf(name); return i === -1 ? undefined : cells[i]; };
    if (!norm(get('Service'))) return;
    rows.push(toLine(get, norm(get('Source.Name')) || null));
  });
  return { sheet, rows };
}

/** Order master sheet -> rows shaped for orderData.load / lineClass.buildOrderIndex. */
async function parseOrderData(pathOrBuffer) {
  const wb = typeof pathOrBuffer === 'string' ? xl.open(pathOrBuffer) : xl.openBuffer(pathOrBuffer);
  const sst = await xl.sharedStrings(wb);
  const index = await xl.sheetIndex(wb);
  const sheet = [...index.keys()].find(s => /order data/i.test(s));
  if (!sheet) return [];

  const rows = [];
  let header = null;
  await xl.eachRow(wb, sheet, sst, (n, cells) => {
    if (!header) { header = cells.map(c => norm(c && c.error ? '' : c)); return true; }
    const get = name => { const i = header.indexOf(name); return i === -1 ? undefined : cells[i]; };
    rows.push({
      orderNo: get('Order #'), ref2: get('Ref2'), custCode: get('CustCode'),
      custName: get('Ship To'), orderType: get('OrderType'),
    });
  });
  return rows;
}

module.exports = {
  parseInvoicePdf, parseDetailWorkbook, parseCombinedWorkbook, parseOrderData,
  parseMoney, parseUsDate, DETAIL_COLUMNS,
};
