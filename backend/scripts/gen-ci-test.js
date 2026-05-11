'use strict';
const path = require('path');
const xlsx = require(path.join(__dirname, '../node_modules/xlsx'));
const dataDir = path.join(__dirname, '../data');

function buildSheet(invoiceNum, invoiceDate, rows) {
  const ws = {};
  // Metadata
  ws['B2'] = { v: invoiceNum, t: 's' };
  ws['D2'] = { v: invoiceDate, t: 's' };
  // Header row (row 4 for visual, data starts row 5)
  ws['A4'] = { v: 'SKU Code', t: 's' };
  ws['B4'] = { v: 'Description', t: 's' };
  ws['C4'] = { v: 'Qty', t: 's' };
  ws['D4'] = { v: 'Unit Price', t: 's' };
  ws['E4'] = { v: 'Total', t: 's' };
  let maxRow = 4;
  rows.forEach((r, i) => {
    const row = 5 + i;
    ws[`A${row}`] = { v: r[0], t: 's' };
    ws[`B${row}`] = { v: r[1], t: 's' };
    ws[`C${row}`] = { v: r[2], t: 'n' };
    ws[`D${row}`] = { v: r[3], t: 'n' };
    ws[`E${row}`] = { v: r[4], t: 'n' };
    maxRow = row;
  });
  ws['!ref'] = `A1:E${maxRow}`;
  return ws;
}

// CI 1: PO-FW26-005 partial (50%)
const rows1 = [
  ['TEN7501-OTM-S',  'Merino Wool Crewneck Knit Oatmeal',    150, 34, 5100],
  ['TEN7501-OTM-M',  'Merino Wool Crewneck Knit Oatmeal',    250, 34, 8500],
  ['TEN7501-OTM-L',  'Merino Wool Crewneck Knit Oatmeal',    250, 34, 8500],
  ['TEN7501-OTM-XL', 'Merino Wool Crewneck Knit Oatmeal',    150, 34, 5100],
  ['TEN7501-SLT-S',  'Merino Wool Crewneck Knit Slate Blue', 100, 34, 3400],
  ['TEN7501-SLT-M',  'Merino Wool Crewneck Knit Slate Blue', 150, 34, 5100],
  ['TEN7501-SLT-L',  'Merino Wool Crewneck Knit Slate Blue', 100, 34, 3400],
  ['TEN7501-SLT-XL', 'Merino Wool Crewneck Knit Slate Blue',  50, 34, 1700],
];
const wb1 = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(wb1, buildSheet('CI-FW26-005-001', '2026-05-09', rows1), 'CI');
xlsx.writeFile(wb1, path.join(dataDir, 'ci_fw26_005_partial.xlsx'));
console.log('Written: ci_fw26_005_partial.xlsx (1200 units)');

// CI 2: PO-FW26-001 + PO-FW26-007 multi
const rows2 = [
  ['TEN7101-FGN-XS', 'Recycled Fleece Pullover Forest Green',  400, 16.5,  6600],
  ['TEN7101-FGN-S',  'Recycled Fleece Pullover Forest Green',  700, 16.5, 11550],
  ['TEN7101-FGN-M',  'Recycled Fleece Pullover Forest Green', 1000, 16.5, 16500],
  ['TEN7101-FGN-L',  'Recycled Fleece Pullover Forest Green', 1000, 16.5, 16500],
  ['TEN7101-CHR-XS', 'Recycled Fleece Pullover Charcoal',      400, 16.5,  6600],
  ['TEN7101-CHR-S',  'Recycled Fleece Pullover Charcoal',      700, 16.5, 11550],
  ['TEN7601-NVY-S',  'Recycled Fleece Hoodie Navy',            500, 18,    9000],
  ['TEN7601-NVY-M',  'Recycled Fleece Hoodie Navy',            800, 18,   14400],
  ['TEN7601-NVY-L',  'Recycled Fleece Hoodie Navy',            700, 18,   12600],
  ['TEN7601-NVY-XL', 'Recycled Fleece Hoodie Navy',            400, 18,    7200],
  ['TEN7601-NVY-2X', 'Recycled Fleece Hoodie Navy',            100, 18,    1800],
];
const wb2 = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(wb2, buildSheet('CI-FW26-001-007-001', '2026-05-09', rows2), 'CI');
xlsx.writeFile(wb2, path.join(dataDir, 'ci_fw26_001_007_multi.xlsx'));
console.log('Written: ci_fw26_001_007_multi.xlsx (6300 units)');
