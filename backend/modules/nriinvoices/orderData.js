'use strict';
/**
 * NRI order master — the input the CLASS depends on.
 *
 * The GL comes from the service, but the NetSuite CLASS is a property of the
 * ORDER (channel x geography x marketplace), and nothing on an invoice line
 * carries it: no line states the ship-to country, and the PO-number format does
 * not predict the channel (`text` POs are 84% ecom, so pattern-matching is not a
 * substitute — measured, not assumed).
 *
 * NRI delivers this as PERIODIC CSVs:
 *   G:\...\NRI\Invoices\NRI US Order Data\<period> order data US.csv
 * The workbook also embeds one stale snapshot on its `NRI Order data` sheet.
 * Both are loaded and merged — a CSV wins over the snapshot for the same order,
 * being the newer, narrower delivery.
 *
 * ⚠️ Coverage is the limiting factor on class accuracy, so `load()` reports it
 * and the reconcile surfaces it. As of writing, only "August 1-14" exists, which
 * is why the Aug 31 invoice can only resolve 1,340 of 3,775 lines.
 */

const fs = require('fs');
const path = require('path');
const xl = require('./xlsxStream');

const DEFAULT_CSV_DIR = process.env.NRI_ORDER_DATA_DIR
  || 'G:/Shared drives/Tentree Shared Drive/Operations/Logistics/Warehouses/NRI/Invoices/NRI US Order Data';

const norm = v => (v === undefined || v === null ? '' : String(v).trim());
const upper = v => norm(v).toUpperCase();

/** Split one CSV line, honouring double-quoted fields. */
function splitCsv(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** "8-5-2026" | "2026-08-05" | "8/5/2026" -> "2026-08-05" */
function isoDate(s) {
  const t = norm(s);
  if (!t) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

const ROW_KEYS = {
  'ORDER #': 'orderNo', 'SHIP TO': 'custName', 'CUSTCODE': 'custCode', 'REF2': 'ref2',
  'ORDERTYPE': 'orderType', 'SHIP TO COUNTRY': 'country', 'PO #': 'poNumber',
  'COMPLETION DATE': 'completed', 'DATE COMPLETED': 'completed', 'STATUS': 'status',
};

function mapRow(header, cells) {
  const row = {};
  header.forEach((h, i) => {
    const k = ROW_KEYS[upper(h)];
    if (k) row[k] = cells[i];
  });
  return row;
}

function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const header = splitCsv(lines[0]);
  return lines.slice(1)
    .map(l => mapRow(header, splitCsv(l)))
    .filter(r => norm(r.orderNo));
}

async function readWorkbookSheet(file) {
  const wb = xl.open(file);
  const sst = await xl.sharedStrings(wb);
  const index = await xl.sheetIndex(wb);
  const sheet = [...index.keys()].find(s => /order data/i.test(s));
  if (!sheet) return [];

  const rows = [];
  let header = null;
  await xl.eachRow(wb, sheet, sst, (n, cells) => {
    if (!header) { header = cells.map(c => norm(c && c.error ? '' : c)); return true; }
    const r = mapRow(header, cells);
    if (norm(r.orderNo)) {
      if (typeof r.completed === 'number') r.completed = xl.excelSerialToISO(r.completed);
      rows.push(r);
    }
  });
  return rows;
}

/**
 * Load every available order source. Later sources overwrite earlier ones for the
 * same order number, so pass the least-trusted first.
 */
async function load(opts = {}) {
  const csvDir = opts.csvDir === undefined ? DEFAULT_CSV_DIR : opts.csvDir;
  const workbook = opts.workbook;

  const sources = [];
  const byOrder = new Map();

  const ingest = (rows, label) => {
    let added = 0;
    for (const r of rows) {
      const key = upper(r.orderNo);
      if (!key) continue;
      byOrder.set(key, {
        orderNo: norm(r.orderNo),
        ref2: norm(r.ref2) || null,
        custCode: upper(r.custCode) || null,
        custName: upper(r.custName) || null,
        orderType: upper(r.orderType) || null,
        country: upper(r.country) || null,
        completed: isoDate(r.completed),
      });
      added++;
    }
    sources.push({ label, rows: rows.length, added });
  };

  // 1. The workbook's embedded snapshot — broad but stale.
  if (workbook && fs.existsSync(workbook)) {
    try { ingest(await readWorkbookSheet(workbook), path.basename(workbook) + ' (embedded snapshot)'); }
    catch (e) { sources.push({ label: path.basename(workbook), error: e.message }); }
  }

  // 2. The periodic CSVs — narrower but newer, so they win.
  if (csvDir && fs.existsSync(csvDir)) {
    const files = fs.readdirSync(csvDir).filter(f => /\.csv$/i.test(f)).sort();
    for (const f of files) {
      try { ingest(readCsv(path.join(csvDir, f)), f); }
      catch (e) { sources.push({ label: f, error: e.message }); }
    }
  }

  const dates = [...byOrder.values()].map(o => o.completed).filter(Boolean).sort();
  return {
    byOrder,
    sources,
    orders: byOrder.size,
    covers: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
  };
}

/** Rows shaped for lineClass.buildOrderIndex. */
function toContextRows(master) {
  return [...master.byOrder.values()].map(o => ({
    orderNo: o.orderNo, ref2: o.ref2, custCode: o.custCode,
    custName: o.custName, orderType: o.orderType,
  }));
}

module.exports = { load, toContextRows, readCsv, readWorkbookSheet, isoDate, splitCsv, DEFAULT_CSV_DIR };
