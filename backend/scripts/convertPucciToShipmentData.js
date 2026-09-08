'use strict';

// Convert SHANGHAI PUCCI TEXTILE CO., LTD (China) FW27 SMS air documents in
// `data/converted docs/SMS/` into the flat shipment-data template (single sheet
// "Shipment Data", carton-level rows) consumed by
// services/ciParser.parseShipmentData — the same upload the SMS packing route
// (POST /sms/shipments/:id/shipping-data) ingests. One output per PO:
// PO<num>-shipment-data.xlsx.
//
// Sources (three air consignments, one workbook each, two sheets "Invoice" +
// "Packing List"):
//   • PT04817-TENTREE BY AIR.xlsx  -> PO04817
//   • PT04818-NRI CA BY AIR.xlsx   -> PO04818
//   • PT04819-NRI US BY AIR.xlsx   -> PO04819
//
// Layout (standard tentree CI template, but Pucci carries UPC in BOTH sheets so
// the column offsets differ from the generic convertToShipmentData.js):
//   Invoice item table (header "PO#" | "SKU" | "UPC" | …):
//     PO#(0) SKU(1) UPC(2) Knit/Woven(3) StyleDesc(4) ColorDesc(5) Category(6)
//     Gender(7) Composition(8) HTS(9) Qty(10) UnitPrice(11) Total(12)
//   Packing List carton table (header "CTN #" | "PO #" | "SKU#" | …):
//     CTN#(0) PO#(1) SKU#(2) UPC(3) StyleDesc(4) ColorDesc(5) PCS/CTN(6)
//     N/W(7) G/W(8) MEASURE(9) — weights/measure only on each carton's first row
//     ("1#","2#",… in col 0). Both sheets repeat their header on page breaks and
//     the PL ends with Gross/Net Weight summary rows, so rows are filtered by the
//     SKU shape (/^ZC/) rather than by blank-row breaks.
//
// Join: PL carton rows × Invoice attrs keyed on the FULL SKU (both sheets carry
// the identical full SKU incl. size segment; 100% coverage verified). Unit price
// and product attrs come from the Invoice; qty/carton/weights from the PL;
// total = unit_price × pcs.

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const DIR = path.join(__dirname, '..', 'data', 'converted docs', 'SMS');

const SOURCES = [
  'PT04817-TENTREE BY AIR.xlsx',
  'PT04818-NRI CA BY AIR.xlsx',
  'PT04819-NRI US BY AIR.xlsx',
];

const TEMPLATE_HEADER = [
  'CTN#', 'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
  'Category', 'Gender', 'Composition', 'HTS Code', 'Unit Price USD', 'Total USD',
  'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
];

const S = (v) => String(v ?? '').trim();
const N = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const isSku = (v) => /^ZC/i.test(S(v));
// "54X32X40CM" / "60 x 40 x 20" -> "54X32X40" (strip a trailing CM unit)
const normMeasure = (m) => S(m).replace(/\s+/g, '').replace(/[*×xX]/g, 'X').toUpperCase().replace(/CM$/, '');
// "PO04817" / "04817" -> "PO04817"
const normPo = (v) => { const d = S(v).replace(/\D/g, ''); return d ? `PO${d.padStart(5, '0')}` : ''; };

function parseWorkbook(fileBuffer) {
  const wb = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
  const grid = (name) => xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });

  // ── Invoice sheet → full-SKU attribute map ──
  const inv = grid('Invoice');
  const attrs = new Map();
  let poNumber = '';
  for (const r of inv) {
    if (!isSku(r[1])) continue;           // skips metadata + repeated page headers
    if (!poNumber) poNumber = normPo(r[0]);
    attrs.set(S(r[1]), {
      upc: S(r[2]), knit_woven: S(r[3]), style_description: S(r[4]),
      color_description: S(r[5]), category: S(r[6]), gender: S(r[7]),
      composition: S(r[8]), hts_code: S(r[9]), unit_price: N(r[11]),
    });
  }

  // ── Packing List sheet → carton rows ──
  const pl = grid('Packing List');
  const rows = [];
  let ctn = null;
  for (const r of pl) {
    const newCarton = S(r[0]) !== '' && /\d/.test(S(r[0]));  // "1#","2#",…
    if (newCarton) ctn = parseInt(S(r[0]), 10);
    if (!isSku(r[2])) continue;            // skips headers + Gross/Net Weight summary
    const sku = S(r[2]);
    const qty = N(r[6]);
    const a = attrs.get(sku) || {};
    rows.push({
      ctn,
      po: normPo(r[1]) || poNumber,
      sku,
      upc: a.upc || S(r[3]),
      knit_woven: a.knit_woven || '',
      style_description: a.style_description || S(r[4]),
      color_description: a.color_description || S(r[5]),
      category: a.category || '',
      gender: a.gender || '',
      composition: a.composition || '',
      hts_code: a.hts_code || '',
      unit_price: a.unit_price || 0,
      total_usd: +((a.unit_price || 0) * qty).toFixed(2),
      pcs: qty,
      // weights/measure belong to the carton — emit only on its first row
      nw: newCarton ? N(r[7]) : '',
      gw: newCarton ? N(r[8]) : '',
      measure: newCarton ? normMeasure(r[9]) : '',
      _matched: attrs.has(sku),
    });
  }
  return { rows, po: poNumber };
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

for (const f of SOURCES) {
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
  if (unmatched.length) console.log(`     !! UNMATCHED SKU: ${unmatched.map((r) => r.sku).join(', ')}`);
}
