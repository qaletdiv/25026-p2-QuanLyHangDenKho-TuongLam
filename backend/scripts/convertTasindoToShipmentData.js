'use strict';

// Convert PT. TASINDO TASSA INDUSTRIES (Indonesia) FW27 SMS documents in
// `data/converted docs/` into the flat shipment-data template (single sheet
// "Shipment Data") consumed by services/ciParser.parseShipmentData — the same
// upload the SMS packing route (POST /sms/shipments/:id/shipping-data) ingests.
// One output per PO (three FedEx consignments: HO -> PO04811, CA -> PO04812,
// US -> PO04813).
//
// Sources:
//  • `TENTREE ORDER FW27 SMS.xlsx` — the Commercial Invoice, one sheet per
//    consignment (014 HO / 015 CA / 016 USA). Machine-readable: it carries the
//    per-SKU line items (SKU, style name, colour, PO, qty, unit price). Parsed
//    directly — this is the line-level source of truth.
//  • `PL TENT 01x 2026 *.pdf` — the packing lists. Each consignment = a single
//    carton; the PDFs supply that carton's N/W · G/W · box measure (the CI has
//    no weights). Transcribed into WEIGHTS below (3 values per PO).
//
// These are bags (no knit/woven or composition in the source → blank). Only the
// US consignment declares an HTS (4202219000, handbags) as a sheet-level remark;
// it's applied to every line of that consignment (HO/CA leave HTS blank — Canada
// imports don't declare it on the CI). Each sheet's stale trailing rows (leftover
// lines below the invoice TOTAL, referencing unrelated POs) are ignored — parsing
// stops at the "T O T A L" row.
// The CI SKU is the style-colour (e.g. ZAU6250-5594); the catalogue + sms_po_lines
// carry the one-size variant with the "-ONE" suffix, so "-ONE" is appended when
// that resolves a real product_skus row (keeps the SKU master + reconciliation
// aligned). Unit price = the commercial-invoice price (NOT the blended NetSuite
// PO-line price) — the CI value is what the SMS CI/PL + landed costs reflect.

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const DIR = path.join(__dirname, '..', 'data', 'converted docs');
const CI_FILE = 'TENTREE ORDER FW27 SMS.xlsx';
const SKU_CODES = new Set(require(path.join(__dirname, '..', 'data', 'migrated', 'product_skus.json')).map((s) => s.sku_code));

const TEMPLATE_HEADER = [
  'CTN#', 'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
  'Category', 'Gender', 'Composition', 'HTS Code', 'Unit Price USD', 'Total USD',
  'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
];

const S = (v) => String(v ?? '').trim();
const N = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const r2 = (n) => +n.toFixed(2);

// Per-PO carton envelope from the PL PDFs (single carton each; box 55x40x53 all).
const WEIGHTS = {
  PO04811: { nw: 4.80, gw: 6.20, measure: '55X40X53' },
  PO04812: { nw: 3.60, gw: 5.00, measure: '55X40X53' },
  PO04813: { nw: 6.30, gw: 7.30, measure: '55X40X53' },
};

// resolve the catalogue SKU: prefer the "-ONE" one-size variant when it exists
const resolveSku = (styleColor) =>
  (SKU_CODES.has(`${styleColor}-ONE`) ? `${styleColor}-ONE`
    : SKU_CODES.has(styleColor) ? styleColor
      : `${styleColor}-ONE`); // best guess; flagged as unmatched below

// ── Parse the CI workbook → line items grouped by PO ──────────────────────────
// Each sheet's item table: SKU col 2, Style 3, Colour 4, PO 5, Qty 6, Price 8.
const wb = xlsx.read(fs.readFileSync(path.join(DIR, CI_FILE)), { type: 'buffer', cellDates: true });
const C = { sku: 2, style: 3, color: 4, po: 5, qty: 6, price: 8 };
const byPo = {};
const unmatched = new Set();

for (const sheetName of wb.SheetNames) {
  const grid = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
  // sheet-level HTS from the remarks block (e.g. "HTS CODE : 4202219000")
  const htsHit = grid.flat().map((c) => /HTS\s*CODE\s*:?\s*(\d{6,10})/i.exec(S(c))).find(Boolean);
  const sheetHts = htsHit ? htsHit[1] : '';

  for (const row of grid) {
    const styleColor = S(row[C.sku]);
    if (/^total$/i.test(styleColor.replace(/\s/g, ''))) break;  // stop at TOTAL — trailing rows are stale
    if (!/^Z[A-Z]{2}\d/i.test(styleColor)) continue;            // skip headers / blanks
    const po = S(row[C.po]);
    if (!/^PO\d+/i.test(po)) continue;
    const sku = resolveSku(styleColor);
    if (!SKU_CODES.has(sku)) unmatched.add(styleColor);
    (byPo[po] ||= []).push({
      sku, style: S(row[C.style]), color: S(row[C.color]),
      qty: N(row[C.qty]), price: N(row[C.price]), hts: sheetHts,
    });
  }
}

// ── Build one shipment-data workbook per PO ───────────────────────────────────
for (const [po, lines] of Object.entries(byPo)) {
  const env = WEIGHTS[po] || { nw: '', gw: '', measure: '' };
  const aoa = [TEMPLATE_HEADER];
  let totalPcs = 0, totalVal = 0;

  lines.forEach((l, i) => {
    totalPcs += l.qty;
    totalVal += l.price * l.qty;
    aoa.push([
      1, po, l.sku, '', '', l.style, l.color,
      '', '', '', l.hts || '',
      l.price, r2(l.price * l.qty), l.qty,
      // single carton: weights & measure on the first row only
      i === 0 ? env.nw : '', i === 0 ? env.gw : '', i === 0 ? env.measure : '',
    ]);
  });

  const out = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(out, xlsx.utils.aoa_to_sheet(aoa), 'Shipment Data');
  const outName = `${po}-shipment-data.xlsx`;
  xlsx.writeFile(out, path.join(DIR, outName));

  console.log(`\n${po}`);
  console.log(`  -> ${outName}`);
  console.log(`     ${lines.length} SKU rows | 1 carton | ${totalPcs} pcs | $${r2(totalVal)} | N/W ${env.nw}kg | G/W ${env.gw}kg | ${env.measure}`);
}

if (unmatched.size) console.log(`\n!! SKUs not found in product_skus (emitted with -ONE anyway): ${[...unmatched].join(', ')}`);
