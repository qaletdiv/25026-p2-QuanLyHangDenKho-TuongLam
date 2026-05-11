'use strict';

/**
 * Generates a sample Commercial Invoice Excel template
 * that matches the ciParser DEFAULT_CONFIG layout:
 *
 *   B2 = invoice_number   D2 = invoice_date
 *   Row 4 = column headers
 *   Row 5+ = line-item data  (A=SKU, B=Description, C=Qty, D=Unit Price, E=Total)
 */

const xlsx = require('xlsx');
const path = require('path');

const wb = xlsx.utils.book_new();

// ── Build worksheet data as 2-D array (row-major, 1-indexed display) ─────────
// Row 1: document title
// Row 2: invoice metadata labels + values
// Row 3: blank separator
// Row 4: column headers
// Row 5+: sample line items

const rows = [
    // Row 1
    ['COMMERCIAL INVOICE', '', '', '', ''],
    // Row 2  — B2 = invoice number, D2 = invoice date
    ['', 'INV-2024-001', '', '2024-06-15', ''],
    // Row 3  — blank
    ['', '', '', '', ''],
    // Row 4  — column headers
    ['SKU Code', 'Description', 'Quantity', 'Unit Price (USD)', 'Total Price (USD)'],
    // Row 5+  — sample SKUs
    ['TT-BLK-S',  'Tentree Classic Tee - Black / S',  120, 12.50, 1500.00],
    ['TT-BLK-M',  'Tentree Classic Tee - Black / M',  200, 12.50, 2500.00],
    ['TT-BLK-L',  'Tentree Classic Tee - Black / L',  150, 12.50, 1875.00],
    ['TT-WHT-S',  'Tentree Classic Tee - White / S',   80, 12.50, 1000.00],
    ['TT-WHT-M',  'Tentree Classic Tee - White / M',  180, 12.50, 2250.00],
    ['TT-WHT-L',  'Tentree Classic Tee - White / L',  100, 12.50, 1250.00],
    ['TT-HDIE-M', 'Tentree Pullover Hoodie - M',        60, 28.00, 1680.00],
    ['TT-HDIE-L', 'Tentree Pullover Hoodie - L',        40, 28.00, 1120.00],
];

const ws = xlsx.utils.aoa_to_sheet(rows);

// ── Column widths ─────────────────────────────────────────────────────────────
ws['!cols'] = [
    { wch: 16 },  // A  SKU Code
    { wch: 38 },  // B  Description
    { wch: 12 },  // C  Quantity
    { wch: 18 },  // D  Unit Price
    { wch: 20 },  // E  Total Price
];

xlsx.utils.book_append_sheet(wb, ws, 'Commercial Invoice');

const outPath = path.resolve(__dirname, '../data/ci_template_test.xlsx');
xlsx.writeFile(wb, outPath);
console.log(`Template written to: ${outPath}`);
