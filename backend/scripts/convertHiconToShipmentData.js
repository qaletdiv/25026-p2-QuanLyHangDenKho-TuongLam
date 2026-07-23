'use strict';

// Convert HICON "CI 2" / "PL 2" supplier workbooks in `data/converted docs/`
// into the flat shipment-data template (single sheet "Shipment Data") consumed
// by services/ciParser.parseShipmentData. One output per PO variant:
// PO<num>-shipment-data.xlsx.
//
// Layout: separate CI (.xls, "STYLE NO." + Size + COLOR + QUANTITY + UNIT PRICE)
// and PL (.xlsx, "Style#" + Size + Color + Qty/Pack + per-shipment Net/Gross
// weight + CTN Dimensions) workbooks, in three variants keyed by PO:
//   HQ -> PO04796, NRI CA -> PO04797, NRI US -> PO04798.
// Each variant = one PO shipped as a single carton. SKU = Style# + "-" + size
// (verified against product_skus.json). No UPC/HTS/composition in source →
// left blank. Unit price = the CI invoice price (commercial-invoice value).
//
// Per-carton Net/Gross weight + MEASURE are placed on the carton's FIRST row
// (blank on continuation rows) — the layout parseShipmentData expects.

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const DIR = path.join(__dirname, '..', 'data', 'converted docs');
const VARIANTS = ['HQ', 'NRI CA', 'NRI US'];

const TEMPLATE_HEADER = [
  'CTN#', 'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
  'Category', 'Gender', 'Composition', 'HTS Code', 'Unit Price USD', 'Total USD',
  'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
];

const S = (v) => String(v ?? '').trim();
const N = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const r2 = (n) => +n.toFixed(2);
const sizeCode = (v) => S(v).toUpperCase().replace(/[\s/]/g, ''); // "S/M" -> "SM"
const normMeasure = (m) => S(m).replace(/cm$/i, '').replace(/\s+/g, '').replace(/[*×xX]/g, 'X').toUpperCase();
const grid = (wb) => xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
const findCol = (row, re) => row.findIndex((c) => re.test(S(c)));

// ── CI (.xls): Style# -> unit price ───────────────────────────────────────────
function priceMap(ci) {
  const h = ci.findIndex((r) => r.some((c) => /style\s*no/i.test(S(c))) && r.some((c) => /unit\s*price/i.test(S(c))));
  if (h < 0) throw new Error('CI header (STYLE NO. / UNIT PRICE) not found');
  const styleCol = findCol(ci[h], /style\s*no/i);
  const priceCol = findCol(ci[h], /unit\s*price/i);
  const map = new Map();
  for (let i = h + 1; i < ci.length; i++) {
    const style = S(ci[i][styleCol]);
    if (/^ZAU/i.test(style) && !map.has(style)) map.set(style, N(ci[i][priceCol]));
  }
  return map;
}

// ── PL (.xlsx): carton rows + PO ──────────────────────────────────────────────
function packing(pl) {
  const poRow = pl.find((r) => /^s\/c\s*no/i.test(S(r[0])));
  const po = poRow ? (poRow.slice(1).map(S).find((v) => /^PO\d+/i.test(v)) || '') : '';

  const h = pl.findIndex((r) => /^style/i.test(S(r[0])) && r.some((c) => /qty/i.test(S(c))));
  if (h < 0) throw new Error('PL header (Style# / Qty) not found');
  const hdr = pl[h];
  const C = {
    style: 0, des: findCol(hdr, /des/i), size: findCol(hdr, /size/i), color: findCol(hdr, /color/i),
    qty: findCol(hdr, /qty/i), nw: findCol(hdr, /net\s*weight/i), gw: findCol(hdr, /gross\s*weight/i),
    dims: findCol(hdr, /dimension/i),
  };

  const rows = [];
  for (let i = h + 1; i < pl.length; i++) {
    const style = S(pl[i][C.style]);
    if (!/^ZAU/i.test(style)) { if (rows.length) break; else continue; } // blank / totals row ends block
    rows.push({
      style, des: S(pl[i][C.des]), size: sizeCode(pl[i][C.size]), color: S(pl[i][C.color]),
      qty: N(pl[i][C.qty]), nw: N(pl[i][C.nw]), gw: N(pl[i][C.gw]), measure: normMeasure(pl[i][C.dims]),
    });
  }
  return { po, rows };
}

function build(po, rows, prices) {
  // single carton per shipment: totals appear on the first row only
  const nw = r2(rows.reduce((s, r) => s + r.nw, 0));
  const gw = r2(rows.reduce((s, r) => s + r.gw, 0));
  const measure = rows.map((r) => r.measure).find(Boolean) || '';

  const aoa = [TEMPLATE_HEADER];
  const unmatched = [];
  rows.forEach((r, i) => {
    const unit = prices.has(r.style) ? prices.get(r.style) : 0;
    if (!prices.has(r.style)) unmatched.push(r.style);
    aoa.push([
      1, po, `${r.style}-${r.size}`, '', '', r.des, r.color, '', '', '', '',
      unit, r2(unit * r.qty), r.qty,
      i === 0 ? nw : '', i === 0 ? gw : '', i === 0 ? measure : '',
    ]);
  });
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Shipment Data');
  return { wb, unmatched, nw, gw };
}

for (const v of VARIANTS) {
  const ciFile = fs.readdirSync(DIR).find((f) => new RegExp(`^CI 2-.*${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.xls$`, 'i').test(f));
  const plFile = fs.readdirSync(DIR).find((f) => new RegExp(`^PL 2-.*${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.xlsx$`, 'i').test(f));
  if (!ciFile || !plFile) { console.log(`\n[${v}] SKIP — CI/PL not found (ci=${ciFile}, pl=${plFile})`); continue; }

  const prices = priceMap(grid(xlsx.read(fs.readFileSync(path.join(DIR, ciFile)), { type: 'buffer' })));
  const { po, rows } = packing(grid(xlsx.read(fs.readFileSync(path.join(DIR, plFile)), { type: 'buffer', cellDates: true })));
  const { wb, unmatched, nw, gw } = build(po, rows, prices);

  const outName = `${po}-shipment-data.xlsx`;
  xlsx.writeFile(wb, path.join(DIR, outName));

  const totalPcs = rows.reduce((s, r) => s + r.qty, 0);
  const totalVal = r2(rows.reduce((s, r) => s + (prices.get(r.style) || 0) * r.qty, 0));
  console.log(`\n${plFile} + ${ciFile}  [${v}]`);
  console.log(`  -> ${outName}`);
  console.log(`     ${po} | ${rows.length} SKU rows | 1 carton | ${totalPcs} pcs | $${totalVal} | N/W ${nw}kg | G/W ${gw}kg`);
  if (unmatched.length) console.log(`     !! UNMATCHED (no CI price): ${[...new Set(unmatched)].join(', ')}`);
}
