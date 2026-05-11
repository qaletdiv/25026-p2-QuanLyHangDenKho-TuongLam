'use strict';
/**
 * Generates the two CI Excel templates with the new layout:
 *
 *   Row 1  : Title
 *   Row 2  : Invoice # (B2) | Invoice Date (D2)
 *   Row 3  : PO Summary header  [PO Number | Shipped Qty | Cartons | Weight (kg) | CBM]
 *   Rows 4–8 : PO data rows (up to 5; parser skips blank rows)
 *   Row 9  : blank separator
 *   Row 10 : SKU column headers  [SKU Code | Description | Quantity | Unit Price | Total]
 *   Row 11+: SKU line items
 *
 * Run: node backend/scripts/generate_ci_templates.js
 */

const xlsx = require('xlsx');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function s(v) { return v === undefined || v === null ? '' : v; }

function buildSheet(invoiceNumber, invoiceDate, poRows, skuRows) {
  // Fixed 10-row header + variable SKU rows
  const EMPTY_PO = ['', '', '', '', ''];
  const poBlock = Array(5).fill(null).map((_, i) => poRows[i] ? poRows[i].map(s) : [...EMPTY_PO]);

  const aoa = [
    // Row 1
    ['COMMERCIAL INVOICE — tentree', '', '', '', ''],
    // Row 2
    ['Invoice #:', s(invoiceNumber), 'Invoice Date:', s(invoiceDate), ''],
    // Row 3  — PO summary header
    ['PO Number', 'Shipped Qty', 'Cartons', 'Weight (kg)', 'CBM'],
    // Rows 4–8 — PO data (5 slots)
    ...poBlock,
    // Row 9  — blank
    ['', '', '', '', ''],
    // Row 10 — SKU header
    ['SKU Code', 'Description', 'Quantity', 'Unit Price', 'Total'],
    // Rows 11+ — SKU data
    ...skuRows.map(r => r.map(s)),
  ];

  const ws = xlsx.utils.aoa_to_sheet(aoa);

  // Column widths
  ws['!cols'] = [
    { wch: 24 }, // A
    { wch: 36 }, // B
    { wch: 14 }, // C
    { wch: 14 }, // D
    { wch: 14 }, // E
  ];

  return ws;
}

// ─── Single-PO template ────────────────────────────────────────────────────────
const singlePoRows = [
  ['PO-FW26-001', 14400, 480, 2160, 48.0],
];
const singleSkuRows = [
  ['TEN7101-FGN-XS', 'Recycled Fleece Pullover Forest Green XS', 800,  16.5, 13200],
  ['TEN7101-FGN-S',  'Recycled Fleece Pullover Forest Green S',  1400, 16.5, 23100],
  ['TEN7101-FGN-M',  'Recycled Fleece Pullover Forest Green M',  2000, 16.5, 33000],
  ['TEN7101-FGN-L',  'Recycled Fleece Pullover Forest Green L',  2000, 16.5, 33000],
  ['TEN7101-FGN-XL', 'Recycled Fleece Pullover Forest Green XL', 900,  16.5, 14850],
  ['TEN7101-FGN-2X', 'Recycled Fleece Pullover Forest Green 2X', 100,  16.5,  1650],
  ['TEN7101-CHR-XS', 'Recycled Fleece Pullover Charcoal XS',     800,  16.5, 13200],
  ['TEN7101-CHR-S',  'Recycled Fleece Pullover Charcoal S',      1400, 16.5, 23100],
  ['TEN7101-CHR-M',  'Recycled Fleece Pullover Charcoal M',      2000, 16.5, 33000],
  ['TEN7101-CHR-L',  'Recycled Fleece Pullover Charcoal L',      2000, 16.5, 33000],
  ['TEN7101-CHR-XL', 'Recycled Fleece Pullover Charcoal XL',     900,  16.5, 14850],
  ['TEN7101-CHR-2X', 'Recycled Fleece Pullover Charcoal 2X',     100,  16.5,  1650],
];

const wbSingle = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(
  wbSingle,
  buildSheet('CI-FW26-001-001', '2026-07-01', singlePoRows, singleSkuRows),
  'Commercial Invoice'
);
xlsx.writeFile(wbSingle, path.join(DATA_DIR, 'ci_template_test.xlsx'));
console.log('✓ ci_template_test.xlsx (single PO)');

// ─── Multi-PO template ─────────────────────────────────────────────────────────
const multiPoRows = [
  ['PO-FW26-001', 14400, 480, 2160, 48.0],
  ['PO-FW26-002', 10800, 360, 1620, 36.0],
];
const multiSkuRows = [
  // PO-FW26-001 SKUs
  ['TEN7101-FGN-XS', 'Recycled Fleece Pullover Forest Green XS', 800,  16.5, 13200],
  ['TEN7101-FGN-S',  'Recycled Fleece Pullover Forest Green S',  1400, 16.5, 23100],
  ['TEN7101-FGN-M',  'Recycled Fleece Pullover Forest Green M',  2000, 16.5, 33000],
  ['TEN7101-FGN-L',  'Recycled Fleece Pullover Forest Green L',  2000, 16.5, 33000],
  ['TEN7101-FGN-XL', 'Recycled Fleece Pullover Forest Green XL', 900,  16.5, 14850],
  ['TEN7101-FGN-2X', 'Recycled Fleece Pullover Forest Green 2X', 100,  16.5,  1650],
  ['TEN7101-CHR-XS', 'Recycled Fleece Pullover Charcoal XS',     800,  16.5, 13200],
  ['TEN7101-CHR-S',  'Recycled Fleece Pullover Charcoal S',      1400, 16.5, 23100],
  ['TEN7101-CHR-M',  'Recycled Fleece Pullover Charcoal M',      2000, 16.5, 33000],
  ['TEN7101-CHR-L',  'Recycled Fleece Pullover Charcoal L',      2000, 16.5, 33000],
  ['TEN7101-CHR-XL', 'Recycled Fleece Pullover Charcoal XL',     900,  16.5, 14850],
  ['TEN7101-CHR-2X', 'Recycled Fleece Pullover Charcoal 2X',     100,  16.5,  1650],
  // PO-FW26-002 SKUs
  ['TEN7201-NVY-XS', 'Organic Cotton Heavyweight Tee Navy XS',   300,   8.2,  2460],
  ['TEN7201-NVY-S',  'Organic Cotton Heavyweight Tee Navy S',     600,   8.2,  4920],
  ['TEN7201-NVY-M',  'Organic Cotton Heavyweight Tee Navy M',     900,   8.2,  7380],
  ['TEN7201-NVY-L',  'Organic Cotton Heavyweight Tee Navy L',     900,   8.2,  7380],
  ['TEN7201-NVY-XL', 'Organic Cotton Heavyweight Tee Navy XL',    600,   8.2,  4920],
  ['TEN7201-NVY-2X', 'Organic Cotton Heavyweight Tee Navy 2X',    300,   8.2,  2460],
  ['TEN7201-BRG-XS', 'Organic Cotton Heavyweight Tee Burgundy XS',300,  8.2,  2460],
  ['TEN7201-BRG-S',  'Organic Cotton Heavyweight Tee Burgundy S', 600,   8.2,  4920],
  ['TEN7201-BRG-M',  'Organic Cotton Heavyweight Tee Burgundy M', 900,   8.2,  7380],
  ['TEN7201-BRG-L',  'Organic Cotton Heavyweight Tee Burgundy L', 900,   8.2,  7380],
  ['TEN7201-BRG-XL', 'Organic Cotton Heavyweight Tee Burgundy XL',600,  8.2,  4920],
  ['TEN7201-BRG-2X', 'Organic Cotton Heavyweight Tee Burgundy 2X',300,  8.2,  2460],
  ['TEN7201-STN-XS', 'Organic Cotton Heavyweight Tee Stone XS',   300,   8.2,  2460],
  ['TEN7201-STN-S',  'Organic Cotton Heavyweight Tee Stone S',     600,   8.2,  4920],
  ['TEN7201-STN-M',  'Organic Cotton Heavyweight Tee Stone M',     900,   8.2,  7380],
  ['TEN7201-STN-L',  'Organic Cotton Heavyweight Tee Stone L',     900,   8.2,  7380],
  ['TEN7201-STN-XL', 'Organic Cotton Heavyweight Tee Stone XL',    600,   8.2,  4920],
  ['TEN7201-STN-2X', 'Organic Cotton Heavyweight Tee Stone 2X',    300,   8.2,  2460],
];

const wbMulti = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(
  wbMulti,
  buildSheet('CI-FW26-001-002-001', '2026-07-01', multiPoRows, multiSkuRows),
  'Commercial Invoice'
);
xlsx.writeFile(wbMulti, path.join(DATA_DIR, 'ci_template_multi.xlsx'));
console.log('✓ ci_template_multi.xlsx (multi-PO: 2 POs)');

// ─── PO-FW26-005 partial shipment CI ──────────────────────────────────────────
// 1200 of 2400 expected units shipped (partial)
const fw26_005_poRows = [
  ['PO-FW26-005', 1200, 50, 480.0, 4.8],
];
const fw26_005_skuRows = [
  ['TEN7501-OTM-S',  'Merino Wool Crewneck Knit Oatmeal S',  150, 34.0,  5100],
  ['TEN7501-OTM-M',  'Merino Wool Crewneck Knit Oatmeal M',  250, 34.0,  8500],
  ['TEN7501-OTM-L',  'Merino Wool Crewneck Knit Oatmeal L',  250, 34.0,  8500],
  ['TEN7501-OTM-XL', 'Merino Wool Crewneck Knit Oatmeal XL', 150, 34.0,  5100],
  ['TEN7501-GRY-S',  'Merino Wool Crewneck Knit Grey S',     100, 34.0,  3400],
  ['TEN7501-GRY-M',  'Merino Wool Crewneck Knit Grey M',     150, 34.0,  5100],
  ['TEN7501-GRY-L',  'Merino Wool Crewneck Knit Grey L',     100, 34.0,  3400],
  ['TEN7501-GRY-XL', 'Merino Wool Crewneck Knit Grey XL',    50,  34.0,  1700],
];

const wbFw26_005 = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(
  wbFw26_005,
  buildSheet('CI-FW26-005-001', '2026-05-09', fw26_005_poRows, fw26_005_skuRows),
  'Commercial Invoice'
);
xlsx.writeFile(wbFw26_005, path.join(DATA_DIR, 'ci_fw26_005_partial.xlsx'));
console.log('✓ ci_fw26_005_partial.xlsx (PO-FW26-005, 1200/2400 units partial)');

// ─── PO-FW26-001 + PO-FW26-007 multi-PO CI ────────────────────────────────────
const fw26_001_007_poRows = [
  ['PO-FW26-001', 14400, 480, 2160.0, 48.0],
  ['PO-FW26-007', 3600,  120,  540.0, 12.0],
];
const fw26_001_007_skuRows = [
  // PO-FW26-001
  ['TEN7101-FGN-XS', 'Recycled Fleece Pullover Forest Green XS', 800,  16.5, 13200],
  ['TEN7101-FGN-S',  'Recycled Fleece Pullover Forest Green S',  1400, 16.5, 23100],
  ['TEN7101-FGN-M',  'Recycled Fleece Pullover Forest Green M',  2000, 16.5, 33000],
  ['TEN7101-FGN-L',  'Recycled Fleece Pullover Forest Green L',  2000, 16.5, 33000],
  ['TEN7101-FGN-XL', 'Recycled Fleece Pullover Forest Green XL', 900,  16.5, 14850],
  ['TEN7101-FGN-2X', 'Recycled Fleece Pullover Forest Green 2X', 100,  16.5,  1650],
  ['TEN7101-CHR-XS', 'Recycled Fleece Pullover Charcoal XS',     800,  16.5, 13200],
  ['TEN7101-CHR-S',  'Recycled Fleece Pullover Charcoal S',      1400, 16.5, 23100],
  ['TEN7101-CHR-M',  'Recycled Fleece Pullover Charcoal M',      2000, 16.5, 33000],
  ['TEN7101-CHR-L',  'Recycled Fleece Pullover Charcoal L',      2000, 16.5, 33000],
  ['TEN7101-CHR-XL', 'Recycled Fleece Pullover Charcoal XL',     900,  16.5, 14850],
  ['TEN7101-CHR-2X', 'Recycled Fleece Pullover Charcoal 2X',     100,  16.5,  1650],
  // PO-FW26-007
  ['TEN7701-SLT-XS', 'Organic Denim Jacket Slate XS',  150, 42.0,  6300],
  ['TEN7701-SLT-S',  'Organic Denim Jacket Slate S',   600, 42.0, 25200],
  ['TEN7701-SLT-M',  'Organic Denim Jacket Slate M',   900, 42.0, 37800],
  ['TEN7701-SLT-L',  'Organic Denim Jacket Slate L',   900, 42.0, 37800],
  ['TEN7701-SLT-XL', 'Organic Denim Jacket Slate XL',  600, 42.0, 25200],
  ['TEN7701-SLT-2X', 'Organic Denim Jacket Slate 2X',  450, 42.0, 18900],
];

const wbFw26_001_007 = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(
  wbFw26_001_007,
  buildSheet('CI-FW26-001-007-001', '2026-07-01', fw26_001_007_poRows, fw26_001_007_skuRows),
  'Commercial Invoice'
);
xlsx.writeFile(wbFw26_001_007, path.join(DATA_DIR, 'ci_fw26_001_007_multi.xlsx'));
console.log('✓ ci_fw26_001_007_multi.xlsx (PO-FW26-001 + PO-FW26-007, multi-PO)');

// ─── PO-FW26-002 standalone CI ─────────────────────────────────────────────────
const fw26_002_poRows = [
  ['PO-FW26-002', 10800, 360, 1620.0, 36.0],
];
const fw26_002_skuRows = [
  ['TEN7201-NVY-XS', 'Organic Cotton Heavyweight Tee Navy XS',      300, 8.2,  2460],
  ['TEN7201-NVY-S',  'Organic Cotton Heavyweight Tee Navy S',        600, 8.2,  4920],
  ['TEN7201-NVY-M',  'Organic Cotton Heavyweight Tee Navy M',        900, 8.2,  7380],
  ['TEN7201-NVY-L',  'Organic Cotton Heavyweight Tee Navy L',        900, 8.2,  7380],
  ['TEN7201-NVY-XL', 'Organic Cotton Heavyweight Tee Navy XL',       600, 8.2,  4920],
  ['TEN7201-NVY-2X', 'Organic Cotton Heavyweight Tee Navy 2X',       300, 8.2,  2460],
  ['TEN7201-BRG-XS', 'Organic Cotton Heavyweight Tee Burgundy XS',   300, 8.2,  2460],
  ['TEN7201-BRG-S',  'Organic Cotton Heavyweight Tee Burgundy S',    600, 8.2,  4920],
  ['TEN7201-BRG-M',  'Organic Cotton Heavyweight Tee Burgundy M',    900, 8.2,  7380],
  ['TEN7201-BRG-L',  'Organic Cotton Heavyweight Tee Burgundy L',    900, 8.2,  7380],
  ['TEN7201-BRG-XL', 'Organic Cotton Heavyweight Tee Burgundy XL',   600, 8.2,  4920],
  ['TEN7201-BRG-2X', 'Organic Cotton Heavyweight Tee Burgundy 2X',   300, 8.2,  2460],
  ['TEN7201-STN-XS', 'Organic Cotton Heavyweight Tee Stone XS',      300, 8.2,  2460],
  ['TEN7201-STN-S',  'Organic Cotton Heavyweight Tee Stone S',        600, 8.2,  4920],
  ['TEN7201-STN-M',  'Organic Cotton Heavyweight Tee Stone M',        900, 8.2,  7380],
  ['TEN7201-STN-L',  'Organic Cotton Heavyweight Tee Stone L',        900, 8.2,  7380],
  ['TEN7201-STN-XL', 'Organic Cotton Heavyweight Tee Stone XL',       600, 8.2,  4920],
  ['TEN7201-STN-2X', 'Organic Cotton Heavyweight Tee Stone 2X',       300, 8.2,  2460],
];

const wbFw26_002 = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(
  wbFw26_002,
  buildSheet('CI-FW26-002-001', '2026-07-01', fw26_002_poRows, fw26_002_skuRows),
  'Commercial Invoice'
);
xlsx.writeFile(wbFw26_002, path.join(DATA_DIR, 'ci_PO-FW26-002.xlsx'));
console.log('✓ ci_PO-FW26-002.xlsx (PO-FW26-002 standalone)');
