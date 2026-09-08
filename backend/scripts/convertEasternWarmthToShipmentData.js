'use strict';

// Convert EASTERN WARMTH (mainline, ocean) commercial-invoice + packing-list
// workbooks in `data/converted docs/Mainline/` into the flat shipment-data
// template (single sheet "Shipment Data") consumed by
// services/ciParser.parseShipmentData — the same upload the mainline shipment-data
// route ingests. One output per PO: PO<num>-shipment-data.xlsx.
//
// Source layout (two sheets, distinct from the other vendors' templates):
//   • "Inv"          — commercial invoice. Header row starts "PO# | SKU | UPC | …";
//                      per-SKU attrs + Unit Price USD (cols below). Keyed on the
//                      FULL SKU (size included), which is unique per line.
//   • "Packing List" — MIXED cartons. Header "CTN # | PO # | SKU | UPC | … | PCS/CTN
//                      | N/W | G/W | MEASURE | DC DESTINATION". A carton's CTN# and
//                      weights sit on its FIRST row; extra SKUs in the same carton
//                      follow with a BLANK CTN# (inherit the carton). Fully-blank
//                      rows separate cartons; a CBM/Gross/Box-size block ends the data.
//
// Reconciled byte-for-byte against each CI: TT-370→PO04728 (193 ctns, 3516 pcs,
// $75,036.67) and TT-371→PO04756 (168 ctns, 2959 pcs, $63,796.36).

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const DIR = path.join(__dirname, '..', 'data', 'converted docs', 'Mainline');

const TEMPLATE_HEADER = [
  'CTN#', 'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
  'Category', 'Gender', 'Composition', 'HTS Code', 'Unit Price USD', 'Total USD',
  'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
];

// The two source workbooks and the PO each one belongs to (the PL PO field is
// authoritative, but we pin it explicitly — one supplier template shipped with a
// stale PO# in its header block).
const FILES = [
  { file: 'TT-370 Vancouver Canada CI & PL PO04728 193 Ctns (1).xlsx', po: 'PO04728' },
  { file: 'TT-371 CI & PL Vancouver Canada PO 4756 168 Ctns (1).xlsx', po: 'PO04756' },
];

const S = (v) => String(v ?? '').trim();
const N = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const r2 = (n) => +Number(n).toFixed(2);
// "54 x 35 x 35" / "54*35*35" -> "54X35X35"
const normMeasure = (m) => S(m).replace(/\s+/g, '').replace(/[*×xX]/g, 'X').toUpperCase();
// data ends at the CBM / Gross Weight / Net Weight / Box Size / Total summary block
const isFooter = (t) => /^(cbm|gross|net\s*weight|box\s*size|total|remarks|grand)/i.test(t);

// ── Inv sheet → full-SKU attribute map ───────────────────────────────────────
function invAttrs(grid) {
  const hdr = grid.findIndex((r) => S(r[0]).toUpperCase() === 'PO#' && /sku/i.test(S(r[1])));
  if (hdr < 0) throw new Error('Inv header row (PO# | SKU | …) not found');
  const attrs = new Map();
  for (let i = hdr + 1; i < grid.length; i++) {
    const r = grid[i];
    const sku = S(r[1]);
    if (!sku) break;                      // blank SKU ends the invoice block
    if (attrs.has(sku)) continue;         // first line per SKU wins (price is constant)
    attrs.set(sku, {
      upc: S(r[2]), knit_woven: S(r[3]), style_description: S(r[4]), color_description: S(r[5]),
      category: S(r[6]), gender: S(r[7]), composition: S(r[8]), hts_code: S(r[9]),
      unit_price: N(r[11]),
    });
  }
  return attrs;
}

// ── Packing List → carton-level output rows ──────────────────────────────────
function packingRows(grid, attrs, po) {
  const hdr = grid.findIndex((r) => /ctn/i.test(S(r[0])) && /sku/i.test(S(r[2])));
  if (hdr < 0) throw new Error('Packing List header row (CTN # | … | SKU) not found');

  const out = [];
  const unmatched = new Set();
  let ctn = null, nw = 0, gw = 0, measure = '';
  let firstRowOfCarton = false;

  for (let i = hdr + 1; i < grid.length; i++) {
    const r = grid[i];
    const c0 = S(r[0]);
    const sku = S(r[2]);
    if (isFooter(c0)) break;               // summary block → done
    if (!sku) continue;                    // blank separator row → skip (not a carton break)

    if (c0 !== '') {                       // new carton: CTN# + weights live on this row
      ctn = N(r[0]); nw = N(r[7]); gw = N(r[8]); measure = normMeasure(r[9]);
      firstRowOfCarton = true;
    } else {
      firstRowOfCarton = false;            // additional SKU in the SAME carton
    }

    const a = attrs.get(sku);
    if (!a) unmatched.add(sku);
    const pcs = N(r[6]);
    const unit = a ? a.unit_price : 0;
    out.push([
      ctn, po, sku, S(r[3]) || (a ? a.upc : ''),
      a ? a.knit_woven : '', a ? a.style_description : S(r[4]), a ? a.color_description : S(r[5]),
      a ? a.category : '', a ? a.gender : '', a ? a.composition : '', a ? a.hts_code : '',
      unit, r2(unit * pcs), pcs,
      // weights/measure are per carton → first row only (ciParser dedups by CTN#)
      firstRowOfCarton ? nw : '', firstRowOfCarton ? gw : '', firstRowOfCarton ? measure : '',
    ]);
  }
  return { rows: out, unmatched: [...unmatched] };
}

for (const { file, po } of FILES) {
  const src = path.join(DIR, file);
  if (!fs.existsSync(src)) { console.log(`\n${file}\n  !! not found — skipped`); continue; }

  const wb = xlsx.read(fs.readFileSync(src), { type: 'buffer', cellDates: true });
  const grid = (name) => xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', blankrows: false });

  const attrs = invAttrs(grid('Inv'));
  const { rows, unmatched } = packingRows(grid('Packing List'), attrs, po);

  const out = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(out, xlsx.utils.aoa_to_sheet([TEMPLATE_HEADER, ...rows]), 'Shipment Data');
  const outName = `${po}-shipment-data.xlsx`;
  xlsx.writeFile(out, path.join(DIR, outName));

  const cartons = new Set(rows.map((r) => r[0]));
  const totalPcs = rows.reduce((s, r) => s + N(r[13]), 0);
  const totalVal = r2(rows.reduce((s, r) => s + N(r[12]), 0));
  console.log(`\n${file}`);
  console.log(`  -> ${outName}`);
  console.log(`     PO ${po} | ${rows.length} rows | ${cartons.size} carton(s) | ${totalPcs} pcs | $${totalVal.toLocaleString()}`);
  if (unmatched.length) console.log(`     !! UNMATCHED SKUs (no Inv attrs): ${unmatched.join(', ')}`);
}
