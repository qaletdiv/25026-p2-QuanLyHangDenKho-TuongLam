'use strict';

// Convert BEST STAR FASHIONS (Shanghai) FW27 SMS "BSI2607xx" documents in
// `data/converted docs/` into the flat shipment-data template (single sheet
// "Shipment Data") consumed by services/ciParser.parseShipmentData. One output
// per PO. These are the LOT-2 apparel consignments for PO04789 / PO04790 /
// PO04791 (lot 1 = the accessory/water-bottle shipment already converted, kept
// under its own name in `converted docs/`) — so outputs land in `data/converted/`
// to avoid clobbering lot 1.
//
// Sources per PO (three FedEx consignments: HO -> PO04789, CA -> PO04790,
// US -> PO04791):
//  • "BSI2607xx ... commercial invoice ...xlsx" — the CI. Line-level source of
//    truth for unit price + composition. Columns: Composition(0), Style#(1),
//    SKU(2), Style Desc(3), Colour(4), 3T/S/M/ONE(5-8), QTY(9), FOB(10),
//    SMS Surcharge(11), Final FOB(12), TTL Cost(13). Unit price = **Final FOB**
//    (the invoiced price incl. the 0.75x SMS surcharge — the value the SMS CI/PL
//    + landed costs reflect, NOT the bare FOB). Parsing stops at the "Total" row;
//    PO04789 additionally carries consignment-level surcharge lines (Snap/webbing/
//    AOP) below the SKU total — those are NOT per-SKU and have no home in the
//    per-carton template, so they're ignored here (reconciliation is against the
//    SKU line-item total, not the surcharge-inclusive grand total).
//  • "BSI2607xx ... Packing List ...xlsx" — the PL. Spine of the output: supplies
//    carton assignment (CTN#), UPC, per-carton G/W + box MEASURE, and qty.
//    Columns: CTN#(0), TOTAL/CTN(1), PO#(2), Style#(3), SKU(4), UPC(5),
//    Style Desc(6), Colour(7), PCS(8), NO.(9), G/W(10), MEASURE(11). CTN#/G/W/
//    MEASURE sit on each carton's first row only (forward-filled below). The PL
//    has no per-carton N/W column (only a total), so N/W is left blank.
//
// No HTS is declared on any CI (blank). All items sit under the CI's "KNIT"
// section -> Knit/Woven = "Knit". Gender from the SKU prefix (ZCM -> Men,
// ZCW -> Women). Category isn't cleanly per-SKU -> blank.
// The catalogue SKU carries the size suffix (e.g. ZCM1471-0361-M); a few PL rows
// drop it (ZCM5755-6994) -> resolveSku restores the suffix that matches a real
// product_skus row so the SKU master + reconciliation stay aligned.

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const SRC = path.join(__dirname, '..', 'data', 'converted docs');
const OUT = path.join(__dirname, '..', 'data', 'converted');
const SKU_CODES = new Set(require(path.join(__dirname, '..', 'data', 'migrated', 'product_skus.json')).map((s) => s.sku_code));

const TEMPLATE_HEADER = [
  'CTN#', 'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
  'Category', 'Gender', 'Composition', 'HTS Code', 'Unit Price USD', 'Total USD',
  'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
];

// PO -> CI line-item total (the "Total" row; excludes PO04789's surcharge lines)
const CI_TOTAL = { PO04789: 3174.99, PO04790: 2382.8175, PO04791: 4157.405 };
const POS = ['PO04789', 'PO04790', 'PO04791'];

const S = (v) => String(v ?? '').trim();
const N = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const W = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return isFinite(n) ? n : ''; }; // "9kg" -> 9
const r2 = (n) => +n.toFixed(2);
const normMeasure = (m) => S(m).replace(/cm$/i, '').replace(/\s+/g, '').replace(/[*×xX]/g, 'X').toUpperCase();
const composition = (c) => S(c).replace(/\s*,\s*/g, ', ').replace(/%(?=\S)/g, '% ').replace(/\s+/g, ' ').trim();
const gender = (sku) => (/^ZC?M/i.test(sku) ? 'Men' : /^ZC?W/i.test(sku) ? 'Women' : '');

// resolve the catalogue SKU: prefer the as-is code, else the size-suffixed variant
const resolveSku = (raw) => {
  const s = S(raw).toUpperCase();
  if (SKU_CODES.has(s)) return s;
  for (const suf of ['-M', '-S', '-ONE']) if (SKU_CODES.has(s + suf)) return s + suf;
  return s; // best guess; flagged as unmatched below
};

// locate a source file for a PO by kind ("commercial invoice" | "packing")
const files = fs.readdirSync(SRC);
const num = (po) => po.replace(/^PO0?/, ''); // PO04789 -> 4789 (appears in every filename)
const findFile = (po, kind) => {
  const re = kind === 'ci' ? /invoice/i : /packing/i;
  const f = files.find((x) => re.test(x) && x.includes(num(po)));
  if (!f) throw new Error(`No ${kind} file found for ${po}`);
  return f;
};

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

for (const po of POS) {
  // ── CI: SKU -> { price (Final FOB), composition } ─────────────────────────
  const ciWb = xlsx.read(fs.readFileSync(path.join(SRC, findFile(po, 'ci'))), { type: 'buffer', cellDates: true });
  const ciGrid = xlsx.utils.sheet_to_json(ciWb.Sheets[ciWb.SheetNames[0]], { header: 1, defval: '' });
  const ci = {};
  const C = { comp: 0, sku: 2, qty: 9, finalFob: 12 };
  for (const row of ciGrid) {
    const sku = S(row[C.sku]);
    if (/^total$/i.test(sku.replace(/\s/g, ''))) break;          // stop at the SKU Total row
    if (!/^Z[A-Z]{2}\d/i.test(sku)) continue;                    // skip headers / surcharge / blanks
    ci[resolveSku(sku)] = { price: N(row[C.finalFob]), composition: composition(row[C.comp]) };
  }

  // ── PL: the spine ─────────────────────────────────────────────────────────
  const plWb = xlsx.read(fs.readFileSync(path.join(SRC, findFile(po, 'pl'))), { type: 'buffer', cellDates: true });
  const plGrid = xlsx.utils.sheet_to_json(plWb.Sheets[plWb.SheetNames[0]], { header: 1, defval: '' });
  const hdr = plGrid.findIndex((r) => /ctn/i.test(S(r[0])) && /sku/i.test(S(r[4])));
  const P = { ctn: 0, po: 2, sku: 4, upc: 5, style: 6, color: 7, pcs: 8, gw: 10, measure: 11 };

  const aoa = [TEMPLATE_HEADER];
  const unmatchedCat = new Set();   // SKU not in product_skus
  const unmatchedCi = new Set();    // SKU not priced by the CI
  let curCtn = 0, totalPcs = 0, totalVal = 0;
  const cartons = new Set();

  for (let i = hdr + 1; i < plGrid.length; i++) {
    const r = plGrid[i];
    const rawSku = S(r[P.sku]);
    if (!/^Z[A-Z]{2}\d/i.test(rawSku)) continue;                 // skips Total + Summary block rows
    const ctnCell = N(r[P.ctn]);
    const firstOfCarton = ctnCell > 0;
    if (firstOfCarton) curCtn = ctnCell;
    cartons.add(curCtn);

    const sku = resolveSku(rawSku);
    if (!SKU_CODES.has(sku)) unmatchedCat.add(rawSku);
    const priced = ci[sku];
    if (!priced) unmatchedCi.add(rawSku);
    const unit = priced ? priced.price : 0;
    const pcs = N(r[P.pcs]);
    totalPcs += pcs;
    totalVal += unit * pcs;

    aoa.push([
      curCtn, S(r[P.po]).replace(/^PO0*/, 'PO0') || po, sku, S(r[P.upc]),
      'Knit', S(r[P.style]), S(r[P.color]),
      '', gender(rawSku), priced ? priced.composition : '', '',
      unit, r2(unit * pcs), pcs,
      // single N/W not in source; G/W + MEASURE on each carton's first row
      '', firstOfCarton ? W(r[P.gw]) : '', firstOfCarton ? normMeasure(r[P.measure]) : '',
    ]);
  }

  const out = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(out, xlsx.utils.aoa_to_sheet(aoa), 'Shipment Data');
  const outName = `${po}-shipment-data.xlsx`;
  xlsx.writeFile(out, path.join(OUT, outName));

  const diff = r2(totalVal - CI_TOTAL[po]);
  console.log(`\n${po}`);
  console.log(`  -> converted/${outName}`);
  console.log(`     ${aoa.length - 1} SKU rows | ${cartons.size} cartons | ${totalPcs} pcs | $${r2(totalVal)} (CI line total $${CI_TOTAL[po]}, Δ ${diff})`);
  if (unmatchedCat.size) console.log(`     !! not in product_skus: ${[...unmatchedCat].join(', ')}`);
  if (unmatchedCi.size) console.log(`     !! no CI price (priced $0): ${[...unmatchedCi].join(', ')}`);
}
