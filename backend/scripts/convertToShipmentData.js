'use strict';

// One-off: convert tentree CI/PL workbooks in `data/converted docs/` into the
// flat shipment-data template (single sheet "Shipment Data", carton-level rows).
// Join: PL sheet (full SKU + size, UPC, qty, per-carton N/W·G/W·MEASURE) ×
//       INV sheet attrs keyed on style-color (knit/woven, category, gender,
//       composition, HTS, unit price).

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const DIR = path.join(__dirname, '..', 'data', 'converted docs');

const TEMPLATE_HEADER = [
  'CTN#', 'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
  'Category', 'Gender', 'Composition', 'HTS Code', 'Unit Price USD', 'Total USD',
  'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
];

const S = (v) => String(v ?? '').trim();
const N = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
// style-color = full SKU minus the trailing size segment (ZCM6797-6896-M -> ZCM6797-6896)
const styleColor = (sku) => S(sku).replace(/-[^-]+$/, '');
// normalize measure "60 x 40 x 20" -> "60X40X20"
const normMeasure = (m) => S(m).replace(/\s+/g, '').replace(/[*×xX]/g, 'X').toUpperCase();

function findRow(rows, pred) { return rows.findIndex(pred); }

function parseWorkbook(fileBuffer) {
  const wb = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
  const grid = (name) => xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });

  // ── INV sheet (first sheet) → style-color attribute map ──
  const inv = grid(wb.SheetNames[0]);
  const invHdr = findRow(inv, (r) => S(r[0]).toUpperCase() === 'PO#' && /style/i.test(S(r[1])));
  if (invHdr < 0) throw new Error('INV header row not found');
  const attrs = new Map();
  const poNumbers = new Set();
  for (let i = invHdr + 1; i < inv.length; i++) {
    const r = inv[i];
    const sc = S(r[1]);              // STYLE-COLOR
    if (!sc) break;                 // blank row ends the block
    poNumbers.add(S(r[0]));
    attrs.set(sc, {
      knit_woven: S(r[2]), style_description: S(r[3]), color_description: S(r[4]),
      category: S(r[5]), gender: S(r[6]), composition: S(r[7]), hts_code: S(r[8]),
      unit_price: N(r[10]),
    });
  }

  // ── PL sheet → carton rows ──
  const pl = grid('PL');
  const plHdr = findRow(pl, (r) => /ctn/i.test(S(r[0])) && /sku/i.test(S(r[2])));
  if (plHdr < 0) throw new Error('PL header row not found');
  const rows = [];
  let ctn = null, nw = 0, gw = 0, measure = '';
  for (let i = plHdr + 1; i < pl.length; i++) {
    const r = pl[i];
    const sku = S(r[2]);
    if (!sku) {
      // stop at the TOTAL / summary block (first blank-SKU row after data)
      if (rows.length) break;
      continue;
    }
    if (/total/i.test(S(r[0]))) break;
    if (S(r[0]) !== '') { ctn = N(r[0]); nw = N(r[8]); gw = N(r[9]); measure = normMeasure(r[10]); }
    const po = S(r[1]) || [...poNumbers][0];
    const qty = N(r[6]);
    const a = attrs.get(styleColor(sku)) || {};
    rows.push({
      ctn, po, sku, upc: S(r[3]),
      knit_woven: a.knit_woven || '',
      style_description: a.style_description || S(r[4]),
      color_description: a.color_description || S(r[5]),
      category: a.category || '', gender: a.gender || '', composition: a.composition || '',
      hts_code: a.hts_code || '', unit_price: a.unit_price || 0,
      total_usd: +((a.unit_price || 0) * qty).toFixed(2),
      pcs: qty, nw, gw, measure,
      _matched: attrs.has(styleColor(sku)),
    });
  }
  return { rows, po: [...poNumbers][0] };
}

function build(rows) {
  const aoa = [TEMPLATE_HEADER];
  for (const r of rows) {
    aoa.push([
      r.ctn, r.po, r.sku, r.upc, r.knit_woven, r.style_description, r.color_description,
      r.category, r.gender, r.composition, r.hts_code, r.unit_price, r.total_usd,
      r.pcs, r.nw, r.gw, r.measure,
    ]);
  }
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Shipment Data');
  return wb;
}

const files = fs.readdirSync(DIR).filter((f) => /^INV.*\.xlsx$/i.test(f));
for (const f of files) {
  const { rows, po } = parseWorkbook(fs.readFileSync(path.join(DIR, f)));
  const out = path.join(DIR, `${po}-shipment-data.xlsx`);
  xlsx.writeFile(build(rows), out);

  const unmatched = rows.filter((r) => !r._matched);
  const totalPcs = rows.reduce((s, r) => s + r.pcs, 0);
  const totalVal = +rows.reduce((s, r) => s + r.total_usd, 0).toFixed(2);
  const cartons = new Set(rows.map((r) => r.ctn));
  console.log(`\n${f}`);
  console.log(`  -> ${path.basename(out)}`);
  console.log(`     PO ${po} | ${rows.length} rows | ${cartons.size} carton(s) | ${totalPcs} pcs | $${totalVal}`);
  if (unmatched.length) console.log(`     !! UNMATCHED style-color: ${unmatched.map((r) => r.sku).join(', ')}`);
  rows.forEach((r) => console.log(`     ${r.ctn} | ${r.sku} | ${r.pcs} | $${r.unit_price} | $${r.total_usd} | ${r.measure}`));
}
