'use strict';
// Read-only end-to-end check: invoice PDF + detail xlsx + agreement -> verdict.
//   node scripts/verify-reconcile.js <invoice.pdf> <detail.xlsx> [US|CA]
const fs = require('fs');
const parser = require('../src/lib/nriInvoiceParser');
const chargeCodes = require('../src/lib/nriChargeCodes');
const rateCard = require('../src/lib/nriRateCard');
const orderData = require('../src/lib/nriOrderData');
const lineClass = require('../src/lib/nriLineClass');
const M = require('../src/lib/NriInvoiceModels');
const svc = require('../src/services/nriInvoiceService');

// Same override the controller honours, so the two read the same order master.
const COMBINED = process.env.NRI_ORDER_DATA_WORKBOOK
  || require('path').join(__dirname, '..', 'storage', 'reference', 'nri', 'NRI US_ALL Invoices 2026.xlsx');
const m = n => '$' + (n === null || n === undefined ? '  -  ' : n.toFixed(2)).padStart(11);

(async () => {
  const [pdfPath, xlsxPath, ent] = process.argv.slice(2);
  const entity = (ent || 'US').toUpperCase();

  const pdf = pdfPath ? await parser.parseInvoicePdf(fs.readFileSync(pdfPath)) : null;
  const lines = await parser.parseDetailWorkbook(fs.readFileSync(xlsxPath), require('path').basename(xlsxPath));
  // The CLASS depends on the order (channel x geography x marketplace), so the
  // order master is a required input, not a nicety.
  //
  // This mirrors `orderMaster()` in nriInvoiceController — deliberately, because
  // the point of this script is to reproduce what the endpoint does. It had
  // drifted twice over: it called `returnsClass.buildOrderContext`, a module that
  // has never existed in this repo, and passed the result as `orderContext`,
  // which `reconcile` has never read (it takes `orderIndex`). So even once the
  // require was satisfied the class would have come back unresolved on every
  // line. Rows uploaded through the portal are ingested last and win — see
  // nriOrderData.load.
  const stored = (await M.orderMaster.read().catch(() => []))
    .filter((r0) => !r0.entity || String(r0.entity).toUpperCase() === entity);
  const master = await orderData.load({
    workbook: COMBINED, stored,
    storedLabel: `uploaded in the portal (${stored.length} rows)`,
  });
  const orderIndex = lineClass.buildOrderIndex(master);

  const r = svc.reconcile({
    pdf, lines, entity, orderIndex,
    codeIndex: await chargeCodes.load(),
    rateIndex: await rateCard.load(),
  });

  console.log('INVOICE   ', r.invoice ? `${r.invoice.invoiceNo}  ${r.invoice.invoiceDate}  ${r.invoice.paymentTerms}  due ${r.invoice.dueDate}  FX ${r.invoice.fxRate}` : '(no PDF)');
  console.log('TIE-OUT   ', r.tieOut.status.toUpperCase(), '—', r.tieOut.message);
  console.log('           detail', m(r.tieOut.detailCharges), '+ tax', m(r.tieOut.detailTaxes), '=', m(r.tieOut.detailTotal),
    '| invoice', m(r.tieOut.invoiceTotal), '| var', m(r.tieOut.totalVariance));
  const t = r.totals;
  console.log('LINES     ', `${t.lines} total · ${t.coded} coded · ${t.needsAttention} need attention · ${t.validatedOk} validated OK · ${t.unvalidatable} unvalidatable`);
  console.log('VARIANCE  ', m(t.variance));

  console.log('\nBY GL');
  r.byGl.forEach(g => console.log('  ' + String(g.gl ?? 'unmapped').padEnd(9) + m(g.amount) + '  ' + String(g.lines).padStart(5) + ' lines  ' +
    g.classes.map(c => `${c.class} ${c.amount.toFixed(2)}`).join(' / ').padEnd(42) + (g.glDesc || '')));

  console.log('\nBY SERVICE');
  console.log('  ' + 'service'.padEnd(29) + 'charged'.padStart(12) + 'expected'.padStart(13) + 'variance'.padStart(11) + '  verdict');
  r.byService.forEach(s => console.log('  ' + String(s.service || '(blank)').padEnd(29) + m(s.charges) + m(s.expected) + m(s.variance) + '  ' + s.verdict));

  console.log('\nFINDINGS');
  r.findings.forEach(f => {
    console.log(`  [${f.severity.toUpperCase()}] ${f.title}`);
    console.log(`      ${f.lines} lines · ${m(f.amount)}` + (f.variance ? ` · variance ${m(f.variance)}` : '') +
      (f.maxAgingMultiple ? ` · max ${f.maxAgingMultiple}x base` : '') +
      (f.impliedHours ? ` · ${f.impliedHours} hrs` : ''));
    console.log(`      services: ${f.services.join(', ')}`);
    if (f.examples[0]) console.log(`      e.g. ${f.examples[0].detail}`);
  });
})()
  .catch(e => { console.error('FAILED: ' + e.message + '\n' + e.stack); process.exitCode = 1; })
  // chargeCodes/rateCard/orderMaster all read the database, and an open Sequelize
  // pool is an active libuv handle — without this the script prints its report
  // and then hangs instead of exiting.
  .finally(() => require('../database/sequelize').sequelize.close().catch(() => {}));
