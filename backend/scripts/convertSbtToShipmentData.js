'use strict';

// Convert SHANGHAI BROTHERS TEXTILE (SBT) "Detail PL FOR PO0480x" packing-list
// workbooks in `data/converted docs/` into the flat shipment-data template
// consumed by services/ciParser.parseShipmentData. One output per PO.
//
// The PL .xls is already close to the template (CTN#, PO#, SKU, UPC, Style, Color,
// PCS/CTN, N/W, G/W, MEASURE — weights/measure on each carton's first row). It has
// NO unit price, HS code, composition or knit/woven; those come from the matching
// declaration PDF (the commercial invoice), keyed on style number (first SKU
// segment). Prices are the CI's blended per-group unit price and DIFFER per PO;
// HS code and fabric are consistent across POs. Category/Gender aren't cleanly
// per-SKU in the source → left blank.

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const DIR = path.join(__dirname, '..', 'data', 'converted docs');

const TEMPLATE_HEADER = [
  'CTN#', 'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
  'Category', 'Gender', 'Composition', 'HTS Code', 'Unit Price USD', 'Total USD',
  'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
];

// ── commercial-invoice data (from the declaration PDFs), keyed on style number ──
const HTS = {
  ZAU1572: '6505009900', ZAU3832: '6505009900', ZAU5469: '6505009900', ZAU7096: '6505009900',
  ZAU6708: '6505009900', ZAU6709: '6505009900', ZAU6710: '6115950019', ZAU6711: '6116990000',
  ZCW6640: '6110300090', ZCW6744: '6110300090', ZCW6646: '6110300090',
  ZCW6726: '6110300090', ZCW7032: '6110300090', ZCW7037: '6110300090',
};
// "<composition>/<Knit|Woven>" as printed on the CI
const FABRIC = {
  ZAU1572: '100%Wool/Knit',
  ZAU3832: '100%Cotton/Knit', ZAU5469: '100%Cotton/Knit', ZAU7096: '100%Cotton/Knit',
  ZAU6708: '100% Polyester/Knit', ZAU6709: '100% Polyester/Knit',
  ZAU6710: '62%Cotton35%Nylon3%Spandex/Knit', ZAU6711: '100% Polyester/Knit',
  ZCW6640: '100% Polyester/Knit', ZCW6744: '100% Polyester/Knit', ZCW6646: '100% Polyester/Knit',
  ZCW6726: '100% Polyester/Knit', ZCW7032: '100% Polyester/Knit', ZCW7037: '100% Polyester/Knit',
};
// blended per-group unit price (USD) per PO — from each CI
const PRICE = {
  '04805': { ZAU1572: 6.95, ZAU3832: 4.6150, ZAU5469: 4.6150, ZAU7096: 4.6150, ZAU6708: 4.5050, ZAU6709: 4.5050, ZAU6710: 4.59, ZAU6711: 5.65, ZCW6640: 22.75, ZCW6744: 22.75, ZCW6646: 16.72, ZCW6726: 16.72, ZCW7032: 16.72, ZCW7037: 16.72 },
  '04806': { ZAU1572: 6.95, ZAU3832: 4.5840, ZAU5469: 4.5840, ZAU7096: 4.5840, ZAU6708: 4.5211, ZAU6709: 4.5211, ZAU6710: 4.59, ZAU6711: 5.65, ZCW6640: 22.75, ZCW6744: 22.75, ZCW6646: 16.9136, ZCW6726: 16.9136, ZCW7032: 16.9136, ZCW7037: 16.9136 },
  '04807': { ZAU1572: 6.95, ZAU3832: 4.6220, ZAU5469: 4.6220, ZAU7096: 4.6220, ZAU6708: 4.5147, ZAU6709: 4.5147, ZAU6710: 4.59, ZAU6711: 5.65, ZCW6640: 22.75, ZCW6744: 22.75, ZCW6646: 16.9737, ZCW6726: 16.9737, ZCW7032: 16.9737, ZCW7037: 16.9737 },
};
// CI grand totals for reconciliation
const CI_TOTAL = { '04805': 876.10, '04806': 918.56, '04807': 1865.42 };

const FILES = {
  '04805': 'Detail PL FOR PO04805-HEAD OFFICE.xls',
  '04806': 'Detail PL FOR PO04806-NRI CA WAREHOUSE KAMLOOPS.xls',
  '04807': 'Detail PL FOR PO04807-NRI US WAREHOUSE.xls',
};

const S = (v) => String(v ?? '').trim();
const N = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
const r2 = (n) => +n.toFixed(2);
const normMeasure = (m) => S(m).replace(/cm$/i, '').replace(/\s+/g, '').replace(/[*×xX]/g, 'X').toUpperCase();
const composition = (style) => (FABRIC[style] || '').replace(/\/(knit|woven)\s*$/i, '').replace(/%(?=\S)/g, '% ').trim();
const knitWoven = (style) => { const m = /\/(knit|woven)\s*$/i.exec(FABRIC[style] || ''); return m ? m[1].replace(/^./, (c) => c.toUpperCase()) : ''; };

for (const [po, file] of Object.entries(FILES)) {
  const wb = xlsx.read(fs.readFileSync(path.join(DIR, file)), { type: 'buffer', cellDates: true });
  const grid = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  const hdr = grid.findIndex((r) => /ctn/i.test(S(r[0])) && /sku/i.test(S(r[2])));
  const C = { ctn: 0, po: 1, sku: 2, upc: 3, style: 4, color: 5, pcs: 6, nw: 7, gw: 8, measure: 9 };
  const prices = PRICE[po];

  const aoa = [TEMPLATE_HEADER];
  const unmatched = [];
  let totalPcs = 0, totalVal = 0, cartons = new Set();
  for (let i = hdr + 1; i < grid.length; i++) {
    const r = grid[i];
    if (/total/i.test(S(r[0]))) break;
    const sku = S(r[C.sku]);
    if (!/^Z[A-Z]{2}\d/i.test(sku)) continue;              // skip blanks / summary rows
    const style = sku.split('-')[0];
    const pcs = N(r[C.pcs]);
    const unit = prices[style];
    if (unit == null) unmatched.push(style);
    const poCell = S(r[C.po]) || `PO${po}`;
    cartons.add(N(r[C.ctn])); totalPcs += pcs; totalVal += (unit || 0) * pcs;
    aoa.push([
      N(r[C.ctn]), poCell, sku, S(r[C.upc]), knitWoven(style), S(r[C.style]), S(r[C.color]),
      '', '', composition(style), HTS[style] || '',
      unit || 0, r2((unit || 0) * pcs), pcs,
      // weights & measure already sit on each carton's first row in the source
      r[C.nw] !== '' ? N(r[C.nw]) : '', r[C.gw] !== '' ? N(r[C.gw]) : '', normMeasure(r[C.measure]),
    ]);
  }

  const outName = `PO${po}-shipment-data.xlsx`;
  const out = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(out, xlsx.utils.aoa_to_sheet(aoa), 'Shipment Data');
  xlsx.writeFile(out, path.join(DIR, outName));

  const diff = r2(totalVal - CI_TOTAL[po]);
  console.log(`\n${file}`);
  console.log(`  -> ${outName}`);
  console.log(`     PO${po} | ${aoa.length - 1} SKU rows | ${cartons.size} carton(s) | ${totalPcs} pcs | $${r2(totalVal)} (CI $${CI_TOTAL[po].toFixed(2)}, Δ ${diff})`);
  if (unmatched.length) console.log(`     !! UNMATCHED style (no CI price): ${[...new Set(unmatched)].join(', ')}`);
}
