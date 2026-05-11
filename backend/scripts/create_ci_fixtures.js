/**
 * create_ci_fixtures.js
 * =====================
 * Generates 7 CI fixture Excel files for the tentree booking test suite.
 * Uses the xlsx library already present in backend/node_modules.
 *
 * Parser format: backend/services/ciParser.js
 *   Row 2    : B2=invoice_number, D2=invoice_date
 *   Rows 4-8 : PO summary — A=po_number, B=shipped_qty, C=cartons, D=weight_kg, E=cbm
 *   Row 10   : SKU header row (ignored by parser)
 *   Rows 11+ : SKU line items — A=sku_code, B=description, C=qty, D=unit_price, E=total_price, F=weight_kg, G=cbm
 *
 * Run: node backend/scripts/create_ci_fixtures.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const xlsx = require('xlsx');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a worksheet (2-D array → AOA) in the ciParser fixed format and
 * return a workbook ready to write.
 *
 * @param {string}   invoiceNumber
 * @param {string}   invoiceDate         ISO string e.g. "2026-04-15"
 * @param {Array[]}  poSummaryRows       [[po_number, shipped_qty, cartons, weight_kg, cbm], ...]
 * @param {Array[]}  lineItems           [[sku_code, description, qty, unit_price, weight_kg, cbm], ...]
 */
function buildWorkbook(invoiceNumber, invoiceDate, poSummaryRows, lineItems) {
    // We build a 2-D array (AOA) — xlsx will convert row/col indices to cell refs.
    // Rows are 0-indexed in the array; ciParser uses 1-based rows.

    const TOTAL_ROWS = 10 + lineItems.length + 2;   // a bit of extra padding
    const COLS       = 7;

    // Allocate empty grid
    const aoa = Array.from({ length: TOTAL_ROWS }, () => Array(COLS).fill(''));

    // Row 1 (index 0): title banner — not parsed, just cosmetic
    aoa[0][0] = 'COMMERCIAL INVOICE';

    // Row 2 (index 1): invoice metadata
    aoa[1][0] = 'Invoice No:';
    aoa[1][1] = invoiceNumber;          // B2
    aoa[1][2] = 'Invoice Date:';
    aoa[1][3] = invoiceDate;            // D2

    // Row 3 (index 2): section label
    aoa[2][0] = 'PO Shipping Summary';

    // Rows 4-8 (indices 3-7): PO summary block (parser reads these)
    poSummaryRows.forEach(([poNum, shippedQty, cartons, weightKg, cbm], offset) => {
        const r = 3 + offset;  // row 4 = index 3
        aoa[r][0] = poNum;
        aoa[r][1] = shippedQty;
        aoa[r][2] = cartons;
        aoa[r][3] = weightKg;
        aoa[r][4] = cbm;
    });

    // Row 9 (index 8): blank separator — left empty intentionally

    // Row 10 (index 9): SKU line-item column headers
    aoa[9] = ['SKU Code', 'Description', 'Qty', 'Unit Price (USD)', 'Total Price (USD)', 'Weight (kg)', 'CBM'];

    // Rows 11+ (indices 10+): SKU line items
    lineItems.forEach(([skuCode, description, qty, unitPrice, weightKg, cbm], offset) => {
        const r = 10 + offset;
        aoa[r][0] = skuCode;
        aoa[r][1] = description;
        aoa[r][2] = qty;
        aoa[r][3] = unitPrice;
        aoa[r][4] = parseFloat((qty * unitPrice).toFixed(2));
        aoa[r][5] = weightKg;
        aoa[r][6] = cbm;
    });

    const ws = xlsx.utils.aoa_to_sheet(aoa);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Commercial Invoice');
    return wb;
}

function li(skuCode, description, qty, unitPrice, wtPerUnit, cbmPerUnit) {
    return [skuCode, description, qty, unitPrice,
        parseFloat((qty * wtPerUnit).toFixed(2)),
        parseFloat((qty * cbmPerUnit).toFixed(4))];
}

function liFromSource([skuCode, description, expectedQty, unitPrice, wtPerUnit, cbmPerUnit], qtyOverride) {
    const qty = qtyOverride !== undefined ? qtyOverride : expectedQty;
    return li(skuCode, description, qty, unitPrice, wtPerUnit, cbmPerUnit);
}

// ── source data ────────────────────────────────────────────────────────────────

const INVOICE_DATE = '2026-04-15';

const PO001_SKUS = [
    ['TEN7101-FGN-XS', 'FW26 Fleece Jacket - Forest Green XS',   800, 16.50, 0.20, 0.0025],
    ['TEN7101-FGN-S',  'FW26 Fleece Jacket - Forest Green S',   1400, 16.50, 0.20, 0.0025],
    ['TEN7101-FGN-M',  'FW26 Fleece Jacket - Forest Green M',   2000, 16.50, 0.20, 0.0025],
    ['TEN7101-FGN-L',  'FW26 Fleece Jacket - Forest Green L',   2000, 16.50, 0.20, 0.0025],
    ['TEN7101-FGN-XL', 'FW26 Fleece Jacket - Forest Green XL',  1600, 16.50, 0.20, 0.0025],
];  // total expected_qty = 7800

const PO002_SKUS = [
    ['TEN7102-NVY-XS', 'FW26 Hoodie - Navy XS',  500, 18.00, 0.22, 0.0028],
    ['TEN7102-NVY-S',  'FW26 Hoodie - Navy S',  1000, 18.00, 0.22, 0.0028],
    ['TEN7102-NVY-M',  'FW26 Hoodie - Navy M',  1500, 18.00, 0.22, 0.0028],
];  // total expected_qty = 3000

// ── define 7 scenarios ────────────────────────────────────────────────────────

const scenarios = [

    // S1: full match — all 5 PO-001 SKUs at exact expected qty
    {
        filename: 'ci_s1_full_match.xlsx',
        wb: buildWorkbook(
            'CI-S1-FULL-001', INVOICE_DATE,
            [['PO-FW26-001', 7800, 390, 1560.0, 19.50]],
            PO001_SKUS.map(s => liFromSource(s))
        ),
        meta: {
            title: 'S1 — Full Match (single PO)',
            desc: 'All 5 PO-FW26-001 SKUs at exact expected qty. Zero over/under. All CI SKUs matched.',
            pos: ['PO-FW26-001'],
            matched: 5, unmatched: 0, total_qty: 7800,
        },
    },

    // S2: partial match — 3 of 5 SKUs, all matched, qty < expected
    {
        filename: 'ci_s2_partial_match.xlsx',
        wb: buildWorkbook(
            'CI-S2-PARTIAL-001', INVOICE_DATE,
            [['PO-FW26-001', 4200, 210, 840.0, 10.50]],
            PO001_SKUS.slice(0, 3).map(s => liFromSource(s))   // XS + S + M = 4200
        ),
        meta: {
            title: 'S2 — Partial Match (single PO, qty < expected)',
            desc: '3 of 5 SKUs (XS=800, S=1400, M=2000). Total shipped 4,200 vs 7,800 expected. L and XL remain at 0 shipped.',
            pos: ['PO-FW26-001'],
            matched: 3, unmatched: 0, total_qty: 4200,
        },
    },

    // S3: partial + unmatched — 2 matched + 1 SKU not on PO
    {
        filename: 'ci_s3_partial_some_unmatched.xlsx',
        wb: buildWorkbook(
            'CI-S3-PARTIAL-UNM-001', INVOICE_DATE,
            [['PO-FW26-001', 3800, 190, 760.0, 9.50]],
            [
                li('TEN7101-FGN-XS',      'FW26 Fleece Jacket - Forest Green XS',       800, 16.50, 0.20, 0.0025),
                li('TEN7101-FGN-S',       'FW26 Fleece Jacket - Forest Green S',        1400, 16.50, 0.20, 0.0025),
                li('TEN7101-FGN-UNKNOWN', 'FW26 Fleece Jacket - Forest Green UNKNOWN',  1600, 16.50, 0.20, 0.0025),
            ]
        ),
        meta: {
            title: 'S3 — Partial + Unmatched SKUs (single PO)',
            desc: 'XS=800 matched, S=1400 matched, TEN7101-FGN-UNKNOWN=1600 UNMATCHED. Total CI 3,800 vs PO expected 7,800.',
            pos: ['PO-FW26-001'],
            matched: 2, unmatched: 1, total_qty: 3800,
        },
    },

    // S4: overbooking + unmatched — total CI qty > PO expected
    {
        filename: 'ci_s4_overbooking_mixed.xlsx',
        wb: buildWorkbook(
            'CI-S4-OVERBOOK-001', INVOICE_DATE,
            [['PO-FW26-001', 9000, 450, 1800.0, 22.50]],
            [
                li('TEN7101-FGN-XS',    'FW26 Fleece Jacket - Forest Green XS',     800, 16.50, 0.20, 0.0025),  // exact
                li('TEN7101-FGN-S',     'FW26 Fleece Jacket - Forest Green S',      2000, 16.50, 0.20, 0.0025),  // over by 600
                li('TEN7101-FGN-M',     'FW26 Fleece Jacket - Forest Green M',      4000, 16.50, 0.20, 0.0025),  // over by 2000
                li('TEN7101-FGN-GHOST', 'FW26 Fleece Jacket - Forest Green GHOST',  2200, 16.50, 0.20, 0.0025),  // not on PO
            ]
        ),
        meta: {
            title: 'S4 — Overbooking + Unmatched (single PO)',
            desc: 'Total CI 9,000 vs PO expected 7,800. XS exact, S over+600, M over+2000, GHOST=2200 unmatched.',
            pos: ['PO-FW26-001'],
            matched: 1, unmatched: 1, total_qty: 9000,
        },
    },

    // S5: all PO SKUs covered + 2 extra CI SKUs not on PO
    {
        filename: 'ci_s5_overbooking_extra_skus.xlsx',
        wb: buildWorkbook(
            'CI-S5-EXTRA-SKU-001', INVOICE_DATE,
            [['PO-FW26-001', 9800, 490, 1960.0, 24.50]],
            [
                ...PO001_SKUS.map(s => liFromSource(s)),
                li('TEN7101-EXTRA-001', 'FW26 Fleece Jacket - Extra Style 001', 1000, 16.50, 0.20, 0.0025),
                li('TEN7101-EXTRA-002', 'FW26 Fleece Jacket - Extra Style 002', 1000, 16.50, 0.20, 0.0025),
            ]
        ),
        meta: {
            title: 'S5 — All PO SKUs + Extra CI SKUs (single PO, over-shipped)',
            desc: 'All 5 PO-001 SKUs at exact qty (7,800), plus EXTRA-001=1000 and EXTRA-002=1000 unmatched. Total CI 9,800.',
            pos: ['PO-FW26-001'],
            matched: 5, unmatched: 2, total_qty: 9800,
        },
    },

    // S1 multi-PO: both PO-001 + PO-002, all SKUs exact
    {
        filename: 'ci_s1_multi_po.xlsx',
        wb: buildWorkbook(
            'CI-S1MP-MULTI-001', INVOICE_DATE,
            [
                ['PO-FW26-001', 7800, 390, 1560.0, 19.50],
                ['PO-FW26-002', 3000, 150,  660.0,  8.40],
            ],
            [
                ...PO001_SKUS.map(s => liFromSource(s)),
                ...PO002_SKUS.map(s => liFromSource(s)),
            ]
        ),
        meta: {
            title: 'S1 Multi-PO — Full Match (PO-FW26-001 + PO-FW26-002)',
            desc: 'All 5 PO-001 SKUs (7,800) + all 3 PO-002 SKUs (3,000) at exact expected qty. 8 matched, 0 unmatched.',
            pos: ['PO-FW26-001', 'PO-FW26-002'],
            matched: 8, unmatched: 0, total_qty: 10800,
        },
    },

    // S3 multi-PO mixed: partial + unmatched across both POs
    {
        filename: 'ci_s3_multi_po_mixed.xlsx',
        wb: buildWorkbook(
            'CI-S3MP-MIX-001', INVOICE_DATE,
            [
                ['PO-FW26-001', 4200, 210, 840.0, 10.50],
                ['PO-FW26-002', 1000,  50, 220.0,  2.80],
            ],
            [
                li('TEN7101-FGN-XS',    'FW26 Fleece Jacket - Forest Green XS',  800,  16.50, 0.20, 0.0025),  // PO-001
                li('TEN7101-FGN-S',     'FW26 Fleece Jacket - Forest Green S',  1400,  16.50, 0.20, 0.0025),  // PO-001
                li('TEN7101-FGN-M',     'FW26 Fleece Jacket - Forest Green M',  2000,  16.50, 0.20, 0.0025),  // PO-001
                li('TEN7102-NVY-XS',    'FW26 Hoodie - Navy XS',                 500,  18.00, 0.22, 0.0028),  // PO-002
                li('TEN7102-NVY-GHOST', 'FW26 Hoodie - Navy GHOST',              500,  18.00, 0.22, 0.0028),  // unmatched
                li('TEN7101-EXTRA',     'FW26 Extra Style',                      300,  16.50, 0.20, 0.0025),  // unmatched
            ]
        ),
        meta: {
            title: 'S3 Multi-PO Mixed — Partial + Unmatched across 2 POs',
            desc: '3 matched from PO-001 (4200), 1 matched from PO-002 (500), NVY-GHOST=500 unmatched, EXTRA=300 unmatched. Total CI 5,500.',
            pos: ['PO-FW26-001', 'PO-FW26-002'],
            matched: 4, unmatched: 2, total_qty: 5500,
        },
    },
];

// ── write files ───────────────────────────────────────────────────────────────

console.log(`\nWriting CI fixture files to: ${DATA_DIR}\n`);

for (const { filename, wb, meta } of scenarios) {
    const outPath = path.join(DATA_DIR, filename);
    xlsx.writeFile(wb, outPath);
    const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(1);
    console.log(`  [OK] ${filename.padEnd(48)}  (${sizeKb} KB)`);
}

// ── write CI_FIXTURES.md ──────────────────────────────────────────────────────

const mdLines = [
    '# CI Fixture Files — Test Scenarios',
    '',
    'Generated by `backend/scripts/create_ci_fixtures.js`.',
    'All files live in `backend/data/`. Invoice date for all fixtures: **2026-04-15**.',
    '',
    '---',
    '',
];

for (const { filename, meta } of scenarios) {
    mdLines.push(
        `## \`${filename}\``,
        '',
        `### ${meta.title}`,
        '',
        meta.desc,
        '',
        `**POs:** ${meta.pos.map(p => `\`${p}\``).join(', ')}`,
        '',
        '| Metric | Value |',
        '|---|---:|',
        `| Total CI shipped qty | ${meta.total_qty.toLocaleString()} |`,
        `| Matched SKUs | ${meta.matched} |`,
        `| Unmatched SKUs | ${meta.unmatched} |`,
        '',
        '---',
        '',
    );
}

const mdPath = path.join(DATA_DIR, 'CI_FIXTURES.md');
fs.writeFileSync(mdPath, mdLines.join('\n'), 'utf-8');
console.log(`\n  [OK] CI_FIXTURES.md written.`);
console.log(`\nDone — ${scenarios.length}/7 files created.\n`);
