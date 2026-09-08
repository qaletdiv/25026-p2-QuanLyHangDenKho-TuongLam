'use strict';

// Convert the EASTERN WARMTH / Rajlakshmi **lot 2** commercial-invoice + packing-list
// workbooks in `data/converted docs/Mainline/` into the flat shipment-data template
// (single sheet "Shipment Data") consumed by services/ciParser.parseShipmentData.
// One output per PO: PO<num>-shipment-data-lot2.xlsx.
//
//   INV_0124_TENTREE_SEA_CA_26-27.xls   -> PO04728  (132 ctns / 7,279 pcs)
//   INV_0125_TENTREE_SEA_CA_26-27.xlsx  -> PO04756  (222 ctns / 13,065 pcs)
//
// Both match booking 6 / shipment 6 lot 2 exactly (mainline_shipment_legs
// spl_6_77 = 7279, spl_6_45 = 13065; mainline_booking_po_legs carton counts 132/222).
//
// This is a DIFFERENT vendor template from lot 1 — hence a separate script rather
// than an edit to convertEasternWarmthToShipmentData.js (which stays reconciled
// against the TT-370/TT-371 workbooks):
//   • sheet "Invoice " — header row `PO # | SKU | Style Description | Colour | Item |
//     HS CODE | COMPOSTION | Net Wt` with Quantity/Rate/Amount in the three unlabelled
//     columns 8/9/10 (their captions live in the Marks & Nos. block above).
//     Its SKU column is NOT usable as a key: the vendor repeats one size's SKU across
//     every colourway of a style (TCM4619-6507-L appears for both "Blue Horizon/Dark
//     Forest Green" and "Red Chestnut/Hazelnut"), and the style-colour code itself
//     drifts from the packing list (CI TCM6949-6714 vs PL TCM6949-6436 for the same
//     M Mountain Portal / Red Chestnut/Hazelnut line). The CI grain is really
//     **style + colour**, one row per colourway, qty summed over sizes — so that pair
//     is the join key, and every one of the 51/57 CI lines reconciles to the PL
//     quantity for its style+colour.
//   • sheet "PL" — MIXED cartons, the spine of the output. `CTN # | PO # | SKU | UPC |
//     Style Description | Color Description | PCS/CTN | N/W | G/W | MEASURE`. A carton's
//     CTN#/weights/measure sit on its FIRST row; further SKUs in the same carton follow
//     with a blank CTN# (parseShipmentData sums weights once per distinct CTN#).
//     The PL's SKU is the authoritative, size-level code — all 255/285 are in
//     product_skus AND on the PO's order lines.
//
// Attribute sourcing (sheet-first, product_skus fallback):
//   SKU/UPC/style/colour/pcs/weights/measure ← PL
//   unit price + composition                 ← CI, joined on style+colour
//   category + gender                        ← CI "Item" ("Mens Polo Tshirt" → Mens /
//                                              Polo T-Shirt); master fallback
//   knit/woven                               ← CI package line "(Knitted Products)"
//   HTS code                                 ← CI column is EMPTY in both files and the
//                                              master has none for these SKUs → blank.
//
// Unit price = the CI **Rate**, i.e. what was actually invoiced. It runs BELOW the PO
// line price here (e.g. TCM4619-6507-* CI 3.85 vs PO 5.35) — the CI governs the customs
// value and the landed-cost basis, same rule as the other converters. The run prints
// the divergence so it stays a visible decision.

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const DIR = path.join(__dirname, '..', 'data', 'converted docs', 'Mainline');
const MIGRATED = path.join(__dirname, '..', 'data', 'migrated');

const TEMPLATE_HEADER = [
  'CTN#', 'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
  'Category', 'Gender', 'Composition', 'HTS Code', 'Unit Price USD', 'Total USD',
  'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
];

const FILES = [
  { file: 'INV_0124_TENTREE_SEA_CA_26-27.xls', po: 'PO04728', out: 'PO04728-shipment-data-lot2.xlsx' },
  { file: 'INV_0125_TENTREE_SEA_CA_26-27.xlsx', po: 'PO04756', out: 'PO04756-shipment-data-lot2.xlsx' },
];

const S = (v) => String(v ?? '').trim();
const N = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const r2 = (n) => +Number(n).toFixed(2);
// "61X38X25" / "61 x 38 x 25" -> "61X38X25"
const normMeasure = (m) => S(m).replace(/cm$/i, '').replace(/\s+/g, '').replace(/[*×xX]/g, 'X').toUpperCase();
// join key: the CI's real grain is style + colour
const key = (style, colour) => `${S(style).toLowerCase().replace(/\s+/g, ' ')}|${S(colour).toLowerCase().replace(/\s+/g, ' ')}`;
// whitespace tidy + the vendor's own "Tancel"/"Tencel" split spelling of one fibre
const composition = (c) => S(c).replace(/\s+/g, ' ').replace(/\bTancel\b/gi, 'Tencel');
const isFooter = (t) => /^(cbm|gross|net\s*weight|box\s*size|total|remarks|grand)/i.test(t);
const cbmOf = (m) => { const p = S(m).split(/[X*×x]/).map(Number); return p.length === 3 && p.every(isFinite) ? p[0] * p[1] * p[2] / 1e6 : 0; };

// "Mens Polo Tshirt" -> { gender: 'Mens', category: 'Polo T-Shirt' }
function splitItem(item) {
  const t = S(item);
  const m = /^(mens?|womens?)\s+(.*)$/i.exec(t);
  if (!m) return { gender: '', category: t };
  const g = /^m/i.test(m[1]) ? 'Mens' : 'Womens';
  const category = m[2].replace(/\bt\s*-?\s*shirts?\b/gi, 'T-Shirt').replace(/\s+/g, ' ').trim();
  return { gender: g, category };
}

const skuMaster = new Map(
  JSON.parse(fs.readFileSync(path.join(MIGRATED, 'product_skus.json'), 'utf8'))
    .map((s) => [String(s.sku_code).toUpperCase(), s]),
);
const orderLines = JSON.parse(fs.readFileSync(path.join(MIGRATED, 'po_order_lines.json'), 'utf8'));

// ── "Invoice " sheet → style+colour attribute map ────────────────────────────
function invoiceAttrs(grid) {
  const hdr = grid.findIndex((r) => /^po\s*#/i.test(S(r[0])) && /sku/i.test(S(r[1])));
  if (hdr < 0) throw new Error('Invoice header row (PO # | SKU | …) not found');
  const C = { po: 0, sku: 1, style: 2, colour: 3, item: 4, hts: 5, comp: 6, qty: 8, rate: 9, amount: 10 };

  // "(Knitted Products)" / "(Woven Products)" in the No. & Kind of Packages block
  const kindRow = grid.slice(0, hdr).find((r) => /\b(knitted|woven)\b/i.test(S(r[3])));
  const knitWoven = kindRow ? (/knitted/i.test(S(kindRow[3])) ? 'Knit' : 'Woven') : '';

  const attrs = new Map();
  let qty = 0, amount = 0, lines = 0;
  for (let i = hdr + 1; i < grid.length; i++) {
    const po = S(grid[i][C.po]);
    if (!po) continue;                       // blank spacer row inside the block
    if (!/^\d{4,6}$/.test(po)) break;        // Gross Weight / summary block → done
    const r = grid[i];
    const k = key(r[C.style], r[C.colour]);
    qty += N(r[C.qty]); amount += N(r[C.amount]); lines++;
    if (attrs.has(k)) { attrs.get(k).qty += N(r[C.qty]); continue; }
    attrs.set(k, {
      style: S(r[C.style]), colour: S(r[C.colour]),
      ...splitItem(r[C.item]),
      hts: S(r[C.hts]), composition: composition(r[C.comp]),
      unit: N(r[C.rate]), qty: N(r[C.qty]),
    });
  }
  return { attrs, knitWoven, ciQty: qty, ciAmount: r2(amount), ciLines: lines };
}

// ── "PL" sheet → carton-level output rows ────────────────────────────────────
function packingRows(grid, ctx) {
  const hdr = grid.findIndex((r) => /ctn/i.test(S(r[0])) && /sku/i.test(S(r[2])));
  if (hdr < 0) throw new Error('PL header row (CTN # | … | SKU) not found');
  const C = { ctn: 0, po: 1, sku: 2, upc: 3, style: 4, colour: 5, pcs: 6, nw: 7, gw: 8, measure: 9 };

  const { attrs, knitWoven, po } = ctx;
  const rows = [];
  const unmatched = new Set(), notInCatalogue = new Set(), notOnPo = new Set();
  const shipped = new Map();                 // sku -> pcs, for the over-ship check
  const plQty = new Map();                   // style|colour -> pcs, to reconcile vs CI
  const cartons = new Map();                 // ctn -> { nw, gw, measure }
  let ctn = null;

  for (let i = hdr + 1; i < grid.length; i++) {
    const r = grid[i];
    if (isFooter(S(r[C.ctn]))) break;
    const sku = S(r[C.sku]).toUpperCase();
    if (!sku) continue;                      // blank separator between carton groups

    const firstOfCarton = S(r[C.ctn]) !== '';
    if (firstOfCarton) {
      ctn = N(r[C.ctn]);
      cartons.set(ctn, { nw: N(r[C.nw]), gw: N(r[C.gw]), measure: normMeasure(r[C.measure]) });
    }

    const k = key(r[C.style], r[C.colour]);
    const a = attrs.get(k);
    if (!a) unmatched.add(k);
    const master = skuMaster.get(sku) || {};
    if (!skuMaster.has(sku)) notInCatalogue.add(sku);
    if (!orderLines.some((l) => l.po_number === po && String(l.sku_code).toUpperCase() === sku)) notOnPo.add(sku);

    const pcs = N(r[C.pcs]);
    const unit = a ? a.unit : 0;
    shipped.set(sku, (shipped.get(sku) || 0) + pcs);
    plQty.set(k, (plQty.get(k) || 0) + pcs);

    rows.push([
      ctn, po, sku, S(r[C.upc]) || master.upc || '',
      knitWoven || master.knit_woven || '',
      S(r[C.style]) || (a ? a.style : ''), S(r[C.colour]) || (a ? a.colour : ''),
      (a && a.category) || master.category || '', (a && a.gender) || master.gender || '',
      (a && a.composition) || master.composition || '',
      (a && a.hts) || master.hts_code || '',
      unit, r2(unit * pcs), pcs,
      // per-carton facts on the carton's FIRST row only
      firstOfCarton ? cartons.get(ctn).nw || '' : '',
      firstOfCarton ? cartons.get(ctn).gw || '' : '',
      firstOfCarton ? cartons.get(ctn).measure : '',
    ]);
  }
  return { rows, cartons, unmatched: [...unmatched], notInCatalogue: [...notInCatalogue], notOnPo: [...notOnPo], shipped, plQty };
}

for (const { file, po, out } of FILES) {
  const src = path.join(DIR, file);
  if (!fs.existsSync(src)) { console.log(`\n${file}\n  !! not found — skipped`); continue; }

  const wb = xlsx.read(fs.readFileSync(src), { type: 'buffer', cellDates: true });
  const sheet = (re) => {
    const name = wb.SheetNames.find((n) => re.test(n.trim()));
    if (!name) throw new Error(`No sheet matching ${re} in ${file}. Sheets: ${wb.SheetNames.join(' | ')}`);
    return xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
  };

  const { attrs, knitWoven, ciQty, ciAmount, ciLines } = invoiceAttrs(sheet(/^invoice$/i));
  const { rows, cartons, unmatched, notInCatalogue, notOnPo, shipped, plQty } =
    packingRows(sheet(/^pl$/i), { attrs, knitWoven, po });

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
  console.log(`     CI: ${ciLines} lines | ${ciQty} pcs | $${ciAmount.toLocaleString()}  ->  Δ pcs ${pcs - ciQty}, Δ value ${r2(value - ciAmount)}`);

  const qtyDrift = [...attrs.entries()].filter(([k, a]) => (plQty.get(k) || 0) !== a.qty);
  if (qtyDrift.length) {
    console.log(`     !! ${qtyDrift.length} style|colour line(s) where PL qty ≠ CI qty:`);
    qtyDrift.slice(0, 10).forEach(([k, a]) => console.log(`        ${k} — CI ${a.qty} vs PL ${plQty.get(k) || 0}`));
  }
  if (unmatched.length) console.log(`     !! PL style|colour with no CI line (priced $0): ${unmatched.join(' ; ')}`);
  if (notInCatalogue.length) console.log(`     !! not in product_skus: ${notInCatalogue.join(', ')}`);
  if (notOnPo.length) console.log(`     !! not on ${po} order lines: ${notOnPo.join(', ')}`);

  // shipped-vs-ordered (this lot alone; lot 1 shipped against the same PO)
  const over = [];
  for (const [sku, q] of shipped) {
    const ol = orderLines.find((l) => l.po_number === po && String(l.sku_code).toUpperCase() === sku);
    if (ol && q > N(ol.ordered_qty)) over.push(`${sku} ${q}>${ol.ordered_qty}`);
  }
  if (over.length) console.log(`     !! lot-2 qty exceeds ordered on ${over.length} SKU(s): ${over.slice(0, 10).join(', ')}`);

  // CI rate vs PO line price — the CI wins, but surface the gap
  const priced = new Map();
  for (const [sku] of shipped) {
    const ol = orderLines.find((l) => l.po_number === po && String(l.sku_code).toUpperCase() === sku);
    const row = rows.find((r) => r[2] === sku);
    if (ol && row && N(row[11]) !== N(ol.unit_price)) priced.set(sku, `${N(row[11])} vs PO ${N(ol.unit_price)}`);
  }
  if (priced.size) console.log(`     ~  CI rate ≠ PO line price on ${priced.size}/${shipped.size} SKUs (CI used) e.g. ${[...priced.entries()].slice(0, 3).map(([s, v]) => `${s} ${v}`).join(', ')}`);
}
