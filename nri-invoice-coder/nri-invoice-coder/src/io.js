// File I/O helpers: read CSV/XLSX into arrays of plain objects, write CSV.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';

// "Inv.  Amt " -> "Inv. Amt"  (NRI headers have double spaces / trailing spaces)
export const normHeader = (h) => String(h ?? '').replace(/\s+/g, ' ').trim();

export function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  return parse(text, {
    columns: (hdr) => hdr.map(normHeader),
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });
}

function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);          // formula cell
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;                          // hyperlink
    if ('error' in v) return null;                           // #N/A etc.
  }
  return v;
}

export async function readXlsxSheet(file, sheetName) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!ws) throw new Error(`Sheet "${sheetName}" not found in ${file}`);
  return sheetToObjects(ws);
}

export function sheetToObjects(ws) {
  const rows = [];
  let headers = null;
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = row.values.slice(1).map(cellValue);
    if (!headers) { headers = vals.map(normHeader); return; }
    const o = {};
    headers.forEach((h, i) => { if (h) o[h] = vals[i] ?? null; });
    rows.push(o);
  });
  return rows;
}

export async function readTable(file, sheetName) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.csv') return readCsv(file);
  if (ext === '.xlsx' || ext === '.xlsm') return readXlsxSheet(file, sheetName);
  throw new Error(`Unsupported file type: ${file}`);
}

// Every *.csv in the folder = one NRI invoice. File name becomes "Source.Name" (same as Power Query).
export function readInvoiceFolder(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv')).sort();
  const out = [];
  for (const f of files) {
    for (const r of readCsv(path.join(dir, f))) out.push({ 'Source.Name': f, ...r });
  }
  return { files, rows: out };
}

export function writeCsv(file, rows, columns) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringify(rows, { header: true, columns }));
}

// --- value parsing ---------------------------------------------------------
export function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1'));
  return Number.isFinite(n) ? n : 0;
}

// Accepts Date, Excel serial, ISO "2026-08-31", "8/31/2026", "2026-08-31 00:00:00".
export function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)); // Excel serial
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); // M/D/YYYY (NRI export format)
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(Date.UTC(y, +m[1] - 1, +m[2])); }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const monthLabel = (d) => (d ? `${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}` : '(no date)');
export const monthKey = (d) => (d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` : '0000-00');
export const isoDate = (d) => (d ? d.toISOString().slice(0, 10) : '');
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
