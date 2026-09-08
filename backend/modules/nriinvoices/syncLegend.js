'use strict';
/**
 * Sync the GL coding legend from the shared drive into this module's own table.
 *
 *   node modules/nriinvoices/syncLegend.js [--dry-run] [path-to-legend.xlsx]
 *
 * Source of truth stays the spreadsheet finance maintains:
 *   G:\Shared drives\...\NRI\Invoices\NRI Invoice Netsuite GL Coding Legend.xlsx
 * This copies it into `data/nri/nri_charge_codes.json` so the coder has a stable,
 * normalised, UNIQUELY-KEYED version, and reports the defects it found on the way.
 *
 * Writes only this module's table.
 */

const path = require('path');
const xl = require('./xlsxStream');
const chargeCodes = require('./chargeCodes');

const DEFAULT_LEGEND = 'G:/Shared drives/Tentree Shared Drive/Operations/Logistics/'
  + 'Warehouses/NRI/Invoices/NRI Invoice Netsuite GL Coding Legend.xlsx';

const norm = v => (v === undefined || v === null ? '' : String(v).trim());

async function readLegend(file) {
  const wb = xl.open(file);
  const sst = await xl.sharedStrings(wb);
  const index = await xl.sheetIndex(wb);
  const sheet = index.has('NRI Invoice Coding') ? 'NRI Invoice Coding' : [...index.keys()][0];

  let header = null;
  const rows = [];
  await xl.eachRow(wb, sheet, sst, (n, cells) => {
    if (!header) { header = cells.map(c => norm(c && c.error ? '' : c)); return true; }
    const at = name => { const i = header.indexOf(name); return i === -1 ? undefined : cells[i]; };
    const service = norm(at('Service'));
    if (!service) return;
    rows.push({
      service_raw: String(at('Service')),
      service,
      gl: at('Netsuite GL') === undefined || at('Netsuite GL') === null ? null : Number(at('Netsuite GL')),
      gl_desc: norm(at('Description')) || null,
      class_us: norm(at('Class')) || null,
      class_ca: norm(at('Class (NRI CAN)')) || null,
      note: norm(at('Notes')) || null,
    });
  });
  return { sheet, rows };
}

function analyse(rows) {
  const seen = new Map();
  const duplicates = [];
  for (const r of rows) {
    const k = chargeCodes.key(r.service);
    if (seen.has(k)) duplicates.push({ key: k, raw: [seen.get(k).service_raw, r.service_raw] });
    else seen.set(k, r);
  }
  return {
    duplicates,
    whitespace: rows.filter(r => r.service_raw !== r.service).map(r => r.service_raw),
    blankUsClass: rows.filter(r => !r.class_us).map(r => r.service),
    blankCaClass: rows.filter(r => !r.class_ca).map(r => r.service),
    noGl: rows.filter(r => r.gl === null || Number.isNaN(r.gl)).map(r => r.service),
    deduped: [...seen.values()],
  };
}

async function sync({ file = DEFAULT_LEGEND, dryRun = false } = {}) {
  const { sheet, rows } = await readLegend(file);
  const a = analyse(rows);

  const out = a.deduped
    .map(r => ({
      id: 'ncc_' + chargeCodes.key(r.service).toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      service: r.service,
      service_raw: r.service_raw === r.service ? undefined : r.service_raw,
      gl: r.gl, gl_desc: r.gl_desc,
      class_us: r.class_us, class_ca: r.class_ca,
      note: r.note,
    }))
    .sort((x, y) => x.service.localeCompare(y.service));

  if (!dryRun) await chargeCodes.codesTable.write(out);
  chargeCodes.reload();
  return { sheet, source: file, read: rows.length, written: out.length, dryRun, defects: a };
}

module.exports = { sync, readLegend, DEFAULT_LEGEND };

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find(a => !a.startsWith('--')) || DEFAULT_LEGEND;

  sync({ file, dryRun }).then(r => {
    console.log(`legend  : ${r.source}`);
    console.log(`sheet   : ${r.sheet}`);
    console.log(`rows    : ${r.read} read -> ${r.written} written${r.dryRun ? ' (DRY RUN, nothing saved)' : ''}`);
    const d = r.defects;
    const show = (label, arr) => console.log(`  ${label.padEnd(28)} ${arr.length}${arr.length ? ': ' + arr.slice(0, 8).join(', ') : ''}`);
    console.log('\ndefects found in the legend (fixed on the way in):');
    console.log(`  ${'duplicate service keys'.padEnd(28)} ${d.duplicates.length}` +
      (d.duplicates.length ? ': ' + d.duplicates.map(x => JSON.stringify(x.raw)).join(', ') : ''));
    show('keys with stray whitespace', d.whitespace.map(s => JSON.stringify(s)));
    show('no GL', d.noGl);
    show('blank US class', d.blankUsClass);
    show('blank CA class', d.blankCaClass);
    console.log('\nNote: blank-class rows are kept. They code to needs_coding for that');
    console.log('entity rather than posting unclassed, which is what the workbook does today.');
  }).catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
}
