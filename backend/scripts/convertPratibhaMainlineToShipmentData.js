'use strict';

// Convert PRATIBHA SYNTEX (mainline, ocean) "Commercial Invoice & Packing List"
// workbooks — the standard tentree CI template — in `data/converted docs/Mainline/`
// into the flat shipment-data template (single sheet "Shipment Data") consumed by
// services/ciParser.parseShipmentData.
//
// NB this is the EXCEL CI-template flavour, distinct from convertPratibhaToShipmentData.js
// (which transcribes the SMS Pratibha PDFs). One output per PO: PO<num>-shipment-data.xlsx.
//
// Layout:
//   • Sheet 1 "Commercial Invoice" — metadata block, then a header row
//     "PO# | SKU | UPC | Knit/Woven | Style | Color | Category | Gender |
//      Composition | HTS Code | Quantity | Unit Price USD | Total USD"; data below.
//     Keyed on the FULL SKU (size included).
//   • Sheet 2 (named after the PO) "Packing List" — MIXED cartons. Header
//     "CTN # | PO # | [SO NO] | SKU | UPC | Style | Color | PCS/CTN | N/W | G/W |
//      MEASURE". The optional SO-NO column shifts the rest right, so PL columns are
//     detected BY HEADER. A carton's CTN# + weights sit on its FIRST row; extra SKUs
//     in the same carton follow with a BLANK CTN# (inherit); blank rows separate
//     cartons; a CBM/Gross/Net/Box-size block ends the data.
//
// The internal PO is authoritative here; the `po` below is pinned to it (the two
// source filenames carry only the invoice number, not the PO).

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const DIR = path.join(__dirname, '..', 'data', 'converted docs', 'Mainline');

const TEMPLATE_HEADER = [
  'CTN#', 'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
  'Category', 'Gender', 'Composition', 'HTS Code', 'Unit Price USD', 'Total USD',
  'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
];

const FILES = [
  { file: 'Commercial Invoice & Packing List-411041739.xlsx', po: 'PO04731' },
  { file: 'Commercial Invoice & Packing List-411041736.xlsx', po: 'PO04759' },
];

const S = (v) => String(v ?? '').trim();
const N = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const r2 = (n) => +Number(n).toFixed(2);
const normMeasure = (m) => S(m).replace(/\s+/g, '').replace(/[*×xX]/g, 'X').toUpperCase();
// Footer/summary labels that end the carton data (this template trails the cartons
// with "No of Units"/"No of cartons"/CBM/weights/"Total" and a Req/Packed size matrix).
const isFooter = (t) => /^(cbm|gross|net\s*weight|box\s*size|total|remarks|grand|no\s*of|s\/c|packing)/i.test(t);

const gridOf = (wb, name) => xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', blankrows: false });

// Locate the CI sheet (has "PO# | SKU | …" header) and PL sheet (has "CTN # | … |
// SKU | … | PCS/CTN") by content, so we don't depend on sheet names.
function locateSheets(wb) {
  let ci = null, pl = null, ciHdr = -1, plHdr = -1;
  for (const name of wb.SheetNames) {
    const g = gridOf(wb, name);
    const ch = g.findIndex((r) => S(r[0]).toUpperCase() === 'PO#' && /sku/i.test(S(r[1])));
    if (ch >= 0 && ci === null) { ci = g; ciHdr = ch; continue; }
    const ph = g.findIndex((r) => /ctn/i.test(S(r[0])) && r.some((c) => /^sku$/i.test(S(c))) && r.some((c) => /pcs/i.test(S(c))));
    if (ph >= 0 && pl === null) { pl = g; plHdr = ph; }
  }
  if (!ci) throw new Error('Commercial Invoice sheet not found');
  if (!pl) throw new Error('Packing List sheet not found');
  return { ci, ciHdr, pl, plHdr };
}

// Inv sheet → full-SKU attribute map (fixed tentree CI columns).
function invAttrs(ci, hdr) {
  const attrs = new Map();
  for (let i = hdr + 1; i < ci.length; i++) {
    const r = ci[i];
    const sku = S(r[1]);
    if (!sku) break;
    if (attrs.has(sku)) continue;                 // first line per SKU wins (constant price)
    attrs.set(sku, {
      upc: S(r[2]), knit_woven: S(r[3]), style_description: S(r[4]), color_description: S(r[5]),
      category: S(r[6]), gender: S(r[7]), composition: S(r[8]), hts_code: S(r[9]),
      unit_price: N(r[11]),
    });
  }
  return attrs;
}

// Detect PL columns by header text (handles the optional SO-NO shift).
function plCols(headerRow) {
  const find = (re) => headerRow.findIndex((c) => re.test(S(c)));
  const cols = {
    ctn: find(/ctn/i), sku: find(/^sku$/i), upc: find(/upc/i), pcs: find(/pcs/i),
    nw: headerRow.findIndex((c) => /n\/w/i.test(S(c)) || /^net/i.test(S(c))),
    gw: headerRow.findIndex((c) => /g\/w/i.test(S(c)) || /^gross/i.test(S(c))),
    measure: find(/measure|dimension/i),
    style: find(/style/i), color: find(/color/i),
  };
  for (const k of ['ctn', 'sku', 'pcs']) if (cols[k] < 0) throw new Error(`Packing List column "${k}" not found`);
  return cols;
}

function packingRows(pl, plHdr, attrs, po) {
  const c = plCols(pl[plHdr]);
  const raw = [];                                  // one entry per SKU line (carton may span several)
  const unmatched = new Set();
  const cartonWeight = new Map();                  // ctn -> summed { nw, gw } across all its rows
  const cartonFirst = new Map();                   // ctn -> index of its first line in `raw`
  let ctn = null, measure = '';

  for (let i = plHdr + 1; i < pl.length; i++) {
    const r = pl[i];
    const c0 = S(r[c.ctn]);
    const sku = S(r[c.sku]);
    if (isFooter(c0)) break;
    if (!sku) continue;                            // blank separator row
    if (/^\d+(\.\d+)?$/.test(sku)) continue;       // numeric SKU cell = a stray summary value, not a line

    if (c0 !== '') { ctn = N(r[c.ctn]); measure = normMeasure(r[c.measure]); }   // new carton (else: same carton)

    const a = attrs.get(sku);
    if (!a) unmatched.add(sku);
    // Carton weight can be split across a mixed carton's rows → sum per carton,
    // emit the total on the carton's FIRST row (ciParser counts weight once per CTN#).
    const w = cartonWeight.get(ctn) || { nw: 0, gw: 0 };
    w.nw += N(r[c.nw]); w.gw += N(r[c.gw]);
    cartonWeight.set(ctn, w);
    if (!cartonFirst.has(ctn)) cartonFirst.set(ctn, raw.length);

    raw.push({
      ctn, sku, upc: S(r[c.upc]) || (a ? a.upc : ''),
      knit_woven: a ? a.knit_woven : '', style: a ? a.style_description : S(r[c.style]),
      color: a ? a.color_description : S(r[c.color]), category: a ? a.category : '',
      gender: a ? a.gender : '', composition: a ? a.composition : '', hts: a ? a.hts_code : '',
      unit: a ? a.unit_price : 0, pcs: N(r[c.pcs]), measure,
    });
  }

  const out = raw.map((x, idx) => {
    const isFirst = cartonFirst.get(x.ctn) === idx;
    const w = cartonWeight.get(x.ctn);
    return [
      x.ctn, po, x.sku, x.upc, x.knit_woven, x.style, x.color,
      x.category, x.gender, x.composition, x.hts,
      x.unit, r2(x.unit * x.pcs), x.pcs,
      isFirst ? r2(w.nw) : '', isFirst ? r2(w.gw) : '', isFirst ? x.measure : '',
    ];
  });
  return { rows: out, unmatched: [...unmatched] };
}

for (const { file, po } of FILES) {
  const src = path.join(DIR, file);
  if (!fs.existsSync(src)) { console.log(`\n${file}\n  !! not found — skipped`); continue; }

  const wb = xlsx.read(fs.readFileSync(src), { type: 'buffer', cellDates: true });
  const { ci, ciHdr, pl, plHdr } = locateSheets(wb);
  const attrs = invAttrs(ci, ciHdr);
  const { rows, unmatched } = packingRows(pl, plHdr, attrs, po);

  const out = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(out, xlsx.utils.aoa_to_sheet([TEMPLATE_HEADER, ...rows]), 'Shipment Data');
  const outName = `${po}-shipment-data.xlsx`;
  xlsx.writeFile(out, path.join(DIR, outName));

  // reconcile against the invoice
  let ciQty = 0, ciVal = 0;
  for (let i = ciHdr + 1; i < ci.length; i++) { const sku = S(ci[i][1]); if (!sku) break; ciQty += N(ci[i][10]); ciVal += N(ci[i][12]); }
  const cartons = new Set(rows.map((r) => r[0]));
  const totalPcs = rows.reduce((s, r) => s + N(r[13]), 0);
  const totalVal = r2(rows.reduce((s, r) => s + N(r[12]), 0));
  const ok = totalPcs === ciQty && Math.abs(totalVal - ciVal) < 0.5;
  console.log(`\n${file}`);
  console.log(`  -> ${outName}`);
  console.log(`     PO ${po} | ${rows.length} rows | ${cartons.size} carton(s) | ${totalPcs} pcs | $${totalVal.toLocaleString()}`);
  console.log(`     reconcile vs CI (qty ${ciQty}, $${r2(ciVal).toLocaleString()}): ${ok ? 'OK' : '!! MISMATCH'}`);
  if (unmatched.length) console.log(`     !! UNMATCHED SKUs (no CI attrs): ${unmatched.join(', ')}`);
}
