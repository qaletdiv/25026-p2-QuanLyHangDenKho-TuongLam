'use strict';

const ExcelJS = require('exceljs');
const path = require('path');

// ── Brand Colours ───────────────────────────────────────────────────────────
const GREEN_DARK  = { argb: 'FF1B4332' };
const GREEN_MID   = { argb: 'FF2D6A4F' };
const GREEN_LIGHT = { argb: 'FFD8F3DC' };   // vendor input cells
const YELLOW_FILL = { argb: 'FFFFFDE7' };   // formula cells
const GRAY_BG     = { argb: 'FFF5F5F5' };
const WHITE       = { argb: 'FFFFFFFF' };
const BLACK       = { argb: 'FF000000' };

// ── Fonts ───────────────────────────────────────────────────────────────────
const titleFont     = { name: 'Calibri', size: 14, bold: true, color: GREEN_DARK };
const headerFont    = { name: 'Calibri', size: 10, bold: true, color: WHITE };
const labelFont     = { name: 'Calibri', size: 10, bold: true, color: BLACK };
const inputFont     = { name: 'Calibri', size: 10, color: BLACK };
const formulaFont   = { name: 'Calibri', size: 10, color: { argb: 'FF1B5E20' }, bold: true };
const metaLabelFont = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF424242' } };
const noteFont      = { name: 'Calibri', size: 8, italic: true, color: { argb: 'FF888888' } };
const sectionFont   = { name: 'Calibri', size: 11, bold: true, color: GREEN_DARK };

const thinBorder = {
  top:    { style: 'thin', color: { argb: 'FFB0B0B0' } },
  left:   { style: 'thin', color: { argb: 'FFB0B0B0' } },
  bottom: { style: 'thin', color: { argb: 'FFB0B0B0' } },
  right:  { style: 'thin', color: { argb: 'FFB0B0B0' } },
};

const greenFill  = { type: 'pattern', pattern: 'solid', fgColor: GREEN_LIGHT };
const yellowFill = { type: 'pattern', pattern: 'solid', fgColor: YELLOW_FILL };
const darkFill   = { type: 'pattern', pattern: 'solid', fgColor: GREEN_DARK };
const midFill    = { type: 'pattern', pattern: 'solid', fgColor: GREEN_MID };
const grayFill   = { type: 'pattern', pattern: 'solid', fgColor: GRAY_BG };

// ── Layout constants (parser depends on these) ──────────────────────────────
const CI_DATA_ROWS     = 100;
const CI_HEADER_ROW    = 21;
const CI_FIRST_DATA    = 22;
const CI_LAST_DATA     = CI_FIRST_DATA + CI_DATA_ROWS - 1; // 121

const PL_DATA_ROWS     = 500;
const PL_HEADER_ROW    = 14;
const PL_FIRST_DATA    = 15;
const PL_LAST_DATA     = PL_FIRST_DATA + PL_DATA_ROWS - 1; // 514

// ═════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═════════════════════════════════════════════════════════════════════════════

function inputCell(cell, opts = {}) {
  cell.font = opts.font || inputFont;
  cell.fill = greenFill;
  cell.border = thinBorder;
  cell.alignment = { horizontal: opts.align || 'left', vertical: 'middle', ...(opts.wrap ? { wrapText: true } : {}) };
  cell.protection = { locked: false };
  if (opts.numFmt) cell.numFmt = opts.numFmt;
}

function metaLabel(cell, text) {
  cell.value = text;
  cell.font = metaLabelFont;
  cell.alignment = { horizontal: 'right', vertical: 'middle' };
  cell.border = thinBorder;
}

function metaValue(cell, opts = {}) {
  cell.font = inputFont;
  cell.fill = greenFill;
  cell.border = thinBorder;
  cell.alignment = { horizontal: 'left', vertical: 'middle' };
  cell.protection = { locked: false };
  if (opts.numFmt) cell.numFmt = opts.numFmt;
}

// ═════════════════════════════════════════════════════════════════════════════
//  SHEET 1: Commercial Invoice
// ═════════════════════════════════════════════════════════════════════════════

function buildCiSheet(wb) {
  const ws = wb.addWorksheet('Commercial Invoice', {
    properties: { tabColor: GREEN_DARK },
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true },
    views: [{ state: 'frozen', ySplit: CI_HEADER_ROW, activeCell: 'A22' }],
  });

  // ── Column widths ──────────────────────────────────────────────────────
  ws.columns = [
    { key: 'A', width: 18 },   // PO#
    { key: 'B', width: 24 },   // SKU
    { key: 'C', width: 18 },   // UPC
    { key: 'D', width: 13 },   // Knit/Woven
    { key: 'E', width: 32 },   // Style Description
    { key: 'F', width: 24 },   // Color Description
    { key: 'G', width: 14 },   // Category
    { key: 'H', width: 12 },   // Gender
    { key: 'I', width: 26 },   // Composition  (also metadata labels)
    { key: 'J', width: 16 },   // HTS Code
    { key: 'K', width: 14 },   // Quantity      (also metadata values)
    { key: 'L', width: 16 },   // Unit Price USD
    { key: 'M', width: 16 },   // Total USD
  ];

  // ===================================================================
  //  HEADER BLOCK — Rows 1-20 (matches tentree CI template layout)
  // ===================================================================

  // ── Row 1: Supplier Name ───────────────────────────────────────────
  ws.getRow(1).height = 24;
  ws.mergeCells('A1:H1');
  const a1 = ws.getCell('A1');
  a1.value = 'Supplier Name';
  a1.font = { ...inputFont, color: { argb: 'FF999999' } };
  a1.fill = greenFill;
  a1.border = thinBorder;
  a1.alignment = { horizontal: 'left', vertical: 'middle' };
  a1.protection = { locked: false };

  // ── Rows 2-4: Supplier address + Contact  |  PO#, Invoice#, Date ──
  const supplierRows = [
    { row: 2, leftText: 'Supplier address',            rightLabel: 'PO #',      rightCell: 'K2' },
    { row: 3, leftText: 'Supplier address',            rightLabel: 'Invoice #', rightCell: 'K3' },
    { row: 4, leftText: 'Supplier contact information', rightLabel: 'Date',      rightCell: 'K4' },
  ];
  supplierRows.forEach(({ row, leftText, rightLabel, rightCell }) => {
    ws.getRow(row).height = 20;
    ws.mergeCells(`A${row}:H${row}`);
    const left = ws.getCell(`A${row}`);
    left.value = leftText;
    left.font = { ...inputFont, color: { argb: 'FF999999' } };
    left.fill = greenFill;
    left.border = thinBorder;
    left.alignment = { horizontal: 'left', vertical: 'middle' };
    left.protection = { locked: false };

    metaLabel(ws.getCell(`I${row}`), rightLabel);
    ws.mergeCells(`J${row}:K${row}`);
    metaValue(ws.getCell(`J${row}`),
      rightLabel === 'Date' ? { numFmt: 'YYYY-MM-DD' } : {});
  });

  // ── Row 5: blank spacer ───────────────────────────────────────────
  ws.getRow(5).height = 6;

  // ── Rows 6-9: Manufacturer  |  Shipping Mode, Shipment#, ETA, Port of Loading
  const mfgRows = [
    { row: 6,  leftText: 'Manufacturer Name',               rightLabel: 'Shipping Mode' },
    { row: 7,  leftText: 'Manufacturer address',             rightLabel: 'Shipment #' },
    { row: 8,  leftText: 'Manufacturer address',             rightLabel: 'ETA Date' },
    { row: 9,  leftText: 'Manufacturer contact information', rightLabel: 'Port of Loading' },
  ];
  mfgRows.forEach(({ row, leftText, rightLabel }) => {
    ws.getRow(row).height = 20;
    ws.mergeCells(`A${row}:H${row}`);
    const left = ws.getCell(`A${row}`);
    left.value = leftText;
    left.font = { ...inputFont, color: { argb: 'FF999999' } };
    left.fill = greenFill;
    left.border = thinBorder;
    left.alignment = { horizontal: 'left', vertical: 'middle' };
    left.protection = { locked: false };

    metaLabel(ws.getCell(`I${row}`), rightLabel);
    ws.mergeCells(`J${row}:K${row}`);
    metaValue(ws.getCell(`J${row}`),
      rightLabel === 'ETA Date' ? { numFmt: 'YYYY-MM-DD' } : {});
  });

  // ── Row 10-11: Port of Discharge, Remarks ─────────────────────────
  [
    { row: 10, label: 'Port of Discharge' },
    { row: 11, label: 'Remarks' },
  ].forEach(({ row, label }) => {
    ws.getRow(row).height = 20;
    metaLabel(ws.getCell(`I${row}`), label);
    ws.mergeCells(`J${row}:K${row}`);
    metaValue(ws.getCell(`J${row}`));
  });

  // ── Row 12: "Commercial Invoice" title  |  Country of Origin ──────
  ws.getRow(12).height = 24;
  ws.mergeCells('A12:H12');
  const ciTitle = ws.getCell('A12');
  ciTitle.value = 'Commercial Invoice';
  ciTitle.font = titleFont;
  ciTitle.alignment = { horizontal: 'left', vertical: 'middle' };

  metaLabel(ws.getCell('I12'), 'Country of Origin');
  ws.mergeCells('J12:K12');
  metaValue(ws.getCell('J12'));

  // ── Row 13: blank ─────────────────────────────────────────────────
  ws.getRow(13).height = 8;

  // ── Rows 14-18: Consignee + Notify Party ──────────────────────────
  ws.getRow(14).height = 20;
  ws.mergeCells('A14:C14');
  ws.getCell('A14').value = 'Consignee';
  ws.getCell('A14').font = sectionFont;
  ws.getCell('A14').border = { bottom: { style: 'thin', color: GREEN_DARK } };

  ws.mergeCells('D14:H14');
  ws.getCell('D14').value = 'Notify Party';
  ws.getCell('D14').font = sectionFont;
  ws.getCell('D14').border = { bottom: { style: 'thin', color: GREEN_DARK } };

  const consignee = [
    'Warehouse name',
    'Warehouse address',
    'Warehouse address',
    'Contact information',
  ];
  const notifyParty = [
    'tentree International',
    '230-1275 Venables St.',
    'Vancouver, BC V6A 2E4',
    '604-829-2706',
  ];
  for (let i = 0; i < 4; i++) {
    const row = 15 + i;
    ws.getRow(row).height = 18;
    ws.mergeCells(`A${row}:C${row}`);
    const cCell = ws.getCell(`A${row}`);
    // Consignee fields are editable (vendor fills in their warehouse)
    cCell.value = consignee[i];
    cCell.font = { ...inputFont, color: { argb: 'FF999999' } };
    cCell.fill = greenFill;
    cCell.border = thinBorder;
    cCell.protection = { locked: false };

    ws.mergeCells(`D${row}:H${row}`);
    const nCell = ws.getCell(`D${row}`);
    nCell.value = notifyParty[i];
    nCell.font = inputFont;
    nCell.border = thinBorder;
  }

  // ── Row 19-20: spacer + instruction note ──────────────────────────
  ws.getRow(19).height = 6;
  ws.getRow(20).height = 18;
  ws.mergeCells('A20:M20');
  ws.getCell('A20').value = 'Fill green cells. Total USD is auto-calculated. See Instructions sheet for field descriptions.';
  ws.getCell('A20').font = noteFont;
  ws.getCell('A20').alignment = { horizontal: 'left', vertical: 'middle' };

  // ===================================================================
  //  ROW 21 — Column Headers
  // ===================================================================
  ws.getRow(CI_HEADER_ROW).height = 24;
  const ciHeaders = [
    'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description',
    'Color Description', 'Category', 'Gender', 'Composition',
    'HTS Code', 'Quantity', 'Unit Price USD', 'Total USD',
  ];
  const ciCols = ['A','B','C','D','E','F','G','H','I','J','K','L','M'];
  ciCols.forEach((col, i) => {
    const cell = ws.getCell(`${col}${CI_HEADER_ROW}`);
    cell.value = ciHeaders[i];
    cell.font = headerFont;
    cell.fill = darkFill;
    cell.border = thinBorder;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });

  // ===================================================================
  //  ROWS 22-121 — Data Rows (100 rows)
  // ===================================================================
  for (let r = CI_FIRST_DATA; r <= CI_LAST_DATA; r++) {
    ws.getRow(r).height = 18;

    // Text columns: A-J (unlocked, green)
    ['A','B','C','D','E','F','G','H','I','J'].forEach(col => {
      inputCell(ws.getCell(`${col}${r}`), {
        font: col === 'B' ? { ...inputFont, name: 'Consolas', size: 10 } : inputFont,
        align: ['E','F','I'].includes(col) ? 'left' : 'center',
      });
    });

    // K — Quantity (unlocked, green, integer)
    inputCell(ws.getCell(`K${r}`), { align: 'center', numFmt: '#,##0' });

    // L — Unit Price (unlocked, green, 2 decimals)
    inputCell(ws.getCell(`L${r}`), { align: 'center', numFmt: '#,##0.00' });

    // M — Total USD (formula, locked, yellow)
    const cellM = ws.getCell(`M${r}`);
    cellM.value = { formula: `IF(K${r}="","",K${r}*L${r})`, result: 0 };
    cellM.font = formulaFont;
    cellM.fill = yellowFill;
    cellM.border = thinBorder;
    cellM.alignment = { horizontal: 'center', vertical: 'middle' };
    cellM.numFmt = '#,##0.00';
    cellM.protection = { locked: true };
  }

  // ===================================================================
  //  TOTALS ROW
  // ===================================================================
  const totalsRow = CI_LAST_DATA + 1;
  ws.getRow(totalsRow).height = 24;

  // Blank cells A-J
  ['A','B','C','D','E','F','G','H','I','J'].forEach(col => {
    const cell = ws.getCell(`${col}${totalsRow}`);
    cell.fill = yellowFill;
    cell.border = thinBorder;
  });
  ws.getCell(`J${totalsRow}`).value = 'TOTALS';
  ws.getCell(`J${totalsRow}`).font = { ...labelFont, color: GREEN_DARK };
  ws.getCell(`J${totalsRow}`).alignment = { horizontal: 'right', vertical: 'middle' };

  // K — Total Quantity
  const tK = ws.getCell(`K${totalsRow}`);
  tK.value = { formula: `SUM(K${CI_FIRST_DATA}:K${CI_LAST_DATA})`, result: 0 };
  tK.font = { ...formulaFont, size: 11 };
  tK.fill = yellowFill;
  tK.border = thinBorder;
  tK.alignment = { horizontal: 'center', vertical: 'middle' };
  tK.numFmt = '#,##0';
  tK.protection = { locked: true };

  // L — blank (no total for unit price)
  ws.getCell(`L${totalsRow}`).fill = yellowFill;
  ws.getCell(`L${totalsRow}`).border = thinBorder;

  // M — Total USD
  const tM = ws.getCell(`M${totalsRow}`);
  tM.value = { formula: `SUM(M${CI_FIRST_DATA}:M${CI_LAST_DATA})`, result: 0 };
  tM.font = { ...formulaFont, size: 11 };
  tM.fill = yellowFill;
  tM.border = thinBorder;
  tM.alignment = { horizontal: 'center', vertical: 'middle' };
  tM.numFmt = '#,##0.00';
  tM.protection = { locked: true };

  // ===================================================================
  //  Sheet Protection
  // ===================================================================
  ws.protect('tentree2026', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    deleteColumns: false,
    deleteRows: false,
    sort: false,
    autoFilter: false,
  });

  ws.pageSetup.printArea = `A1:M${totalsRow}`;
  return ws;
}

// ═════════════════════════════════════════════════════════════════════════════
//  SHEET 2: Packing List
// ═════════════════════════════════════════════════════════════════════════════

function buildPlSheet(wb) {
  const ws = wb.addWorksheet('Packing List', {
    properties: { tabColor: GREEN_MID },
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true },
    views: [{ state: 'frozen', ySplit: PL_HEADER_ROW, activeCell: 'A15' }],
  });

  ws.columns = [
    { key: 'A', width: 14 },   // CTN #
    { key: 'B', width: 14 },   // TOTAL/CTN
    { key: 'C', width: 18 },   // PO #
    { key: 'D', width: 24 },   // SKU
    { key: 'E', width: 18 },   // UPC
    { key: 'F', width: 30 },   // Style Description
    { key: 'G', width: 22 },   // Color Description
    { key: 'H', width: 12 },   // PCS/CTN
    { key: 'I', width: 12 },   // TOTAL/PCS
    { key: 'J', width: 12 },   // N/W (KGS)
    { key: 'K', width: 12 },   // G/W (KGS)
    { key: 'L', width: 22 },   // MEASURE (L×W×H cm)
  ];

  // ===================================================================
  //  HEADER BLOCK — Rows 1-13
  // ===================================================================

  // ── Row 1: Supplier Name ──────────────────────────────────────────
  ws.getRow(1).height = 22;
  ws.mergeCells('A1:L1');
  const s1 = ws.getCell('A1');
  s1.value = 'Supplier Name';
  s1.font = { ...inputFont, color: { argb: 'FF999999' }, bold: true };
  s1.fill = greenFill;
  s1.border = thinBorder;
  s1.protection = { locked: false };

  // ── Row 2: Supplier Address ───────────────────────────────────────
  ws.getRow(2).height = 18;
  ws.mergeCells('A2:L2');
  const s2 = ws.getCell('A2');
  s2.value = 'Supplier address';
  s2.font = { ...inputFont, color: { argb: 'FF999999' } };
  s2.fill = greenFill;
  s2.border = thinBorder;
  s2.protection = { locked: false };

  // ── Row 3: PACKING LIST title ─────────────────────────────────────
  ws.getRow(3).height = 28;
  ws.mergeCells('A3:L3');
  ws.getCell('A3').value = 'PACKING LIST';
  ws.getCell('A3').font = titleFont;
  ws.getCell('A3').alignment = { horizontal: 'left', vertical: 'middle' };

  // ── Row 4: blank ──────────────────────────────────────────────────
  ws.getRow(4).height = 6;

  // ── Row 5: Section labels ─────────────────────────────────────────
  ws.getRow(5).height = 20;
  ws.mergeCells('A5:E5');
  ws.getCell('A5').value = 'Consignee';
  ws.getCell('A5').font = sectionFont;
  ws.getCell('A5').border = { bottom: { style: 'thin', color: GREEN_DARK } };

  ws.mergeCells('F5:H5');
  ws.getCell('F5').value = 'Notify Party';
  ws.getCell('F5').font = sectionFont;
  ws.getCell('F5').border = { bottom: { style: 'thin', color: GREEN_DARK } };

  metaLabel(ws.getCell('I5'), 'PO #');
  metaValue(ws.getCell('J5'));

  // ── Rows 6-11: Address blocks + metadata ──────────────────────────
  const plConsignee = [
    'Warehouse name',
    'Warehouse address',
    'Warehouse address',
    'Warehouse city/state',
    'Country',
    'Tel:',
  ];
  const plNotify = [
    'tentree International Inc.',
    '230-1275 Venables St.',
    'Vancouver, BC V6A 2E4',
    'Canada',
    '604-829-2706',
    '',
  ];
  const plMeta = [
    { label: 'Invoice NO.',    cell: 'J6' },
    { label: 'S/C NO.',        cell: 'J7' },
    { label: null,              cell: null },
    { label: 'Packing List No.', cell: 'J9' },
    { label: 'DATE:',          cell: 'J10', numFmt: 'YYYY-MM-DD' },
    { label: 'PAGE:',          cell: 'J11' },
  ];

  for (let i = 0; i < 6; i++) {
    const row = 6 + i;
    ws.getRow(row).height = 18;

    // Consignee column (A-E)
    ws.mergeCells(`A${row}:E${row}`);
    const cCell = ws.getCell(`A${row}`);
    cCell.value = plConsignee[i];
    cCell.font = { ...inputFont, color: { argb: 'FF999999' } };
    cCell.fill = greenFill;
    cCell.border = thinBorder;
    cCell.protection = { locked: false };

    // Notify Party column (F-H)
    ws.mergeCells(`F${row}:H${row}`);
    const nCell = ws.getCell(`F${row}`);
    nCell.value = plNotify[i];
    nCell.font = inputFont;
    nCell.border = thinBorder;

    // Right-side metadata (I-J)
    const meta = plMeta[i];
    if (meta.label) {
      metaLabel(ws.getCell(`I${row}`), meta.label);
      metaValue(ws.getCell(meta.cell), meta.numFmt ? { numFmt: meta.numFmt } : {});
    }
  }

  // ── Row 12-13: blank spacer ───────────────────────────────────────
  ws.getRow(12).height = 6;
  ws.getRow(13).height = 6;

  // ===================================================================
  //  ROW 14 — Column Headers
  // ===================================================================
  ws.getRow(PL_HEADER_ROW).height = 24;
  const plHeaders = [
    'CTN #', 'TOTAL/CTN', 'PO #', 'SKU', 'UPC',
    'Style Description', 'Color Description',
    'PCS/CTN', 'TOTAL/PCS', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (L×W×H cm)',
  ];
  const plCols = ['A','B','C','D','E','F','G','H','I','J','K','L'];
  plCols.forEach((col, i) => {
    const cell = ws.getCell(`${col}${PL_HEADER_ROW}`);
    cell.value = plHeaders[i];
    cell.font = headerFont;
    cell.fill = darkFill;
    cell.border = thinBorder;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });

  // ===================================================================
  //  ROWS 15-514 — Data Rows (500 rows)
  // ===================================================================
  for (let r = PL_FIRST_DATA; r <= PL_LAST_DATA; r++) {
    ws.getRow(r).height = 18;

    plCols.forEach(col => {
      const cell = ws.getCell(`${col}${r}`);
      cell.font = col === 'D' ? { ...inputFont, name: 'Consolas', size: 10 } : inputFont;
      cell.fill = greenFill;
      cell.border = thinBorder;
      cell.protection = { locked: false };

      // Alignment
      if (['F','G','L'].includes(col)) {
        cell.alignment = { horizontal: 'left', vertical: 'middle' };
      } else {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      }

      // Number formats
      if (['B','H','I'].includes(col)) cell.numFmt = '#,##0';
      if (['J','K'].includes(col)) cell.numFmt = '#,##0.00';
    });
  }

  // ===================================================================
  //  TOTALS ROW
  // ===================================================================
  const totalsRow = PL_LAST_DATA + 1;
  ws.getRow(totalsRow).height = 22;

  ws.getCell(`A${totalsRow}`).value = 'TOTAL';
  ws.getCell(`A${totalsRow}`).font = { ...labelFont, color: GREEN_DARK };
  ws.getCell(`A${totalsRow}`).alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getCell(`A${totalsRow}`).fill = yellowFill;
  ws.getCell(`A${totalsRow}`).border = thinBorder;

  // SUM formulas for: B (cartons), I (total pcs), J (N/W), K (G/W)
  ['B', 'I', 'J', 'K'].forEach(col => {
    const cell = ws.getCell(`${col}${totalsRow}`);
    cell.value = { formula: `SUM(${col}${PL_FIRST_DATA}:${col}${PL_LAST_DATA})`, result: 0 };
    cell.font = { ...formulaFont, size: 10 };
    cell.fill = yellowFill;
    cell.border = thinBorder;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.numFmt = col === 'B' || col === 'I' ? '#,##0' : '#,##0.00';
    cell.protection = { locked: true };
  });

  // Fill remaining totals cells
  ['C','D','E','F','G','H','L'].forEach(col => {
    const cell = ws.getCell(`${col}${totalsRow}`);
    cell.fill = yellowFill;
    cell.border = thinBorder;
  });

  // ===================================================================
  //  Sheet Protection
  // ===================================================================
  ws.protect('tentree2026', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    deleteColumns: false,
    deleteRows: false,
    sort: false,
    autoFilter: false,
  });

  ws.pageSetup.printArea = `A1:L${totalsRow}`;
  return ws;
}

// ═════════════════════════════════════════════════════════════════════════════
//  SHEET 3: Instructions
// ═════════════════════════════════════════════════════════════════════════════

function buildInstructionsSheet(wb) {
  const ws = wb.addWorksheet('Instructions', {
    properties: { tabColor: { argb: 'FFFF8F00' } },
  });

  ws.columns = [
    { key: 'A', width: 24 },
    { key: 'B', width: 60 },
    { key: 'C', width: 14 },
  ];

  // Title
  ws.getRow(1).height = 8;
  ws.getRow(2).height = 30;
  ws.mergeCells('A2:B2');
  ws.getCell('A2').value = 'Tentree Commercial Invoice & Packing List Instructions';
  ws.getCell('A2').font = { name: 'Calibri', size: 14, bold: true, color: GREEN_DARK };

  // CI instructions
  ws.getRow(4).height = 22;
  ws.getCell('A4').value = 'Commercial Invoice Fields';
  ws.getCell('A4').font = sectionFont;

  const ciInstructions = [
    ['PO#', 'Fill in PO number from the purchase order'],
    ['SKU', 'Full SKU code: style-color-size (e.g. TCM6418-6010-L)'],
    ['UPC', 'Corresponding UPC barcode for the SKU'],
    ['Knit/Woven', 'Indicate if the item is Knit or Woven'],
    ['Style Description', 'Written style description of the garment'],
    ['Color Description', 'Written color description'],
    ['Category', 'Product category (Hoodie, T-shirt, Tank, Pants, etc.)'],
    ['Gender', 'Mens, Womens, or Ungendered'],
    ['Composition', 'Fabric composition (e.g. 55% Organic Cotton, 45% Recycled Polyester)'],
    ['HTS Code', 'Harmonized Tariff Schedule code for customs'],
    ['Quantity', 'Number of pieces for this line item'],
    ['Unit Price USD', 'Price per unit in US dollars'],
    ['Total USD', 'Auto-calculated: Quantity × Unit Price'],
  ];

  ciInstructions.forEach(([field, desc], i) => {
    const row = 5 + i;
    ws.getCell(`A${row}`).value = field;
    ws.getCell(`A${row}`).font = labelFont;
    ws.getCell(`B${row}`).value = desc;
    ws.getCell(`B${row}`).font = inputFont;
  });

  // PL instructions
  const plStart = 5 + ciInstructions.length + 2;
  ws.getCell(`A${plStart}`).value = 'Packing List Fields';
  ws.getCell(`A${plStart}`).font = sectionFont;

  const plInstructions = [
    ['CTN #', 'Carton number or range (e.g. "1", "2-3", "6 (MIX)" for mixed cartons)'],
    ['TOTAL/CTN', 'Number of cartons in this entry (e.g. 2 for range "2-3")'],
    ['PO #', 'PO number this carton belongs to'],
    ['SKU', 'Full SKU code matching the Commercial Invoice'],
    ['UPC', 'Corresponding UPC barcode'],
    ['Style Description', 'Written style description'],
    ['Color Description', 'Written color description'],
    ['PCS/CTN', 'Pieces per carton (for uniform cartons; blank for mixed)'],
    ['TOTAL/PCS', 'Total pieces in this line entry — this is the key quantity field'],
    ['N/W (KGS)', 'Net weight in kilograms'],
    ['G/W (KGS)', 'Gross weight in kilograms (including packaging)'],
    ['MEASURE', 'Carton dimensions in cm: L×W×H (e.g. 52*32*20)'],
  ];

  plInstructions.forEach(([field, desc], i) => {
    const row = plStart + 1 + i;
    ws.getCell(`A${row}`).value = field;
    ws.getCell(`A${row}`).font = labelFont;
    ws.getCell(`B${row}`).value = desc;
    ws.getCell(`B${row}`).font = inputFont;
    ws.getCell(`B${row}`).alignment = { wrapText: true };
  });

  // Notes section
  const notesStart = plStart + 1 + plInstructions.length + 2;
  ws.getCell(`A${notesStart}`).value = 'Notes';
  ws.getCell(`A${notesStart}`).font = sectionFont;

  const notes = [
    'Fill all green cells. Yellow cells are auto-calculated — do not edit them.',
    'For mixed cartons, use one row per SKU within the carton. Leave CTN # blank for continuation rows.',
    'The SKU in the Packing List must match the SKU in the Commercial Invoice for automatic matching.',
    'The MEASURE field should be in centimeters (L×W×H), separated by * or × (e.g. 52*32*20).',
    'Both sheets must be in the same workbook file when uploading to the portal.',
  ];

  notes.forEach((note, i) => {
    const row = notesStart + 1 + i;
    ws.getCell(`A${row}`).value = `${i + 1}.`;
    ws.getCell(`A${row}`).font = labelFont;
    ws.getCell(`B${row}`).value = note;
    ws.getCell(`B${row}`).font = inputFont;
    ws.getCell(`B${row}`).alignment = { wrapText: true };
  });

  return ws;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Main
// ═════════════════════════════════════════════════════════════════════════════

async function generate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'tentree Supply Chain Portal';
  wb.created = new Date();

  buildCiSheet(wb);
  buildPlSheet(wb);
  buildInstructionsSheet(wb);

  const outputPath = path.join(__dirname, '..', 'data', 'templates', 'tentree_CI_Template.xlsx');
  await wb.xlsx.writeFile(outputPath);
  console.log(`✅ Template written to ${outputPath}`);
  console.log(`   Sheets: ${wb.worksheets.map(s => s.name).join(', ')}`);
}

generate().catch(err => {
  console.error('Failed to generate template:', err);
  process.exit(1);
});
