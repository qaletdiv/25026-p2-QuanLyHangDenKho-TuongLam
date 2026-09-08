'use strict';

// Convert EASTERN WARMTH invoice "TT-376 Canada Ho.xls" (FW27 SMS, PO04799) into
// the flat shipment-data template (single sheet "Shipment Data") consumed by
// services/ciParser.parseShipmentData. ONE output per LOT.
//
// PO04799 shipped as TWO FedEx consignments = two lots, one packing-list sheet each:
//   • lot 1 -> sheet "FED EX AWB 8751 4427 6079"  (AWB 875144276079)
//   • lot 2 -> sheet "FED EX AWB 8752 3126 1470"  (AWB 875231261470)
// Lot 1 matches the sms_shipment_pos junction already in the portal (shipment 34,
// tracking 875144276079, 160 units / 6 cartons). Lot 2 has no shipment record yet.
//
// Sources inside the one workbook:
//  • sheet "Invoice " — the CI. Line-level source for price + descriptive attrs.
//    Header row 16; cols: PO#(0), SKU(1), UPC(2), Knit/Woven(3), Style Desc(4),
//    Color Desc(5), Category(6), Gender(7), Composition(8), HTS Code(9),
//    Quantity(10), Unit Price USD(11), SMS Surcharge(12), Total USD(13).
//    Its header BLOCK is stale (says PO4691 / TT-363) — the line rows carry 04799,
//    so the PO comes from the rows, never the block.
//    Unit price = **the invoiced price INCLUDING the SMS surcharge**, i.e.
//    Total USD / Quantity — same rule as convertBestStarToShipmentData.js
//    ("Final FOB … NOT the bare FOB"): the CI/PL documents and the landed-cost
//    basis must reflect what was actually invoiced. Here the surcharge is 1.0x
//    (surcharge == unit price), so the effective unit is double the bare price and
//    the two lots reconcile to the invoice's own $5,956.00.
//  • the two "FED EX AWB …" sheets — the packing lists, one per lot. Spine of the
//    output: carton assignment (CTN#), UPC, PCS/CTN, per-carton N/W + G/W + carton
//    size. Header row 15; cols: CTN#(0), PO#(1), SKU(2), UPC(3), Style Desc(4),
//    Color Desc(5), PCS/CTN(6), N/W(7), G/W(8), Carton size(9). CTN#/N/W/G/W/size
//    sit on each carton's FIRST row only — CTN# is forward-filled, the per-carton
//    weights/measure stay on the first row (parseShipmentData sums them once per
//    distinct ctn_number).
//
// Parsing stops at each sheet's "TOTAL" row; the Summary block below it is skipped
// by the SKU-shape guard.

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const SRC_FILE = path.join(__dirname, '..', 'data', 'converted docs', 'SMS', 'TT-376 Canada Ho.xls');
const OUT_DIR = path.join(__dirname, '..', 'data', 'converted docs', 'SMS');
const SKU_CODES = new Set(require(path.join(__dirname, '..', 'data', 'migrated', 'product_skus.json')).map((s) => s.sku_code));

const PO = 'PO04799';
const TEMPLATE_HEADER = [
  'CTN#', 'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
  'Category', 'Gender', 'Composition', 'HTS Code', 'Unit Price USD', 'Total USD',
  'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
];

// lot -> { sheet, outfile }. Lot 1 keeps the base name; later lots get the -lotN
// suffix (same convention as PO04789/90/91).
const LOTS = [
  { lot: 1, sheet: 'FED EX AWB 8751 4427 6079', out: `${PO}-shipment-data.xlsx` },
  { lot: 2, sheet: 'FED EX AWB 8752 3126 1470', out: `${PO}-shipment-data-lot2.xlsx` },
];

const S = (v) => String(v ?? '').trim();
const N = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const r2 = (n) => +n.toFixed(2);
const isSku = (s) => /^Z[A-Z]{2}\d/i.test(s);
const normMeasure = (m) => S(m).replace(/cm$/i, '').replace(/\s+/g, '').replace(/[*×xX]/g, 'X').toUpperCase();
const composition = (c) => S(c).replace(/\s*,\s*/g, ', ').replace(/%(?=\S)/g, '% ').replace(/\s+/g, ' ').trim();

const wb = xlsx.read(fs.readFileSync(SRC_FILE), { type: 'buffer', cellDates: true });
const grid = (name) => {
  const sheet = wb.Sheets[name];
  if (!sheet) throw new Error(`Sheet "${name}" not found. Sheets: ${wb.SheetNames.join(' | ')}`);
  return xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
};

// ── CI: SKU -> price (surcharge-inclusive) + descriptive attrs ────────────────
const invName = wb.SheetNames.find((n) => /invoice/i.test(n));
if (!invName) throw new Error('No Invoice sheet found');
const inv = grid(invName);
const I = { po: 0, sku: 1, upc: 2, knit: 3, style: 4, color: 5, cat: 6, gender: 7, comp: 8, hts: 9, qty: 10, unit: 11, surcharge: 12, total: 13 };

const ci = {};
let ciQty = 0, ciTotal = 0, surchargeRows = 0;
for (const row of inv) {
  const sku = S(row[I.sku]);
  if (/^total$/i.test(sku.replace(/\s/g, ''))) break;
  if (!isSku(sku)) continue;
  const qty = N(row[I.qty]);
  const bare = N(row[I.unit]);
  const sur = N(row[I.surcharge]);
  const total = N(row[I.total]);
  // invoiced unit = Total/Qty; fall back to bare+surcharge when qty is missing
  const unit = qty > 0 ? total / qty : bare + sur;
  if (sur) surchargeRows++;
  ciQty += qty; ciTotal += total;
  ci[sku.toUpperCase()] = {
    unit, bare, sur, qty, total,
    upc: S(row[I.upc]), knit: S(row[I.knit]), style: S(row[I.style]), color: S(row[I.color]),
    category: S(row[I.cat]), gender: S(row[I.gender]), composition: composition(row[I.comp]), hts: S(row[I.hts]),
  };
}
console.log(`CI "${invName}": ${Object.keys(ci).length} SKUs | ${ciQty} pcs | $${r2(ciTotal)} | surcharge on ${surchargeRows} rows`);

// ── one output per lot, packing list as the spine ─────────────────────────────
const P = { ctn: 0, po: 1, sku: 2, upc: 3, style: 4, color: 5, pcs: 6, nw: 7, gw: 8, measure: 9 };
let grandPcs = 0, grandVal = 0;

for (const { lot, sheet, out } of LOTS) {
  const pl = grid(sheet);
  const hdr = pl.findIndex((r) => /ctn/i.test(S(r[P.ctn])) && /sku/i.test(S(r[P.sku])));
  if (hdr < 0) throw new Error(`No header row (CTN#/SKU) in "${sheet}"`);

  const aoa = [TEMPLATE_HEADER];
  const cartons = new Set();
  const notInCatalogue = new Set();
  const notPriced = new Set();
  let curCtn = 0, pcsTotal = 0, valTotal = 0, nwTotal = 0, gwTotal = 0;

  for (let i = hdr + 1; i < pl.length; i++) {
    const r = pl[i];
    if (/^total$/i.test(S(r[P.ctn]).replace(/\s/g, ''))) break;   // stop before the Summary block
    const rawSku = S(r[P.sku]);
    if (!isSku(rawSku)) continue;

    const sku = rawSku.toUpperCase();
    if (!SKU_CODES.has(sku)) notInCatalogue.add(sku);
    const priced = ci[sku];
    if (!priced) notPriced.add(sku);

    const ctnCell = N(r[P.ctn]);
    const firstOfCarton = ctnCell > 0;
    if (firstOfCarton) curCtn = ctnCell;
    cartons.add(curCtn);

    const pcs = N(r[P.pcs]);
    const unit = priced ? priced.unit : 0;
    pcsTotal += pcs;
    valTotal += unit * pcs;
    if (firstOfCarton) { nwTotal += N(r[P.nw]); gwTotal += N(r[P.gw]); }

    aoa.push([
      curCtn, PO, sku, S(r[P.upc]) || (priced ? priced.upc : ''),
      priced ? priced.knit : '',
      S(r[P.style]) || (priced ? priced.style : ''),
      S(r[P.color]) || (priced ? priced.color : ''),
      priced ? priced.category : '', priced ? priced.gender : '',
      priced ? priced.composition : '', priced ? priced.hts : '',
      unit, r2(unit * pcs), pcs,
      firstOfCarton ? N(r[P.nw]) || '' : '',
      firstOfCarton ? N(r[P.gw]) || '' : '',
      firstOfCarton ? normMeasure(r[P.measure]) : '',
    ]);
  }

  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet(aoa), 'Shipment Data');
  xlsx.writeFile(book, path.join(OUT_DIR, out));

  grandPcs += pcsTotal; grandVal += valTotal;
  console.log(`\nlot ${lot} — "${sheet}"`);
  console.log(`  -> converted docs/SMS/${out}`);
  console.log(`     ${aoa.length - 1} SKU rows | ${cartons.size} cartons | ${pcsTotal} pcs | $${r2(valTotal)}`);
  console.log(`     N/W ${r2(nwTotal)} kg | G/W ${r2(gwTotal)} kg`);
  if (notInCatalogue.size) console.log(`     !! not in product_skus: ${[...notInCatalogue].join(', ')}`);
  if (notPriced.size) console.log(`     !! no CI price (priced $0): ${[...notPriced].join(', ')}`);
}

console.log(`\nBOTH LOTS: ${grandPcs} pcs | $${r2(grandVal)}  (CI: ${ciQty} pcs | $${r2(ciTotal)}) — Δ pcs ${grandPcs - ciQty}, Δ value ${r2(grandVal - ciTotal)}`);
