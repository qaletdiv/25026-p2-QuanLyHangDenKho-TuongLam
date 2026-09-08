'use strict';

// Convert tentree "TT SMS" supplier workbooks (dual HCIN/HCVN INV + PL sheets)
// in `data/converted docs/` into the flat shipment-data template (single sheet
// "Shipment Data", carton-level rows) that services/ciParser.parseShipmentData
// consumes. One output file per PO: PO<num>-shipment-data.xlsx.
//
// Source join: PL (HCIN) sheet = carton rows (SKU/size, UPC, pcs, style, color,
//   composition, per-line N/W·G/W, carton MEASURE) × INV (HCIN) unit price keyed
//   on full SKU. HCIN and HCVN carry identical line items/prices (only the
//   exporter entity differs), so HCIN is used.
//
// Per-carton N/W·G/W·MEASURE are placed on each carton's FIRST row (blank on
// continuation rows) — the layout parseShipmentData expects (it de-dups weight
// and measure by ctn_number).
//
// Usage: node scripts/convertTtSmsToShipmentData.js [--dir <subdir of "converted
// docs">] [--lot <n>] [--only <file substring>]...
//   --dir SMS --lot 2 --only "TT SMS 007"  ->  data/converted docs/SMS/PO<num>-shipment-data-lot2.xlsx

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const argsOf = (flag) => argv.reduce((acc, a, i) => (a === flag && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

const SUBDIR = argOf('--dir') || '';
const LOT = Number(argOf('--lot') || 1);
const ONLY = argsOf('--only');
const DIR = path.join(__dirname, '..', 'data', 'converted docs', SUBDIR);

const TEMPLATE_HEADER = [
  'CTN#', 'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
  'Category', 'Gender', 'Composition', 'HTS Code', 'Unit Price USD', 'Total USD',
  'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
];

const S = (v) => String(v ?? '').trim();
const N = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const r2 = (n) => +n.toFixed(2);
// "55*43*38" / "55 x 43 x 38" -> "55X43X38"
const normMeasure = (m) => S(m).replace(/\s+/g, '').replace(/[*×xX]/g, 'X').toUpperCase();

const grid = (wb, name) => xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });

// ── INV (HCIN): full-SKU -> unit price ───────────────────────────────────────
function priceMap(inv) {
  const sub = inv.findIndex((r) => r.some((c) => S(c).toUpperCase() === 'PO') && r.some((c) => /sku/i.test(S(c))));
  if (sub < 0) throw new Error('INV subheader row (PO / SKU) not found');
  const poCol = inv[sub].findIndex((c) => S(c).toUpperCase() === 'PO');
  const skuCol = poCol + 1;
  const priceHdr = inv[sub - 1] || [];
  const unitCol = priceHdr.findIndex((c) => /unit\s*price/i.test(S(c)));
  if (unitCol < 0) throw new Error('INV "Unit Price" column not found');

  const map = new Map();
  for (let i = sub + 1; i < inv.length; i++) {
    if (/total/i.test(S(inv[i][poCol]))) break;   // TOTAL row ends the item block
    const sku = S(inv[i][skuCol]);
    // The "Marks, Numbers" block (col 0) can start a row or two ABOVE the first
    // item line, so blanks only end the block once items have been seen.
    if (!sku) { if (map.size) break; else continue; }
    if (!map.has(sku)) map.set(sku, N(inv[i][unitCol]));
  }
  return map;
}

// ── PL (HCIN): carton rows ────────────────────────────────────────────────────
function packingRows(pl) {
  const hdr = pl.findIndex((r) => /ctn/i.test(S(r[0])) && /sku/i.test(S(r[4])));
  if (hdr < 0) throw new Error('PL header row not found');
  const C = { ctn: 0, po: 2, sku: 4, upc: 6, style: 7, comp: 8, color: 9, pcs: 10, nw: 12, gw: 13, measure: 14 };

  const rows = [];
  let ctn = null;
  for (let i = hdr + 1; i < pl.length; i++) {
    const r = pl[i];
    if (/^total/i.test(S(r[0])) || /summary/i.test(S(r[0]))) break;
    const sku = S(r[C.sku]);
    if (!sku) { if (rows.length) break; else continue; }
    if (S(r[C.ctn]) !== '') ctn = N(r[C.ctn]);
    rows.push({
      ctn, po: S(r[C.po]), sku, upc: S(r[C.upc]),
      style: S(r[C.style]), color: S(r[C.color]), composition: S(r[C.comp]),
      pcs: N(r[C.pcs]), nw: N(r[C.nw]), gw: N(r[C.gw]), measure: normMeasure(r[C.measure]),
    });
  }

  // Some workbooks (TT SMS 007/008/009) keep the header labels "Composition |
  // Color Description" but fill the two DATA columns the other way round. A
  // composition always states fibre percentages, a colourway never does — so
  // vote on the content and swap the pair rather than trusting the position.
  const looksComp = (v) => /\d\s*%/.test(v);
  const swapped = rows.filter((r) => looksComp(r.color)).length;
  const asLabelled = rows.filter((r) => looksComp(r.composition)).length;
  if (swapped > asLabelled) {
    for (const r of rows) { const t = r.color; r.color = r.composition; r.composition = t; }
    console.log('     (PL Composition/Color columns were swapped in the source — corrected)');
  }
  return rows;
}

function build(rows, prices) {
  // per-carton totals: N/W & G/W summed, MEASURE = first non-empty in the carton
  const cartonNW = new Map(), cartonGW = new Map(), cartonMeasure = new Map();
  for (const r of rows) {
    cartonNW.set(r.ctn, (cartonNW.get(r.ctn) || 0) + r.nw);
    cartonGW.set(r.ctn, (cartonGW.get(r.ctn) || 0) + r.gw);
    if (!cartonMeasure.get(r.ctn) && r.measure) cartonMeasure.set(r.ctn, r.measure);
  }

  const aoa = [TEMPLATE_HEADER];
  const seen = new Set();
  const unmatched = [];
  for (const r of rows) {
    const first = !seen.has(r.ctn);
    seen.add(r.ctn);
    const unit = prices.has(r.sku) ? prices.get(r.sku) : 0;
    if (!prices.has(r.sku)) unmatched.push(r.sku);
    aoa.push([
      r.ctn, `PO${r.po}`, r.sku, r.upc, '', r.style, r.color, '', '', r.composition, '',
      unit, r2(unit * r.pcs), r.pcs,
      first ? r2(cartonNW.get(r.ctn)) : '',
      first ? r2(cartonGW.get(r.ctn)) : '',
      first ? (cartonMeasure.get(r.ctn) || '') : '',
    ]);
  }
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Shipment Data');
  return { wb, unmatched, cartonNW, cartonGW, cartonMeasure };
}

const files = fs.readdirSync(DIR)
  .filter((f) => /^TT SMS .*\.xlsx$/i.test(f))
  .filter((f) => !ONLY.length || ONLY.some((o) => f.toLowerCase().includes(o.toLowerCase())));
for (const f of files) {
  const wb = xlsx.read(fs.readFileSync(path.join(DIR, f)), { type: 'buffer', cellDates: true });
  const invName = wb.SheetNames.find((n) => /^INV/i.test(n)); // prefer HCIN (first INV*)
  const plName = wb.SheetNames.find((n) => /^PL/i.test(n));
  const prices = priceMap(grid(wb, invName));
  const rows = packingRows(grid(wb, plName));
  const po = rows[0]?.po;
  const { wb: out, unmatched, cartonNW, cartonGW } = build(rows, prices);

  const outName = `PO${po}-shipment-data${LOT > 1 ? `-lot${LOT}` : ''}.xlsx`;
  xlsx.writeFile(out, path.join(DIR, outName));

  const cartons = [...new Set(rows.map((r) => r.ctn))];
  const totalPcs = rows.reduce((s, r) => s + r.pcs, 0);
  const totalVal = r2(rows.reduce((s, r) => s + (prices.get(r.sku) || 0) * r.pcs, 0));
  const totNW = r2(cartons.reduce((s, c) => s + cartonNW.get(c), 0));
  const totGW = r2(cartons.reduce((s, c) => s + cartonGW.get(c), 0));
  console.log(`\n${f}  (${invName} + ${plName})`);
  console.log(`  -> ${outName}`);
  console.log(`     PO${po} | ${rows.length} SKU rows | ${cartons.length} carton(s) | ${totalPcs} pcs | $${totalVal} | N/W ${totNW}kg | G/W ${totGW}kg`);
  if (unmatched.length) console.log(`     !! UNMATCHED (no INV price): ${[...new Set(unmatched)].join(', ')}`);
}
