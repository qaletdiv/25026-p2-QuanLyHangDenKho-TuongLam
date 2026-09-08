'use strict';

// Convert SHANGHAI PUCCI TEXTILE CO., LTD **mainline (ocean)** CI + packing-list
// workbooks in `data/converted docs/Mainline/` into the flat shipment-data template
// (single sheet "Shipment Data") consumed by services/ciParser.parseShipmentData.
// One output per source workbook.
//
//   PO04770B-NRI US.xlsx  -> PO04770  (invoice PT04770B, 83 ctns / 1,271 pcs)
//   PO04783B-NRI US.xlsx  -> PO04783  (invoice PT04783B, 81 ctns / 1,245 pcs)
//
// Both are Shanghai → Los Angeles sea consignments to NRI US (Fontana), shipment
// LGINBSHIP000827. Each covers only PART of its PO (29% / 35%), so more consignments
// are expected; the outputs take the plain PO<num>-shipment-data.xlsx name and a later
// consignment gets the -lotN suffix (as PO04728/56 lot 2 did). The vendor's "B" invoice
// letter is NOT carried into the filename. The leg/lot is decided when the booking is
// created — neither PO has one in the portal yet.
//
// Layout — the standard tentree CI template, same as convertPucciToShipmentData.js
// (that script is the SMS/air sibling and stays pointed at data/converted docs/SMS):
//   "Invoice" item table, header "PO#" | "SKU" | …:
//     PO#(0) SKU(1) UPC(2) Knit/Woven(3) StyleDesc(4) ColorDesc(5) Category(6)
//     Gender(7) Composition(8) HTS(9) Qty(10) UnitPrice(11) Total(12)
//   "Packing List" carton table, header "CTN #" | "PO #" | "SKU#" | …:
//     CTN#(0) PO#(1) SKU#(2) UPC(3) StyleDesc(4) ColorDesc(5) PCS/CTN(6)
//     N/W(7) G/W(8) MEASURE(9)
// Both sheets repeat headers on page breaks and trail into TOTAL / Summary /
// Gross-Weight blocks, so data rows are selected by SKU SHAPE, never by blank runs.
//
// ⚠ CARTON NUMBERS RESTART PER STYLE BLOCK. The PL labels cartons "1#,2#,…,10#" for
// the first style, then starts over at "1#" for the next — 83 physical cartons carry
// only 10 distinct labels. Feeding those through verbatim would collapse the carton
// count and drop most of the per-carton weights (parseShipmentData keeps weights/CBM
// once per DISTINCT ctn_number). So every labelled row opens a NEW carton and the
// output is renumbered 1..N globally; unlabelled rows continue the carton above them.
// The renumbered counts land exactly on the vendor's own "83 CTNS" / "81 CTNS".
//
// Join: PL carton rows × Invoice attrs on the FULL size-level SKU — 100% coverage
// both ways, and CI qty == PL qty for every SKU in both files.

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const DIR = path.join(__dirname, '..', 'data', 'converted docs', 'Mainline');
const MIGRATED = path.join(__dirname, '..', 'data', 'migrated');

const FILES = [
  { file: 'PO04770B-NRI US.xlsx', po: 'PO04770', out: 'PO04770-shipment-data.xlsx' },
  { file: 'PO04783B-NRI US.xlsx', po: 'PO04783', out: 'PO04783-shipment-data.xlsx' },
];

const TEMPLATE_HEADER = [
  'CTN#', 'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
  'Category', 'Gender', 'Composition', 'HTS Code', 'Unit Price USD', 'Total USD',
  'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
];

const S = (v) => String(v ?? '').trim();
const N = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const r2 = (n) => +Number(n).toFixed(2);
// tentree SKU shape: TCM6140-6412-L / TCW6652-0164-XS
const isSku = (v) => /^T[A-Z]{2}\d{3,5}-/i.test(S(v));
// "52X34X40CM" -> "52X34X40"
const normMeasure = (m) => S(m).replace(/\s+/g, '').replace(/[*×xX]/g, 'X').toUpperCase().replace(/CM$/, '');
// "1#" / "12" -> a carton label; anything else is not a carton row
const isCartonLabel = (v) => /^\d+\s*#?$/.test(S(v));
const cbmOf = (m) => { const p = S(m).split('X').map(Number); return p.length === 3 && p.every(isFinite) ? p[0] * p[1] * p[2] / 1e6 : 0; };

const skuMaster = new Map(
  JSON.parse(fs.readFileSync(path.join(MIGRATED, 'product_skus.json'), 'utf8'))
    .map((s) => [String(s.sku_code).toUpperCase(), s]),
);
const orderLines = JSON.parse(fs.readFileSync(path.join(MIGRATED, 'po_order_lines.json'), 'utf8'));

// ── "Invoice" → full-SKU attrs + the invoice's own stated totals ─────────────
function invoiceAttrs(grid) {
  const C = { po: 0, sku: 1, upc: 2, knit: 3, style: 4, color: 5, cat: 6, gender: 7, comp: 8, hts: 9, qty: 10, unit: 11, total: 12 };
  const attrs = new Map();
  let qty = 0, value = 0, lines = 0;
  const dup = [];
  for (const r of grid) {
    if (!isSku(r[C.sku])) continue;                 // metadata, repeated headers, totals
    const sku = S(r[C.sku]).toUpperCase();
    qty += N(r[C.qty]); value += N(r[C.total]); lines++;
    if (attrs.has(sku)) { dup.push(sku); attrs.get(sku).qty += N(r[C.qty]); continue; }
    attrs.set(sku, {
      upc: S(r[C.upc]), knit_woven: S(r[C.knit]), style: S(r[C.style]), color: S(r[C.color]),
      category: S(r[C.cat]), gender: S(r[C.gender]), composition: S(r[C.comp]), hts: S(r[C.hts]),
      unit: N(r[C.unit]), qty: N(r[C.qty]),
    });
  }
  // the unlabelled grand-total row that follows the last item line
  const totalRow = grid.find((r) => !isSku(r[C.sku]) && N(r[C.qty]) > 0 && N(r[C.total]) > 0 && !S(r[C.po]));
  const stated = totalRow ? { qty: N(totalRow[C.qty]), value: r2(N(totalRow[C.total])) } : null;
  return { attrs, ciQty: qty, ciValue: r2(value), ciLines: lines, dup, stated };
}

// ── "Packing List" → carton rows, cartons RENUMBERED 1..N ────────────────────
function packingRows(grid, attrs, po) {
  const C = { ctn: 0, po: 1, sku: 2, upc: 3, style: 4, color: 5, pcs: 6, nw: 7, gw: 8, measure: 9 };
  const rows = [];
  const cartons = new Map();          // seq -> { nw, gw, measure, label }
  const shipped = new Map();          // sku -> pcs
  const noAttr = new Set(), notInCatalogue = new Set(), notOnPo = new Set();
  const labels = [];
  let seq = 0, orphan = 0;

  for (const r of grid) {
    const opensCarton = isCartonLabel(r[C.ctn]);
    if (opensCarton) {
      seq++;
      labels.push(parseInt(S(r[C.ctn]), 10));
      cartons.set(seq, { nw: N(r[C.nw]), gw: N(r[C.gw]), measure: normMeasure(r[C.measure]), label: S(r[C.ctn]) });
    }
    if (!isSku(r[C.sku])) continue;   // headers + TOTAL/Summary/Gross-Weight block
    if (!seq) { orphan++; continue; } // a SKU row before any carton label (never seen)

    const sku = S(r[C.sku]).toUpperCase();
    const a = attrs.get(sku);
    if (!a) noAttr.add(sku);
    const master = skuMaster.get(sku) || {};
    if (!skuMaster.has(sku)) notInCatalogue.add(sku);
    if (!orderLines.some((l) => l.po_number === po && String(l.sku_code).toUpperCase() === sku)) notOnPo.add(sku);

    const pcs = N(r[C.pcs]);
    const unit = a ? a.unit : 0;
    shipped.set(sku, (shipped.get(sku) || 0) + pcs);
    const c = cartons.get(seq);

    rows.push([
      seq, po, sku, (a && a.upc) || S(r[C.upc]) || master.upc || '',
      (a && a.knit_woven) || master.knit_woven || '',
      (a && a.style) || S(r[C.style]), (a && a.color) || S(r[C.color]),
      (a && a.category) || master.category || '', (a && a.gender) || master.gender || '',
      (a && a.composition) || master.composition || '', (a && a.hts) || master.hts_code || '',
      unit, r2(unit * pcs), pcs,
      // per-carton facts on the carton's FIRST row only
      opensCarton ? c.nw || '' : '',
      opensCarton ? c.gw || '' : '',
      opensCarton ? c.measure : '',
    ]);
  }
  return { rows, cartons, shipped, labels, orphan, noAttr: [...noAttr], notInCatalogue: [...notInCatalogue], notOnPo: [...notOnPo] };
}

for (const { file, po, out } of FILES) {
  const src = path.join(DIR, file);
  if (!fs.existsSync(src)) { console.log(`\n${file}\n  !! not found — skipped`); continue; }

  const wb = xlsx.read(fs.readFileSync(src), { type: 'buffer', cellDates: true });
  const grid = (name) => {
    if (!wb.Sheets[name]) throw new Error(`Sheet "${name}" not found in ${file}. Sheets: ${wb.SheetNames.join(' | ')}`);
    return xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
  };

  const { attrs, ciQty, ciValue, ciLines, dup, stated } = invoiceAttrs(grid('Invoice'));
  const { rows, cartons, shipped, labels, orphan, noAttr, notInCatalogue, notOnPo } =
    packingRows(grid('Packing List'), attrs, po);

  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet([TEMPLATE_HEADER, ...rows]), 'Shipment Data');
  xlsx.writeFile(book, path.join(DIR, out));

  // ── reconciliation report ──────────────────────────────────────────────────
  const pcs = rows.reduce((s, r) => s + N(r[13]), 0);
  const value = r2(rows.reduce((s, r) => s + N(r[12]), 0));
  const nw = r2([...cartons.values()].reduce((s, c) => s + c.nw, 0));
  const gw = r2([...cartons.values()].reduce((s, c) => s + c.gw, 0));
  const cbm = +[...cartons.values()].reduce((s, c) => s + cbmOf(c.measure), 0).toFixed(3);

  console.log(`\n${file}`);
  console.log(`  -> converted docs/Mainline/${out}`);
  console.log(`     ${po} | ${rows.length} rows | ${cartons.size} cartons | ${pcs} pcs | $${value.toLocaleString()}`);
  console.log(`     N/W ${nw} kg | G/W ${gw} kg | CBM ${cbm}`);
  console.log(`     cartons renumbered 1..${cartons.size} (source used ${new Set(labels).size} distinct labels, restarting ${labels.filter((l, i) => i && l <= labels[i - 1]).length}x)`);
  console.log(`     CI: ${ciLines} lines | ${ciQty} pcs | $${ciValue.toLocaleString()}  ->  Δ pcs ${pcs - ciQty}, Δ value ${r2(value - ciValue)}`);
  if (stated) {
    const dq = pcs - stated.qty, dv = r2(value - stated.value);
    console.log(`     CI stated total row: ${stated.qty} pcs | $${stated.value.toLocaleString()}  ->  Δ pcs ${dq}, Δ value ${dv}`);
  }

  if (orphan) console.log(`     !! ${orphan} SKU row(s) before the first carton label — DROPPED`);
  if (dup.length) console.log(`     !! duplicate CI SKU lines (qty merged): ${[...new Set(dup)].join(', ')}`);
  if (noAttr.length) console.log(`     !! PL SKUs with no CI line (priced $0): ${noAttr.join(', ')}`);
  if (notInCatalogue.length) console.log(`     !! not in product_skus: ${notInCatalogue.join(', ')}`);
  if (notOnPo.length) console.log(`     !! not on ${po} order lines: ${notOnPo.join(', ')}`);

  const qtyDrift = [...attrs.entries()].filter(([s, a]) => (shipped.get(s) || 0) !== a.qty);
  if (qtyDrift.length) {
    console.log(`     !! ${qtyDrift.length} SKU(s) where PL qty ≠ CI qty:`);
    qtyDrift.slice(0, 10).forEach(([s, a]) => console.log(`        ${s} — CI ${a.qty} vs PL ${shipped.get(s) || 0}`));
  }

  const over = [];
  for (const [sku, q] of shipped) {
    const ol = orderLines.find((l) => l.po_number === po && String(l.sku_code).toUpperCase() === sku);
    if (ol && q > N(ol.ordered_qty)) over.push(`${sku} ${q}>${ol.ordered_qty}`);
  }
  if (over.length) console.log(`     !! qty exceeds ordered on ${over.length} SKU(s): ${over.slice(0, 10).join(', ')}`);

  const priced = [];
  for (const [sku] of shipped) {
    const ol = orderLines.find((l) => l.po_number === po && String(l.sku_code).toUpperCase() === sku);
    const row = rows.find((r) => r[2] === sku);
    if (ol && row && N(row[11]) !== N(ol.unit_price)) priced.push(`${sku} ${N(row[11])} vs PO ${N(ol.unit_price)}`);
  }
  if (priced.length) console.log(`     ~  CI rate ≠ PO line price on ${priced.length}/${shipped.size} SKUs (CI used) e.g. ${priced.slice(0, 3).join(', ')}`);

  const ordered = orderLines.filter((l) => l.po_number === po).reduce((s, l) => s + N(l.ordered_qty), 0);
  console.log(`     ${po} ordered ${ordered} pcs — this file covers ${pcs} (${(pcs / ordered * 100).toFixed(1)}%)`);
}
