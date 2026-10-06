#!/usr/bin/env node
// One-time migration: pulls everything out of NRI_CA_ALL_Invoices_2026.xlsx so Excel is no longer needed.
//   node scripts/migrate-from-excel.js path/to/NRI_CA_ALL_Invoices_2026.xlsx
// Produces:
//   config/coding.json          <- "NRI Invoice Coding" sheet
//   config/contract-rates.json  <- "Unit Rates" inputs
//   data/orders.csv             <- "NRI Order data" sheet (Order Type lookup)
//   data/overrides.csv          <- every Manual Class / GL override typed into Summary_Coded
//   data/invoices/*.csv         <- original NRI invoice CSVs rebuilt from Summary_Coded (by Source.Name)
//   config/locked-sources.json  <- those historical files (auto class rules skip them)
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { sheetToObjects, writeCsv, toDate, isoDate } from '../src/io.js';

const src = process.argv[2];
if (!src) { console.error('Usage: node scripts/migrate-from-excel.js <workbook.xlsx>'); process.exit(1); }

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(src);
const sheet = (n) => { const ws = wb.getWorksheet(n); if (!ws) throw new Error(`Missing sheet: ${n}`); return sheetToObjects(ws); };

// 1) Coding table
const coding = sheet('NRI Invoice Coding')
  .filter((r) => r['Service'])
  .map((r) => ({
    service: String(r['Service']).trim(),
    gl: Number(r['Netsuite GL']),
    description: r['Description'],
    class: r['Class (NRI CAN)'] ?? null,
    usClass: r['Class'] ?? null,
    notes: r['Notes'] ?? null,
  }));
fs.mkdirSync('config', { recursive: true });
fs.writeFileSync('config/coding.json', JSON.stringify(coding, null, 2));

// 2) Contract unit-rate inputs (Unit Rates!A1:F6)
const ur = wb.getWorksheet('Unit Rates');
const v = (addr) => { const x = ur.getCell(addr).value; return typeof x === 'object' && x !== null && 'result' in x ? x.result : x; };
const contract = {
  fulfillment: [2, 3, 4].map((r) => ({
    name: v(`A${r}`), channel: v(`B${r}`) ?? null,
    fixedFee: Number(v(`C${r}`)), feePerUnit: Number(v(`D${r}`)), avgUPT: Number(v(`E${r}`)),
  })),
  storage: { tiers: { '<180': v('B6'), '180-364': v('C6'), '365-541': v('D6'), '>541': v('E6') } },
};
fs.writeFileSync('config/contract-rates.json', JSON.stringify(contract, null, 2));

// 3) Order data
const orders = sheet('NRI Order data');
const ocols = Object.keys(orders[0]);
writeCsv('data/orders.csv', orders.map((o) => ({ ...o, 'Completion Date': isoDate(toDate(o['Completion Date'])) })), ocols);

// 4) Summary_Coded -> overrides + raw invoices
const all = sheet('Summary_Coded').sort((a, b) => Number(a['Index']) - Number(b['Index']));
const RAW = ['OrderID', 'Client Ref 1', 'Client Ref 2', 'Customer', 'PO Number', 'Doc. Date', 'Completed',
  'Units', 'Value', 'Service', 'Charges', 'Taxes', 'Inv. Amt'];

const overrides = all
  .filter((r) => r['Manual Class Override'] || r['Manual GL Code Override'])
  .map((r) => ({
    source: r['Source.Name'], orderId: String(r['OrderID'] ?? '').trim(), service: String(r['Service'] ?? '').trim(),
    classOverride: r['Manual Class Override'] ?? '', glOverride: r['Manual GL Code Override'] ?? '',
  }));
writeCsv('data/overrides.csv', overrides, ['source', 'orderId', 'service', 'classOverride', 'glOverride']);

const bySource = new Map();
for (const r of all) {
  const s = r['Source.Name']; if (!s) continue;
  if (!bySource.has(s)) bySource.set(s, []);
  bySource.get(s).push(Object.fromEntries(RAW.map((k) => {
    const x = r[k];
    return [k, k.endsWith('Date') || k === 'Completed' ? isoDate(toDate(x)) : x ?? ''];
  })));
}
fs.mkdirSync('data/invoices', { recursive: true });
for (const [s, rows] of bySource) writeCsv(path.join('data/invoices', s), rows, RAW);

// 5) Historical files are already coded/booked -> lock them so class rules never recode them
fs.writeFileSync('config/locked-sources.json', JSON.stringify([...bySource.keys()].sort(), null, 2));

console.log(`coding rules      : ${coding.length}`);
console.log(`orders            : ${orders.length}`);
console.log(`manual overrides  : ${overrides.length}`);
console.log(`invoice files     : ${bySource.size}  (${all.length} lines)`);
