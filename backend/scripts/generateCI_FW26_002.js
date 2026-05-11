'use strict';

/**
 * Generates a Commercial Invoice Excel file for PO-FW26-002
 * following the fixed tentree CI template format expected by ciParser.js:
 *
 *   Row 1  — title row  (merged label)
 *   Row 2  — B2 = invoice number,  D2 = invoice date
 *   Row 3  — (blank spacer)
 *   Row 4  — column headers: SKU | Description | Qty | Unit Price | Total
 *   Row 5+ — one line item per row
 *
 * Columns: A=sku_code  B=description  C=quantity  D=unit_price  E=total_price
 */

const xlsx = require('xlsx');
const path = require('path');

// ── PO-FW26-002 line items ────────────────────────────────────────────────────
const LINE_ITEMS = [
  { sku: 'TEN7201-NVY-XS', desc: 'Organic Cotton Heavyweight Tee Navy',     qty: 300,  unitPrice: 8.20 },
  { sku: 'TEN7201-NVY-S',  desc: 'Organic Cotton Heavyweight Tee Navy',     qty: 600,  unitPrice: 8.20 },
  { sku: 'TEN7201-NVY-M',  desc: 'Organic Cotton Heavyweight Tee Navy',     qty: 900,  unitPrice: 8.20 },
  { sku: 'TEN7201-NVY-L',  desc: 'Organic Cotton Heavyweight Tee Navy',     qty: 900,  unitPrice: 8.20 },
  { sku: 'TEN7201-NVY-XL', desc: 'Organic Cotton Heavyweight Tee Navy',     qty: 600,  unitPrice: 8.20 },
  { sku: 'TEN7201-NVY-2X', desc: 'Organic Cotton Heavyweight Tee Navy',     qty: 300,  unitPrice: 8.20 },
  { sku: 'TEN7201-BRG-XS', desc: 'Organic Cotton Heavyweight Tee Burgundy', qty: 300,  unitPrice: 8.20 },
  { sku: 'TEN7201-BRG-S',  desc: 'Organic Cotton Heavyweight Tee Burgundy', qty: 600,  unitPrice: 8.20 },
  { sku: 'TEN7201-BRG-M',  desc: 'Organic Cotton Heavyweight Tee Burgundy', qty: 900,  unitPrice: 8.20 },
  { sku: 'TEN7201-BRG-L',  desc: 'Organic Cotton Heavyweight Tee Burgundy', qty: 900,  unitPrice: 8.20 },
  { sku: 'TEN7201-BRG-XL', desc: 'Organic Cotton Heavyweight Tee Burgundy', qty: 600,  unitPrice: 8.20 },
  { sku: 'TEN7201-BRG-2X', desc: 'Organic Cotton Heavyweight Tee Burgundy', qty: 300,  unitPrice: 8.20 },
  { sku: 'TEN7201-STN-XS', desc: 'Organic Cotton Heavyweight Tee Stone',    qty: 300,  unitPrice: 8.20 },
  { sku: 'TEN7201-STN-S',  desc: 'Organic Cotton Heavyweight Tee Stone',    qty: 600,  unitPrice: 8.20 },
  { sku: 'TEN7201-STN-M',  desc: 'Organic Cotton Heavyweight Tee Stone',    qty: 900,  unitPrice: 8.20 },
  { sku: 'TEN7201-STN-L',  desc: 'Organic Cotton Heavyweight Tee Stone',    qty: 900,  unitPrice: 8.20 },
  { sku: 'TEN7201-STN-XL', desc: 'Organic Cotton Heavyweight Tee Stone',    qty: 600,  unitPrice: 8.20 },
  { sku: 'TEN7201-STN-2X', desc: 'Organic Cotton Heavyweight Tee Stone',    qty: 300,  unitPrice: 8.20 },
];

const INVOICE_NUMBER = 'CI-FW26-002-001';
const INVOICE_DATE   = '2026-05-09';
const SUPPLIER       = 'Pacific Stitch';
const PO_NUMBER      = 'PO-FW26-002';

// ── Build sheet data as 2-D array ─────────────────────────────────────────────
// Row 1: title
// Row 2: invoice meta  (B=number, D=date)
// Row 3: blank
// Row 4: headers
// Row 5+: line items
const rows = [];

// Row 1 — title
rows.push([`COMMERCIAL INVOICE — ${SUPPLIER} / ${PO_NUMBER}`, '', '', '', '']);

// Row 2 — metadata  (B2 = invoice number, D2 = invoice date)
rows.push(['', INVOICE_NUMBER, '', INVOICE_DATE, '']);

// Row 3 — blank spacer
rows.push(['', '', '', '', '']);

// Row 4 — column headers
rows.push(['SKU Code', 'Description', 'Quantity', 'Unit Price (USD)', 'Total (USD)']);

// Row 5+ — line items
for (const item of LINE_ITEMS) {
  const total = parseFloat((item.qty * item.unitPrice).toFixed(2));
  rows.push([item.sku, item.desc, item.qty, item.unitPrice, total]);
}

// ── Create worksheet & workbook ───────────────────────────────────────────────
const ws = xlsx.utils.aoa_to_sheet(rows);

// Column widths for readability
ws['!cols'] = [
  { wch: 22 },  // A – SKU
  { wch: 44 },  // B – Description
  { wch: 12 },  // C – Qty
  { wch: 18 },  // D – Unit Price
  { wch: 16 },  // E – Total
];

const wb = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(wb, ws, 'Commercial Invoice');

// ── Write to disk ─────────────────────────────────────────────────────────────
const outPath = path.join(__dirname, '..', 'data', 'ci_PO-FW26-002.xlsx');
xlsx.writeFile(wb, outPath);

// Verify by reading back through ciParser
const { parseCIExcel } = require('../services/ciParser');
const fs = require('fs');
const buf = fs.readFileSync(outPath);
const parsed = parseCIExcel(buf);

console.log('File written to:', outPath);
console.log('─── Parsed verification ───────────────────────────────');
console.log('Invoice #  :', parsed.header.invoice_number);
console.log('Date       :', parsed.header.invoice_date);
console.log('Total Value: $' + parsed.header.total_value.toLocaleString('en-US', { minimumFractionDigits: 2 }));
console.log('Line Items :', parsed.lineItems.length);
console.log('──────────────────────────────────────────────────────');
parsed.lineItems.forEach(li =>
  console.log(`  ${li.sku_code.padEnd(22)} qty=${String(li.qty).padStart(5)}  @$${li.unit_price}  = $${li.total.toFixed(2)}`)
);
