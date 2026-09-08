'use strict';

// Convert PT. TASINDO TASSA INDUSTRIES' SECOND FW27 SMS round (invoices TENT/017–019)
// into the flat shipment-data template (single sheet "Shipment Data") consumed by
// services/ciParser.parseShipmentData — the upload behind
// POST /sms/shipments/:id/shipping-data. One output per consignment.
//
//   sheet "018 (CA) FEDEX"  + PL TENT 018 2026 CA.pdf  -> PO04812 lot 2  (12 pcs, 1 ctn)
//   sheet "019 (USA) FEDEX" + PL TENT 019 2026 US.pdf  -> PO04813 lot 2  (22 pcs, 1 ctn)
//
// Sheet "017 HO (FEDEX)" is the third of the round but is NOT converted — its packing
// list PDF isn't in `data/converted docs/SMS/` yet. Add its row to CONSIGNMENTS with the
// carton envelope off the PDF and it will build with the rest.
//
// Sources:
//  • `TENTREE INV FW27 SMS.xlsx` — the commercial invoices, one sheet per consignment.
//    Line-level source of truth. Same layout as the 014/015/016 sheets of round 1, so
//    the column map is shared with convertTasindoToShipmentData.js:
//    SKU(2) Style(3) Colour(4) PO(5) Qty(6) Price(8) Amount(9). Parsing stops at the
//    "T O T A L" row (rows below it are stale leftovers).
//  • `PL TENT 0xx 2026 *.pdf` — the packing lists. Each consignment is a SINGLE carton
//    and the CI carries no weights, so the carton envelope (N/W · G/W · box) is
//    transcribed into CONSIGNMENTS below, exactly as round 1 did.
//
// Both POs are on their SECOND consignment; round 1 (sheets 015/016, shipments 12/14)
// shipped a different set of bags. The lot-2 shipments already exist in the portal
// (13 = FedEx 875133888196 / NRI CA, 15 = FedEx 875134251578 / NRI US, both shipped
// 2026-08-07) and their sms_shipment_pos junctions already declare the unit and carton
// counts these files produce — the run asserts against them.
//
// SKU rule (unchanged): the CI carries the style-colour (ZAU6554-6898) while the
// catalogue and sms_po_lines carry the one-size "-ONE" variant, so "-ONE" is appended
// when it resolves a real product_skus row. Unit price = the commercial-invoice price.
// HTS is read per sheet from the remarks block — the USA consignment declares
// 4202219000 (handbags), the CA one declares none.

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const DIR = path.join(__dirname, '..', 'data', 'converted docs', 'SMS');
const MIGRATED = path.join(__dirname, '..', 'data', 'migrated');
const CI_FILE = 'TENTREE INV FW27 SMS.xlsx';

// carton envelopes transcribed from the PL PDFs (one carton each, box 55x40x53)
const CONSIGNMENTS = [
  { sheet: '018 (CA) FEDEX', po: 'PO04812', lot: 2, pl: 'PL TENT 018 2026 CA.pdf', carton: { nw: 3.60, gw: 5.00, measure: '55X40X53', pcs: 12, cbm: 0.117 } },
  { sheet: '019 (USA) FEDEX', po: 'PO04813', lot: 2, pl: 'PL TENT 019 2026 US.pdf', carton: { nw: 6.60, gw: 8.00, measure: '55X40X53', pcs: 22, cbm: 0.117 } },
];

const TEMPLATE_HEADER = [
  'CTN#', 'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
  'Category', 'Gender', 'Composition', 'HTS Code', 'Unit Price USD', 'Total USD',
  'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
];

const S = (v) => String(v ?? '').trim();
const N = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const r2 = (n) => +Number(n).toFixed(2);
const cbmOf = (m) => { const p = S(m).split('X').map(Number); return p.length === 3 && p.every(isFinite) ? p[0] * p[1] * p[2] / 1e6 : 0; };
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(MIGRATED, f), 'utf8').replace(/^﻿/, ''));

const skuMaster = new Map(readJson('product_skus.json').map((s) => [String(s.sku_code).toUpperCase(), s]));
const poLines = readJson('sms_po_lines.json');
const shipmentPos = readJson('sms_shipment_pos.json');
const packingCartons = readJson('sms_packing_cartons.json');

// CI style-colour -> catalogue SKU (prefer the "-ONE" one-size variant)
const resolveSku = (styleColor) => {
  const sc = styleColor.toUpperCase();
  if (skuMaster.has(`${sc}-ONE`)) return `${sc}-ONE`;
  if (skuMaster.has(sc)) return sc;
  return `${sc}-ONE`;              // best guess; flagged below
};

const wb = xlsx.read(fs.readFileSync(path.join(DIR, CI_FILE)), { type: 'buffer', cellDates: true });
const C = { sku: 2, style: 3, color: 4, po: 5, qty: 6, price: 8, amount: 9 };

for (const { sheet, po, lot, pl, carton } of CONSIGNMENTS) {
  if (!wb.Sheets[sheet]) { console.log(`\n!! sheet "${sheet}" not found — skipped. Sheets: ${wb.SheetNames.join(' | ')}`); continue; }
  const grid = xlsx.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '' });

  // sheet-level HTS from the remarks block (USA consignments only)
  const htsHit = grid.flat().map((c) => /HTS\s*CODE\s*:?\s*(\d{6,10})/i.exec(S(c))).find(Boolean);
  const sheetHts = htsHit ? htsHit[1] : '';

  const lines = [];
  const strayPo = new Set();
  let stated = null;
  for (const row of grid) {
    const styleColor = S(row[C.sku]);
    if (/^total$/i.test(styleColor.replace(/\s/g, ''))) {          // the invoice's own total row
      stated = { qty: N(row[C.qty]), value: r2(N(row[C.amount])) };
      break;
    }
    if (!/^Z[A-Z]{2}\d/i.test(styleColor)) continue;
    const rowPo = S(row[C.po]).toUpperCase();
    if (!/^PO\d+/.test(rowPo)) continue;
    if (rowPo !== po) { strayPo.add(rowPo); continue; }
    lines.push({
      sku: resolveSku(styleColor), style: S(row[C.style]), color: S(row[C.color]),
      qty: N(row[C.qty]), price: N(row[C.price]), amount: N(row[C.amount]),
    });
  }
  if (!lines.length) { console.log(`\n!! no ${po} item lines in sheet "${sheet}" — skipped`); continue; }

  // ── build (single carton → weights/measure on the first row only) ──────────
  const aoa = [TEMPLATE_HEADER];
  const notInCatalogue = [], notOnPo = [], priceDrift = [], amountDrift = [], qtyOver = [];
  let pcs = 0, value = 0;

  lines.forEach((l, i) => {
    const master = skuMaster.get(l.sku) || {};
    if (!skuMaster.has(l.sku)) notInCatalogue.push(l.sku);
    const ol = poLines.find((p) => p.po_number === po && String(p.sku_code).toUpperCase() === l.sku);
    if (!ol) notOnPo.push(l.sku);
    else {
      if (N(ol.unit_price) !== l.price) priceDrift.push(`${l.sku} CI ${l.price} vs PO ${ol.unit_price}`);
      if (l.qty > N(ol.ordered_qty)) qtyOver.push(`${l.sku} ${l.qty}>${ol.ordered_qty}`);
    }
    if (l.amount && r2(l.price * l.qty) !== r2(l.amount)) amountDrift.push(`${l.sku} ${r2(l.price * l.qty)} vs CI ${r2(l.amount)}`);

    pcs += l.qty;
    value += l.price * l.qty;
    aoa.push([
      1, po, l.sku, master.upc || '',
      master.knit_woven || '', l.style, l.color,
      master.category || '', master.gender || '', master.composition || '',
      sheetHts || master.hts_code || '',
      l.price, r2(l.price * l.qty), l.qty,
      i === 0 ? carton.nw : '', i === 0 ? carton.gw : '', i === 0 ? carton.measure : '',
    ]);
  });
  value = r2(value);

  const out = `${po}-shipment-data-lot${lot}.xlsx`;
  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet(aoa), 'Shipment Data');
  xlsx.writeFile(book, path.join(DIR, out));

  // ── reconciliation ─────────────────────────────────────────────────────────
  console.log(`\nsheet "${sheet}"  +  ${pl}`);
  console.log(`  -> converted docs/SMS/${out}`);
  console.log(`     ${po} lot ${lot} | ${lines.length} SKU rows | 1 carton | ${pcs} pcs | $${value.toLocaleString()}${sheetHts ? ` | HTS ${sheetHts}` : ' | no HTS (CA)'}`);
  console.log(`     N/W ${carton.nw} kg | G/W ${carton.gw} kg | ${carton.measure} = ${cbmOf(carton.measure).toFixed(3)} CBM`);
  if (stated) console.log(`     CI total row: ${stated.qty} pcs | $${stated.value.toLocaleString()}  ->  Δ pcs ${pcs - stated.qty}, Δ value ${r2(value - stated.value)}`);
  console.log(`     PL PDF: ${carton.pcs} pcs / 1 ctn / ${carton.cbm} CBM  ->  Δ pcs ${pcs - carton.pcs}, Δ CBM ${r2(cbmOf(carton.measure) - carton.cbm)}`);

  const junction = shipmentPos.find((j) => j.po_number === po && j.lot_number === lot);
  if (junction) {
    console.log(`     junction (shipment ${junction.shipment_id}, lot ${junction.lot_number}): ${junction.units} units / ${junction.cartons} ctn`
      + `  ->  Δ units ${pcs - N(junction.units)}, Δ cartons ${1 - N(junction.cartons)}`);
  } else {
    console.log(`     !! no sms_shipment_pos row for ${po} lot ${lot} — create the shipment before uploading`);
  }

  if (strayPo.size) console.log(`     !! sheet also carries other POs (skipped): ${[...strayPo].join(', ')}`);
  if (notInCatalogue.length) console.log(`     !! not in product_skus: ${notInCatalogue.join(', ')}`);
  if (notOnPo.length) console.log(`     !! not on ${po} sms_po_lines: ${notOnPo.join(', ')}`);
  if (qtyOver.length) console.log(`     !! qty exceeds ordered: ${qtyOver.join(', ')}`);
  if (priceDrift.length) console.log(`     ~  CI price ≠ PO line price (CI used): ${priceDrift.join(', ')}`);
  if (amountDrift.length) console.log(`     !! qty × price ≠ CI amount: ${amountDrift.join(', ')}`);

  // what's left on the PO once this lot ships
  const shipped = new Set(lines.map((l) => l.sku));
  packingCartons.filter((c) => c.po_number === po).forEach((c) => shipped.add(String(c.sku_code).toUpperCase()));
  const outstanding = poLines.filter((l) => l.po_number === po && !shipped.has(String(l.sku_code).toUpperCase()));
  if (outstanding.length) {
    const units = outstanding.reduce((s, l) => s + N(l.ordered_qty), 0);
    console.log(`     ${po} still unshipped after lot ${lot}: ${units} pcs — ${outstanding.map((l) => `${l.sku_code} (${l.ordered_qty})`).join(', ')}`);
  }
}
