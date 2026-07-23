'use strict';

// Convert PRATIBHA SYNTEX LIMITED (India) commercial-invoice + packing-list PDFs
// in `data/converted docs/` into the flat shipment-data template (single sheet
// "Shipment Data") consumed by services/ciParser.parseShipmentData — the same
// upload the SMS packing route (POST /sms/shipments/:id/shipping-data) ingests.
// One output per PO: PO<num>-shipment-data.xlsx (three FedEx consignments:
// HO -> PO04820, NRI CA -> PO04821, NRI US -> PO04822).
//
// The Pratibha docs are PDFs (no machine-readable workbook) and carry NO size
// and NO UPC — the CI/PL are keyed on STYLE + SHADE (colour name) only. So the
// line facts below are transcribed from the source PDFs, and the SKU + style
// description are resolved from product_skus.json at run-time:
//   SKU = style_color (style-colourcode, e.g. "Slate Moss Heather" -> ZCM5552-6933);
//         this uniquely identifies each CI line even though size is unknown.
//   Style Description = catalogue item_name, minus the gender prefix + "(colour)".
// UPC is left blank (absent from source). Each PO = a single carton; N/W, G/W &
// MEASURE sit on the carton's first row (the layout parseShipmentData expects).
//
// Source data-quality notes (handled here):
//  • PO04822 CI prints every ZCW line as "Meteorite Black" — wrong (the catalogue
//    has no Meteorite Black for ZCW5563/ZCW7015). The PL colours (Willow Ash /
//    Steel Bay) match the catalogue, so PL colours are used.
//  • PO04821 PL gross weight (3.8) disagrees with the CI (3.08) and the PL has no
//    net weight — the CI weights are authoritative and used throughout.

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const DIR = path.join(__dirname, '..', 'data', 'converted docs');
const SKUS = require(path.join(__dirname, '..', 'data', 'migrated', 'product_skus.json'));

const TEMPLATE_HEADER = [
  'CTN#', 'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
  'Category', 'Gender', 'Composition', 'HTS Code', 'Unit Price USD', 'Total USD',
  'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
];

const r2 = (n) => +n.toFixed(2);
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// Compositions as printed on the CI / PL (fabric content), normalised spacing.
const COTTON_TENCEL = '58% Organic Cotton 39% Tencel 3% Elastane';
const COTTON_ELASTANE = '92% Organic Cotton 8% Elastane';

// ── Per-PO shipment envelope (single carton each; weights & dims from the CI) ──
const SHIPMENTS = {
  PO04820: { nw: 10, gw: 10.86, measure: '60X40X30', ciTotal: 439.87 },
  PO04821: { nw: 2.94, gw: 3.08, measure: '45X30X15', ciTotal: 167.44 },
  PO04822: { nw: 7.2, gw: 7.3, measure: '50X35X20', ciTotal: 273.09 },
};

// ── Carton lines transcribed from each CI + PL (colour = PL colourway) ─────────
// { po, style, color, qty, price, hts, composition, gender, category }
const LINES = [
  // PO04820 — TENTREE HEAD OFFICE
  ['PO04820', 'ZCM5552', 'Dark Grey Heather', 15, 14.99, '61091000', COTTON_TENCEL, 'Men', 'Henley'],
  ['PO04820', 'ZCM5552', 'Slate Moss Heather', 2, 14.99, '61091000', COTTON_TENCEL, 'Men', 'Henley'],
  ['PO04820', 'ZCM5552', 'Steel Bay Heather', 2, 14.99, '61091000', COTTON_TENCEL, 'Men', 'Henley'],
  ['PO04820', 'ZCW7015', 'Willow Ash Heather', 2, 12.23, '61091000', COTTON_TENCEL, 'Women', 'Tshirt'],
  ['PO04820', 'ZCW7015', 'Steel Bay Heather', 2, 12.23, '61091000', COTTON_TENCEL, 'Women', 'Tshirt'],
  ['PO04820', 'ZCW5563', 'Willow Ash Heather', 2, 14.64, '61091000', COTTON_TENCEL, 'Women', 'Top'],
  ['PO04820', 'ZCW5563', 'Slate Moss Heather', 2, 14.64, '61091000', COTTON_TENCEL, 'Women', 'Top'],
  ['PO04820', 'ZCW5563', 'Steel Bay Heather', 2, 14.64, '61091000', COTTON_TENCEL, 'Women', 'Top'],
  ['PO04820', 'ZCW6453', 'Meteorite Black', 2, 9.15, '61151000', COTTON_ELASTANE, 'Women', 'Leggings'],

  // PO04821 — NRI CA WAREHOUSE (KAMLOOPS)
  ['PO04821', 'ZCM5552', 'Slate Moss Heather', 4, 14.99, '61091000', COTTON_TENCEL, 'Men', 'Henley'],
  ['PO04821', 'ZCW5563', 'Steel Bay Heather', 4, 14.64, '61091000', COTTON_TENCEL, 'Women', 'Top'],
  ['PO04821', 'ZCW7015', 'Willow Ash Heather', 4, 12.23, '61091000', COTTON_TENCEL, 'Women', 'Top'],

  // PO04822 — NRI US WAREHOUSE (colours from PL; CI colours are erroneous)
  ['PO04822', 'ZCM5552', 'Slate Moss Heather', 7, 14.99, '61091000', COTTON_TENCEL, 'Men', 'Henley'],
  ['PO04822', 'ZCW5563', 'Willow Ash Heather', 1, 14.64, '61046990', COTTON_TENCEL, 'Women', 'Top'],
  ['PO04822', 'ZCW5563', 'Steel Bay Heather', 7, 14.64, '61046990', COTTON_TENCEL, 'Women', 'Top'],
  ['PO04822', 'ZCW7015', 'Willow Ash Heather', 7, 6.38, '61046990', COTTON_TENCEL, 'Women', 'Top'],
  ['PO04822', 'ZCW7015', 'Steel Bay Heather', 1, 6.38, '61046990', COTTON_TENCEL, 'Women', 'Top'],
].map(([po, style, color, qty, price, hts, composition, gender, category]) =>
  ({ po, style, color, qty, price, hts, composition, gender, category }));

// ── Resolve style + colour name -> { style_color, description } from the catalogue.
// The catalogue embeds the colour name in item_name, e.g.
//   "M Freemont Henley (Dark Grey Heather)" @ style_color ZCM5552-0812.
function buildResolver() {
  const byStyle = new Map();          // style -> [{ style_color, item_name }]
  for (const s of SKUS) {
    const sc = s.style_color || (s.sku_code || '').split('-').slice(0, 2).join('-');
    const style = (sc || '').split('-')[0];
    if (!style) continue;
    if (!byStyle.has(style)) byStyle.set(style, []);
    byStyle.get(style).push({ style_color: sc, item_name: s.item_name || s.description || '' });
  }
  return (style, color) => {
    const cands = byStyle.get(style) || [];
    const hit = cands.find((c) => {
      const m = /\(([^)]+)\)\s*$/.exec(c.item_name);
      return m && norm(m[1]) === norm(color);
    });
    if (!hit) return { style_color: style, description: '', matched: false };
    // strip leading gender letter ("M "/"W "/"U ") and the trailing "(colour)"
    const description = hit.item_name.replace(/\s*\([^)]*\)\s*$/, '').replace(/^[MWU]\s+/, '').trim();
    return { style_color: hit.style_color, description, matched: true };
  };
}

const resolve = buildResolver();

for (const [po, lines] of Object.entries(
  LINES.reduce((acc, l) => { (acc[l.po] ||= []).push(l); return acc; }, {})
)) {
  const env = SHIPMENTS[po];
  const aoa = [TEMPLATE_HEADER];
  const unmatched = [];
  let totalPcs = 0, totalVal = 0;

  lines.forEach((l, i) => {
    const { style_color, description, matched } = resolve(l.style, l.color);
    if (!matched) unmatched.push(`${l.style} / ${l.color}`);
    totalPcs += l.qty;
    totalVal += l.price * l.qty;
    aoa.push([
      1, po, style_color, '', 'Knit', description, l.color,
      l.category, l.gender, l.composition, l.hts,
      l.price, r2(l.price * l.qty), l.qty,
      // single carton: weights & measure on the first row only
      i === 0 ? env.nw : '', i === 0 ? env.gw : '', i === 0 ? env.measure : '',
    ]);
  });

  const out = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(out, xlsx.utils.aoa_to_sheet(aoa), 'Shipment Data');
  const outName = `${po}-shipment-data.xlsx`;
  xlsx.writeFile(out, path.join(DIR, outName));

  const diff = r2(totalVal - env.ciTotal);
  console.log(`\n${po}`);
  console.log(`  -> ${outName}`);
  console.log(`     ${lines.length} SKU rows | 1 carton | ${totalPcs} pcs | $${r2(totalVal)} (CI $${env.ciTotal.toFixed(2)}, Δ ${diff}) | N/W ${env.nw}kg | G/W ${env.gw}kg`);
  if (unmatched.length) console.log(`     !! UNMATCHED style/colour in catalogue: ${[...new Set(unmatched)].join(', ')}`);
}
