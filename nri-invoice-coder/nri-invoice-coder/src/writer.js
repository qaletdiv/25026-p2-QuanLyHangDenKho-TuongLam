// Writes the coded output workbook (same tabs as the old Excel file).
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { isoDate } from './io.js';

const FONT = { name: 'Arial', size: 10 };
const HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
const MONEY = '#,##0.00;(#,##0.00);-';

const LINE_COLS = [
  ['Source.Name', 'source', 34], ['OrderID', 'orderId', 12], ['Client Ref 1', 'clientRef1', 16],
  ['Client Ref 2', 'clientRef2', 12], ['Customer', 'customer', 34], ['PO Number', 'poNumber', 14],
  ['Doc. Date', 'docDate', 11], ['Completed', 'completed', 11], ['Units', 'units', 9],
  ['Value', 'value', 10], ['Service', 'service', 26], ['Charges', 'charges', 12],
  ['Taxes', 'taxes', 10], ['Inv. Amt', 'invAmt', 12], ['Netsuite GL', 'netsuiteGl', 10],
  ['Description', 'description', 44], ['Class (NRI CAN)', 'defaultClass', 13],
  ['Manual Class Override', 'classOverride', 13], ['Manual GL Code Override', 'glOverride', 12],
  ['Revised Class', 'revisedClass', 13], ['Revised GL Code', 'revisedGl', 10],
  ['Revised GL Desc', 'revisedGlDesc', 44], ['MMM-YYYY', 'month', 10], ['Order Type', 'orderType', 12],
  ['Class Source', 'classSource', 14], ['GL Source', 'glSource', 12], ['Flags', 'flags', 22],
];

function styleHeader(ws) {
  ws.getRow(1).eachCell((c) => { c.font = { ...FONT, bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = HEAD; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

function addTable(ws, columns, rows, widths = {}) {
  ws.columns = columns.map((c) => ({ header: c, key: c, width: widths[c] ?? Math.max(12, String(c).length + 2) }));
  for (const r of rows) ws.addRow(r);
  styleHeader(ws);
  ws.eachRow((row, i) => {
    if (i === 1) return;
    row.eachCell((c) => { c.font = FONT; if (typeof c.value === 'number') c.numFmt = MONEY; });
  });
  const last = ws.getRow(ws.rowCount);
  if (String(last.getCell(1).value) === 'Grand Total') last.eachCell((c) => (c.font = { ...FONT, bold: true }));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
}

const LABELS = { revisedGl: 'Revised GL Code', revisedGlDesc: 'Revised GL Desc', service: 'Service', revisedClass: 'Revised Class' };
const relabel = (pv) => ({
  columns: pv.columns.map((c) => LABELS[c] ?? c),
  rows: pv.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [LABELS[k] ?? k, v]))),
});

export async function writeWorkbook(file, { lines, reports }) {
  const wb = new ExcelJS.Workbook();

  // 1) Pivot: Revised GL × Class
  let p = relabel(reports.glByClass);
  addTable(wb.addWorksheet('Pivot GL x Class'), p.columns, p.rows, { 'Revised GL Desc': 52 });

  // 2) Service by invoice file
  p = relabel(reports.serviceByInvoice);
  addTable(wb.addWorksheet('Service by Invoice'), p.columns, p.rows, { 'Revised GL Desc': 52, Service: 28 });

  // 3) GL × Service (Inv. Amt)
  p = relabel(reports.glByServiceInvAmt);
  addTable(wb.addWorksheet('GL x Service (Inv Amt)'), p.columns, p.rows, { 'Revised GL Desc': 52, Service: 28 });

  // 4) Monthly unit rates
  const m = reports.monthly;
  addTable(wb.addWorksheet('Monthly Unit Rates'), Object.keys(m[0] ?? { 'GL Desc': 1 }), m, { 'GL Desc': 52 });
  const ws4 = wb.getWorksheet('Monthly Unit Rates');
  ws4.getColumn('Unit Rate').numFmt = '0.0000'; ws4.getColumn('Units').numFmt = '#,##0';

  // 5) Contract unit rates
  if (reports.contract) {
    const ws = wb.addWorksheet('Contract Unit Rates');
    const rows = reports.contract.fulfillment.map((r) => ({
      'Contracted Rate': r.name, Channel: r.channel, 'Fixed Fee': r.fixedFee,
      'Fee per Unit': r.feePerUnit, 'Avg UPT': r.avgUPT, 'Unit Rate': r.unitRate,
    }));
    addTable(ws, Object.keys(rows[0]), rows);
    ws.getColumn('Unit Rate').numFmt = '0.0000'; ws.getColumn('Avg UPT').numFmt = '#,##0.0';
    ws.addRow([]);
    const t = reports.contract.storage.tiers;
    ws.addRow(['Storage tier', ...Object.keys(t), 'Unit Rate (avg)']).font = { ...FONT, bold: true };
    ws.addRow(['Storage', ...Object.values(t), reports.contract.storage.avg]).font = FONT;
  }

  // 6) Exceptions
  const ex = reports.exceptions.map((l) => ({
    'Source.Name': l.source, OrderID: l.orderId, Service: l.service, Charges: l.charges,
    'Revised Class': l.revisedClass, 'Revised GL Code': l.revisedGl, Flags: l.flags.join(', '),
  }));
  addTable(wb.addWorksheet('Exceptions'), ['Source.Name', 'OrderID', 'Service', 'Charges', 'Revised Class', 'Revised GL Code', 'Flags'], ex, { 'Source.Name': 34, Service: 28, Flags: 30 });

  // 7) Coded lines (replaces Summary_Coded)
  const ws = wb.addWorksheet('Summary_Coded');
  ws.columns = LINE_COLS.map(([h, , w]) => ({ header: h, key: h, width: w }));
  for (const l of lines) {
    ws.addRow(LINE_COLS.map(([, k]) => {
      const v = l[k];
      if (v instanceof Date) return isoDate(v);
      if (Array.isArray(v)) return v.join(', ');
      return v ?? null;
    }));
  }
  styleHeader(ws);
  ['Charges', 'Taxes', 'Inv. Amt', 'Value'].forEach((h) => (ws.getColumn(h).numFmt = MONEY));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: LINE_COLS.length } };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  await wb.xlsx.writeFile(file);
}

export function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, (k, v) => (v instanceof Date ? isoDate(v) : v), 2));
}
