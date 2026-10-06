#!/usr/bin/env node
// CLI:  node src/index.js [--source "NRI CA Invoice Sept 15 2026.csv"] [--out output/x.xlsx] [--json output/x.json]
import { run } from './pipeline.js';
import { writeWorkbook, writeJson } from './writer.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
    return acc;
  }, [])
);

const opts = {
  invoicesDir: args.invoices ?? 'data/invoices',
  ordersFile: args.orders ?? 'data/orders.csv',
  overridesFile: args.overrides ?? 'data/overrides.csv',
  codingFile: args.coding ?? 'config/coding.json',
  rulesFile: args.rules ?? 'config/class-rules.json',
  ratesFile: args.rates ?? 'config/contract-rates.json',
  lockedFile: args.locked ?? 'config/locked-sources.json',
  source: args.source && args.source !== true ? args.source : undefined,
};

const t0 = Date.now();
const { files, lines, reports } = await run(opts);
const out = args.out ?? `output/NRI_CA_Coded${opts.source ? '_' + opts.source.replace(/\.csv$/i, '').replace(/\s+/g, '_') : ''}.xlsx`;
await writeWorkbook(out, { lines, reports });
if (args.json) writeJson(args.json, { lines, reports });

const gt = reports.glByClass.rows.at(-1);
console.log(`Invoices read : ${files.length}`);
console.log(`Lines coded   : ${lines.length}${opts.source ? `  (filtered: ${opts.source})` : ''}`);
console.log(`Total charges : ${gt['Grand Total'].toLocaleString('en-CA', { style: 'currency', currency: 'CAD' })}`);
console.log(`Exceptions    : ${reports.exceptions.length}`);
console.log(`Output        : ${out}  (${Date.now() - t0} ms)`);
