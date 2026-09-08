'use strict';

// Convert the EASTERN WARMTH "TT-372" / "TT-373" CI & PL workbooks in
// `data/converted docs/Mainline/` into the flat shipment-data template (single
// sheet "Shipment Data") consumed by services/ciParser.parseShipmentData.
//
//   TT-372 … PO04746 45 Ctns.xlsx  -> PO04746-shipment-data.xlsx
//   TT-373 … PO04728 37 Ctns.xlsx  -> PO04728-shipment-data-lot2.xlsx
//
// Both workbooks hold two sheets: the commercial invoice and the packing list.
// The PACKING LIST is the spine (it owns the carton assignment); the CI supplies
// price + descriptive attributes, joined on SKU.
//
// ── Why columns are detected by HEADER TEXT, not fixed index ──────────────────
// The two invoices are NOT the same shape: TT-372's Inv carries a UPC column
// (PO#|SKU|UPC|Knit/Woven|…) and TT-373's does not (PO#|SKU|Knit/Woven|…), so every
// column after position 1 shifts by one between them. Hard-coding indices — as the
// older per-vendor converters do — would silently read Style Description as UPC for
// one of the two. Both packing lists happen to share a layout
// (CTN #|PO #|SKU|UPC|Style|Color|PCS/CTN|N/W|G/W|MEASURE), but they are detected
// the same way so a future sibling workbook cannot quietly misalign.
//
// ── Carton facts ─────────────────────────────────────────────────────────────
// CTN# / N/W / G/W / MEASURE appear on a carton's FIRST row only; subsequent SKUs
// in the same carton have them blank. CTN# is forward-filled; the weights/measure
// are emitted ONLY on the first row, because parseShipmentData sums them once per
// distinct ctn_number (writing them on every row would multiply a carton's weight
// by its SKU count).
//
// Both sheets carry repeated header rows and a trailing totals / BOX SIZE block;
// the SKU-shape guard skips them and the totals row ends the walk.
//
// ── CI value is AUTHORITATIVE; the PL owns the physical facts ────────────────
// TT-372's two documents disagree: the CI invoices 561 pcs of M Mountain Portal
// ($5.45) + 490 of M Vintage Mountain Patch ($5.70), while the PL ships 633 and 418
// of them. Same 2,320 pcs overall, but 72 pieces carry a different style label — and
// at a $0.25 price gap that is exactly the $18.00 by which naive PL × CI-unit-price
// falls short of the invoice's own $12,704.30 total.
//
// PO04746's correct amount is $12,704.30 (confirmed by Lam). The reconciliation
// keeps BOTH documents whole where each is authoritative:
//   • the CI owns MONEY   -> each style-colour's invoiced VALUE is reproduced exactly
//   • the PL owns GOODS   -> carton assignment, pcs, weights and measure are untouched
// So a style's effective unit price = its CI value / the pcs the PL actually shipped
// for it. Undisputed styles are unaffected (value/qty agree, so the effective price
// IS the invoiced price); only the two styles the vendor mis-split get a blended
// rate, which is the real invoiced value per piece shipped. Cents are settled by
// largest-remainder per style so every style total, and therefore the grand total,
// lands on the invoice to the cent.
//
// This is the only reconciliation that hits $12,704.30 without corrupting something:
// rewriting quantities to the CI would break the carton/weight correspondence AND
// move further from PO04746's ordered lines (the PL is closer on 9 of 10 disputed
// lines, exact on TCM6768-6621-S), and scaling every price would distort the two
// styles the vendor got right. TT-373 has no disagreement, so this is a no-op there.
//
// ── TWO packing-list blocks per sheet, and why they are RENUMBERED ────────────
// TT-372's PL sheet holds two blocks: the main run (cartons 1-41) and a second
// "odd cartons" run that RESTARTS its numbering at 1-4 for the mixed leftovers.
// 41 + 4 = the 45 cartons on the tin, and each block's own totals row reconciles.
// Taken literally the two blocks collide on ctn 1-4, which would MERGE four pairs
// of physically distinct cartons — 45 cartons would land as 41, and each merged
// carton's weights would be summed across two real boxes. So a restart is detected
// (a first-of-carton number that does not advance) and everything after it is
// offset past the running maximum: the odd cartons become 42-45. TT-373 is a single
// monotonic block, so the offset stays 0 and it is untouched.
//
//   node scripts/convertTT372_373ToShipmentData.js [--dry-run]

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const DIR = path.join(__dirname, '..', 'data', 'converted docs', 'Mainline');
const SKU_CODES = new Set(require(path.join(__dirname, '..', 'data', 'migrated', 'product_skus.json')).map((s) => s.sku_code));
const dryRun = process.argv.includes('--dry-run');

const TEMPLATE_HEADER = [
  'CTN#', 'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
  'Category', 'Gender', 'Composition', 'HTS Code', 'Unit Price USD', 'Total USD',
  'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
];

const JOBS = [
  { src: 'TT-372 Vancouver Canada CI & PL PO04746 45 Ctns.xlsx', po: 'PO04746', out: 'PO04746-shipment-data.xlsx', expectCtns: 45 },
  { src: 'TT-373 Vancouver Canada CI & PL PO04728 37 Ctns.xlsx', po: 'PO04728', out: 'PO04728-shipment-data-lot2.xlsx', expectCtns: 37 },
];

const S = (v) => String(v ?? '').trim();
const N = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const r2 = (n) => +n.toFixed(2);
// Real SKUs look like TCM6768-6622-L. Excludes the literal word "SKU" from the
// repeated header rows and anything in the totals / BOX SIZE block.
const isSku = (s) => /^[A-Z]{2,4}\d{3,}-\d+/i.test(S(s));
// Style-colour code = the SKU without its trailing size (TCM6949-6435-L -> TCM6949
// -6435). This is the grain the invoice actually prices at, and it is keyed on the
// CODE rather than the style/colour TEXT because this vendor's descriptions drift
// between sheets (see convertEasternWarmthLot2ToShipmentData.js).
const styleKey = (sku) => S(sku).toUpperCase().replace(/-[A-Z0-9]+$/, '');

// Largest-remainder split of `total` across `weights`, exact to the cent.
function splitToCents(total, weights) {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (!sum) return weights.map(() => 0);
  const cents = Math.round(total * 100);
  const exact = weights.map((w) => (cents * w) / sum);
  const floor = exact.map(Math.floor);
  let rem = cents - floor.reduce((a, x) => a + x, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac);
  const out = floor.slice();
  for (let k = 0; k < order.length && rem > 0; k++, rem--) out[order[k].i] += 1;
  return out.map((c) => c / 100);
}
const normMeasure = (m) => S(m).replace(/cm$/i, '').replace(/\s+/g, '').replace(/[*×xX]/g, 'X').toUpperCase();
const composition = (c) => S(c).replace(/\s*,\s*/g, ', ').replace(/%(?=\S)/g, '% ').replace(/\s+/g, ' ').trim();

// Find the header row + map the columns we need by their caption.
function mapHeader(rows, wanted) {
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const cells = rows[i].map((c) => S(c).toLowerCase());
    const map = {};
    for (const [key, pat] of Object.entries(wanted)) {
      const col = cells.findIndex((c) => c && pat.test(c));
      if (col >= 0) map[key] = col;
    }
    // a real header row resolves the identifying columns
    if (map.sku !== undefined && map.po !== undefined) return { row: i, map };
  }
  throw new Error('header row not found');
}

const CI_COLS = {
  po: /^po\s*#?$/, sku: /^sku$/, upc: /^upc$/, knit: /knit/, style: /style/, color: /colou?r\s*desc/,
  cat: /^category$/, gender: /^gender$/, comp: /composition/, hts: /^hts/, qty: /^quantity$/,
  unit: /^unit\s*price/, total: /^total\s*usd$/,
};
const PL_COLS = {
  ctn: /^ctn/, po: /^po\s*#?$/, sku: /^sku$/, upc: /^upc$/, style: /style/, color: /colou?r/,
  pcs: /^pcs/, nw: /^n\/w$/, gw: /^g\/w$/, measure: /^measure$/,
};

let exit = 0;
for (const job of JOBS) {
  const wb = xlsx.read(fs.readFileSync(path.join(DIR, job.src)), { type: 'buffer', cellDates: true });
  const grid = (name) => xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });

  // the PL sheet is the one with a CTN column; the other is the invoice
  const plName = wb.SheetNames.find((n) => grid(n).slice(0, 40).some((r) => r.some((c) => /^ctn/i.test(S(c)))));
  const invName = wb.SheetNames.find((n) => n !== plName);
  if (!plName || !invName) throw new Error(`cannot identify sheets in ${job.src}: ${wb.SheetNames.join(' | ')}`);

  // ── CI: SKU -> price + descriptive attrs ───────────────────────────────────
  const inv = grid(invName);
  const { row: ciHdr, map: C } = mapHeader(inv, CI_COLS);
  const ci = {};
  let ciQty = 0, ciTotal = 0;
  for (let i = ciHdr + 1; i < inv.length; i++) {
    const r = inv[i];
    const sku = S(r[C.sku]).toUpperCase();
    if (!isSku(sku)) continue;
    const qty = N(r[C.qty]);
    const total = N(r[C.total]);
    ciQty += qty; ciTotal += total;
    // A SKU spans SEVERAL CI rows here (one per carton run), so qty/total are
    // ACCUMULATED and the unit price is the aggregate total/qty — not the first
    // row's. Taking the first row would under-report the CI quantity by ~4x and
    // make any CI-vs-PL comparison meaningless. Descriptive attributes are stable
    // across a SKU's rows, so those come from whichever row is seen first.
    const prev = ci[sku];
    ci[sku] = {
      qty: (prev ? prev.qty : 0) + qty,
      total: (prev ? prev.total : 0) + total,
      unitRow: qty > 0 ? total / qty : N(r[C.unit]),      // fallback if the aggregate is 0
      upc: prev ? prev.upc : (C.upc !== undefined ? S(r[C.upc]) : ''),
      knit: prev ? prev.knit : S(r[C.knit]),
      style: prev ? prev.style : S(r[C.style]),
      color: prev ? prev.color : S(r[C.color]),
      category: prev ? prev.category : S(r[C.cat]),
      gender: prev ? prev.gender : S(r[C.gender]),
      composition: prev ? prev.composition : composition(r[C.comp]),
      hts: prev ? prev.hts : S(r[C.hts]),
    };
  }
  for (const v of Object.values(ci)) v.unit = v.qty > 0 ? v.total / v.qty : v.unitRow;

  // CI value per style-colour — the figure the invoice actually stands behind.
  const ciStyle = {};
  for (const [sku, v] of Object.entries(ci)) {
    const k = styleKey(sku);
    ciStyle[k] = ciStyle[k] || { qty: 0, total: 0 };
    ciStyle[k].qty += v.qty; ciStyle[k].total += v.total;
  }

  // ── PL is the spine: one output row per (carton × SKU) ─────────────────────
  const pl = grid(plName);
  const { row: plHdr, map: P } = mapHeader(pl, PL_COLS);
  const aoa = [TEMPLATE_HEADER];
  const cartons = new Set();
  const notPriced = new Set();
  const notInCatalogue = new Set();
  let curCtn = 0, pcsTotal = 0, valTotal = 0, nwTotal = 0, gwTotal = 0;
  // Restart detection — see the "TWO packing-list blocks" note above.
  let lastRaw = 0, maxOut = 0, offset = 0, restarts = 0;

  // PASS 1 — collect the physical rows. Money is deferred: a style's effective unit
  // price cannot be known until its TOTAL shipped pieces are, so pricing needs the
  // whole packing list in hand first.
  const recs = [];
  for (let i = plHdr + 1; i < pl.length; i++) {
    const r = pl[i];
    const sku = S(r[P.sku]).toUpperCase();
    if (!isSku(sku)) continue;                          // header repeats, totals, BOX SIZE block
    if (!SKU_CODES.has(sku)) notInCatalogue.add(sku);
    if (!ci[sku]) notPriced.add(sku);

    const ctnCell = N(r[P.ctn]);
    const firstOfCarton = ctnCell > 0;
    if (firstOfCarton) {
      if (ctnCell <= lastRaw) { offset = maxOut; restarts++; }   // a new block began
      lastRaw = ctnCell;
      curCtn = ctnCell + offset;
      maxOut = Math.max(maxOut, curCtn);
    }
    cartons.add(curCtn);

    const pcs = N(r[P.pcs]);
    pcsTotal += pcs;
    if (firstOfCarton) { nwTotal += N(r[P.nw]); gwTotal += N(r[P.gw]); }

    recs.push({
      ctn: curCtn, sku, pcs, firstOfCarton,
      upc: (P.upc !== undefined ? S(r[P.upc]) : ''),
      style: S(r[P.style]), color: S(r[P.color]),
      nw: firstOfCarton ? N(r[P.nw]) || '' : '',
      gw: firstOfCarton ? N(r[P.gw]) || '' : '',
      measure: firstOfCarton ? normMeasure(r[P.measure]) : '',
    });
  }

  // PASS 2 — price each style-colour so its INVOICED value is reproduced exactly
  // over the pieces the packing list actually shipped. See the "CI value is
  // AUTHORITATIVE" note. Where the two documents agree (the normal case, and every
  // style in TT-373) the effective price IS the invoiced price.
  const plStylePcs = {};
  recs.forEach((x) => { const k = styleKey(x.sku); plStylePcs[k] = (plStylePcs[k] || 0) + x.pcs; });

  const effUnit = {};       // style-colour -> effective unit price
  const reprice = [];       // styles whose effective price differs from the invoiced one
  const rowTotal = new Map();
  for (const k of Object.keys(plStylePcs)) {
    const rows = recs.filter((x) => styleKey(x.sku) === k);
    const shipped = plStylePcs[k];
    const invoiced = ciStyle[k];
    if (!invoiced || !invoiced.total || !shipped) {
      rows.forEach((x) => rowTotal.set(x, r2((ci[x.sku] ? ci[x.sku].unit : 0) * x.pcs)));
      effUnit[k] = ci[rows[0].sku] ? ci[rows[0].sku].unit : 0;
      continue;
    }
    effUnit[k] = invoiced.total / shipped;
    const parts = splitToCents(invoiced.total, rows.map((x) => x.pcs));
    rows.forEach((x, i) => rowTotal.set(x, parts[i]));
    const invoicedUnit = invoiced.qty > 0 ? invoiced.total / invoiced.qty : effUnit[k];
    if (Math.abs(effUnit[k] - invoicedUnit) > 0.0001) {
      reprice.push({ k, shipped, ciQty: invoiced.qty, value: invoiced.total, from: invoicedUnit, to: effUnit[k] });
    }
  }

  for (const x of recs) {
    const attrs = ci[x.sku] || {};
    const total = rowTotal.get(x) || 0;
    valTotal += total;
    aoa.push([
      x.ctn, job.po, x.sku,
      x.upc || attrs.upc || '',
      attrs.knit || '',
      x.style || attrs.style || '',
      x.color || attrs.color || '',
      attrs.category || '', attrs.gender || '',
      attrs.composition || '', attrs.hts || '',
      +effUnit[styleKey(x.sku)].toFixed(4), total, x.pcs,
      x.nw, x.gw, x.measure,
    ]);
  }
  valTotal = r2(valTotal);

  console.log(`\n${job.src}`);
  console.log(`  sheets: CI "${invName}" (hdr ${ciHdr}) | PL "${plName}" (hdr ${plHdr})`);
  console.log(`  CI: ${Object.keys(ci).length} SKUs | ${ciQty} pcs | $${r2(ciTotal)}`);
  console.log(`  -> ${job.out}`);
  console.log(`     ${aoa.length - 1} SKU rows | ${cartons.size} cartons | ${pcsTotal} pcs | $${r2(valTotal)}`);
  console.log(`     N/W ${r2(nwTotal)} kg | G/W ${r2(gwTotal)} kg`);
  if (restarts) console.log(`     ${restarts} packing-list block restart(s) renumbered — odd cartons continue past the main run`);

  // Styles where the invoice and packing list disagreed on quantity, so the style's
  // invoiced value had to be spread over a different piece count. Always printed —
  // a silent reprice is exactly the kind of thing that must not be invisible later.
  reprice.forEach((x) => console.log(
    `     REPRICED ${x.k}: invoice ${x.ciQty} pcs, packing list ${x.shipped} pcs `
    + `-> $${r2(x.value)} spread at $${x.to.toFixed(4)}/pc (invoiced $${x.from.toFixed(4)})`));

  // Hard problems = the conversion is wrong. These fail the run.
  const problems = [];
  if (cartons.size !== job.expectCtns) problems.push(`carton count ${cartons.size} != ${job.expectCtns} from the filename`);
  if (ciQty && pcsTotal !== ciQty) problems.push(`pcs ${pcsTotal} != CI ${ciQty}`);
  if (ciTotal && Math.abs(valTotal - ciTotal) > 0.005) problems.push(`value $${r2(valTotal)} != invoice $${r2(ciTotal)}`);
  if (notInCatalogue.size) problems.push(`not in product_skus: ${[...notInCatalogue].join(', ')}`);
  if (notPriced.size) problems.push(`no CI price (priced $0): ${[...notPriced].join(', ')}`);
  problems.forEach((p) => console.log(`     !! ${p}`));
  if (problems.length) exit = 1;
  else console.log(`     reconciles to the invoice: $${r2(valTotal)} over ${pcsTotal} pcs in ${cartons.size} cartons`);

  if (!dryRun) {
    const book = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet(aoa), 'Shipment Data');
    xlsx.writeFile(book, path.join(DIR, job.out));
    console.log('     written');
  } else {
    console.log('     --dry-run: nothing written');
  }
}
process.exit(exit);
