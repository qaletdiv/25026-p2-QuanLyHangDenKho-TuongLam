'use strict';

// Convert the Continent 8 / PT Masterindo Jaya Abadi (MJA) mainline CI+PL
// workbook in `data/converted docs/Mainline/` into the flat shipment-data
// template (single sheet "Shipment Data", carton-level rows) consumed by
// services/ciParser.parseShipmentData. One output per PO: PO<num>-shipment-data.xlsx.
//
// Layout: one workbook, per-PO sheet pairs INV-PO<num> / PL-PO<num>.
//   INV sheet item table (header "PO#" + "STYLE-COLOR"):
//     PO#(0) STYLE-COLOR(1) Knit/Woven(2) Style Desc(3) Color Desc(4)
//     Category(5) Gender(6) Composition(7) HTS(8) Qty(9) Unit Price(10) Total(11)
//   PL sheet carton table (header "CTN #" + "SKU"):
//     CTN#(0) -(1) seq(2) PO#(3) SKU(4) UPC(5) Style Desc(6) Color Desc(7)
//     TOTAL CTN(8) PCS/CTN[per size](9) TOTAL PCS[carton, first row only](10)
//     N/W(11) G/W(12) MEASURE(13)
// Carton numbers RESET per style-block in this template — we renumber to a
// single running counter per PO so each physical carton is distinct.
// Unit price / attrs join on style-color (SKU minus trailing size). Where the
// PL color code disagrees with the INV (source typo), we fall back to a unique
// style-number match and flag it.

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const DIR = path.join(__dirname, '..', 'data', 'converted docs', 'Mainline');
const SRC = 'INV#.022-PO04774.86-CW6648.9.5674.7113-TCM6684.6797-NRI DIST-TENTREE-USA-SEA-MJA-MAY.07.xlsx';

const TEMPLATE_HEADER = [
  'CTN#', 'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
  'Category', 'Gender', 'Composition', 'HTS Code', 'Unit Price USD', 'Total USD',
  'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
];

const S = (v) => String(v ?? '').trim();
const N = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const r2 = (n) => +n.toFixed(2);
// full SKU minus trailing size segment, spaces stripped ("TCM6797- 6289-M" -> "TCM6797-6289")
const normSku = (sku) => S(sku).replace(/\s+/g, '');
const styleColor = (sku) => normSku(sku).replace(/-[^-]+$/, '');
const styleNo = (sku) => normSku(sku).split('-')[0];
// gender-letter-agnostic keys (source sometimes swaps TCM/TCW). Operate on a
// style-color (NOT a full sku): "TCM7113-6303" -> loose "7113-6303", no "7113".
const looseSc = (sc) => sc.replace(/^[A-Za-z]+/, '');
const looseNo = (sc) => sc.split('-')[0].replace(/^[A-Za-z]+/, '');
const normMeasure = (m) => S(m).replace(/\s+/g, '').replace(/[*×xX]/g, 'X').toUpperCase();
const grid = (wb, name) => xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
const findRow = (rows, pred) => rows.findIndex(pred);

// ── INV sheet → style-color attribute map (+ style-number index for fallback) ──
function invAttrs(inv) {
  const h = findRow(inv, (r) => /^po\s*#?$/i.test(S(r[0])) && /style/i.test(S(r[1])));
  if (h < 0) throw new Error('INV header row (PO# / STYLE-COLOR) not found');
  const byStyleColor = new Map();
  const add = (map, key, sc) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(sc); };
  const byLooseSc = new Map();  // "7113-6303" -> Set (gender-letter typo)
  const byLooseNo = new Map();  // "6797"      -> Set (color-code typo)
  for (let i = h + 1; i < inv.length; i++) {
    const sc = normSku(inv[i][1]);
    if (!sc) break;                       // blank row ends the item block
    if (/total/i.test(S(inv[i][0]))) break;
    byStyleColor.set(sc, {
      knit_woven: S(inv[i][2]), style_description: S(inv[i][3]), color_description: S(inv[i][4]),
      category: S(inv[i][5]), gender: S(inv[i][6]), composition: S(inv[i][7]),
      hts_code: S(inv[i][8]), unit_price: N(inv[i][10]),
    });
    add(byLooseSc, looseSc(sc), sc);
    add(byLooseNo, looseNo(sc), sc);
  }
  return { byStyleColor, byLooseSc, byLooseNo };
}

// ── PL sheet → carton rows (global carton renumber) ──
function plRows(pl, po) {
  const h = findRow(pl, (r) => /ctn/i.test(S(r[0])) && /sku/i.test(S(r[4])));
  if (h < 0) throw new Error('PL header row (CTN # / SKU) not found');
  const rows = [];
  let ctn = 0, nw = 0, gw = 0, measure = '';
  for (let i = h + 1; i < pl.length; i++) {
    const r = pl[i];
    if (/grand\s*total|^total/i.test(S(r[0])) || /summary/i.test(S(r[0]))) break;
    const sku = normSku(r[4]);
    if (!sku) { if (rows.length && S(r[0]) === '') continue; else continue; }
    if (S(r[0]) !== '') { ctn += 1; nw = N(r[11]); gw = N(r[12]); measure = normMeasure(r[13]); }
    rows.push({
      ctn, sku, upc: S(r[5]), po,
      pcs: N(r[9]),
      // weights/measure belong to the carton's first row only
      nw: S(r[0]) !== '' ? nw : '', gw: S(r[0]) !== '' ? gw : '', measure: S(r[0]) !== '' ? measure : '',
    });
  }
  return rows;
}

function build(rows, attrs) {
  const aoa = [TEMPLATE_HEADER];
  const unmatched = [], fuzzy = [];
  for (const r of rows) {
    const sc = styleColor(r.sku);
    let a = attrs.byStyleColor.get(sc);
    if (!a) {
      // cascade: gender-letter typo (same number+color) → color-code typo (same number)
      const cand = attrs.byLooseSc.get(looseSc(sc)) || attrs.byLooseNo.get(looseNo(sc));
      if (cand && cand.size === 1) { const m = [...cand][0]; a = attrs.byStyleColor.get(m); fuzzy.push(`${sc} → ${m}`); }
    }
    if (!a) { a = {}; unmatched.push(r.sku); }
    const unit = a.unit_price || 0;
    aoa.push([
      r.ctn, r.po, r.sku, r.upc, a.knit_woven || '', a.style_description || '', a.color_description || '',
      a.category || '', a.gender || '', a.composition || '', a.hts_code || '',
      unit, r2(unit * r.pcs), r.pcs, r.nw, r.gw, r.measure,
    ]);
  }
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Shipment Data');
  const totalVal = r2(aoa.slice(1).reduce((s, row) => s + N(row[12]), 0)); // Total USD col
  return { wb, unmatched, fuzzy, totalVal };
}

const wb = xlsx.read(fs.readFileSync(path.join(DIR, SRC)), { type: 'buffer', cellDates: true });
// discover INV-<PO> / PL-<PO> sheet pairs
const pos = wb.SheetNames
  .map((n) => (n.match(/^INV-(PO\d+)$/i) || [])[1])
  .filter((p) => p && wb.SheetNames.some((n) => new RegExp(`^PL-${p}$`, 'i').test(n)));

for (const po of pos) {
  const attrs = invAttrs(grid(wb, `INV-${po}`));
  const rows = plRows(grid(wb, `PL-${po}`), po);
  const { wb: out, unmatched, fuzzy, totalVal } = build(rows, attrs);

  const outName = `${po}-shipment-data.xlsx`;
  xlsx.writeFile(out, path.join(DIR, outName));

  const cartons = new Set(rows.map((r) => r.ctn));
  const totalPcs = rows.reduce((s, r) => s + r.pcs, 0);
  console.log(`\n${po}  ->  ${outName}`);
  console.log(`   ${rows.length} SKU rows | ${cartons.size} carton(s) | ${totalPcs} pcs | $${totalVal}`);
  if (fuzzy.length) console.log(`   ~ FUZZY (style-no match, verify color): ${[...new Set(fuzzy)].join(', ')}`);
  if (unmatched.length) console.log(`   !! UNMATCHED (no INV attrs, price=0): ${[...new Set(unmatched)].join(', ')}`);
}
