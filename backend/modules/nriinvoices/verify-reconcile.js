'use strict';
// Read-only end-to-end check: invoice PDF + detail xlsx + agreement -> verdict.
//   node modules/nriinvoices/verify-reconcile.js <invoice.pdf> <detail.xlsx> [US|CA]
const fs = require('fs');
const parser = require('./invoiceParser');
const chargeCodes = require('./chargeCodes');
const rateCard = require('./rateCard');
const returnsClass = require('./returnsClass');
const svc = require('./nriInvoiceService');

const COMBINED = require('path').join(__dirname, '..', '..', 'storage', 'reference', 'nri', 'NRI US_ALL Invoices 2026.xlsx');
const m = n => '$' + (n === null || n === undefined ? '  -  ' : n.toFixed(2)).padStart(11);

(async () => {
  const [pdfPath, xlsxPath, ent] = process.argv.slice(2);
  const entity = (ent || 'US').toUpperCase();

  const pdf = pdfPath ? await parser.parseInvoicePdf(fs.readFileSync(pdfPath)) : null;
  const lines = await parser.parseDetailWorkbook(fs.readFileSync(xlsxPath), require('path').basename(xlsxPath));
  const orderContext = returnsClass.buildOrderContext(await parser.parseOrderData(COMBINED));

  const r = svc.reconcile({
    pdf, lines, entity, orderContext,
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
})().catch(e => { console.error('FAILED: ' + e.message + '\n' + e.stack); process.exitCode = 1; });
