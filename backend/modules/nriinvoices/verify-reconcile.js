'use strict';
// Read-only end-to-end check: invoice PDF + detail xlsx + agreement -> verdict.
//   node modules/nriinvoices/verify-reconcile.js <invoice.pdf> <detail.xlsx> [US|CA]
const fs = require('fs');
const parser = require('./invoiceParser');
const chargeCodes = require('./chargeCodes');
const rateCard = require('./rateCard');
const returnsClass = require('./returnsClass');
const svc = require('./nriInvoiceService');

const COMBINED = require('path').join(__dirname, '..', '..', 'NRI US_ALL Invoices 2026.xlsx');
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

  console.log('INVOICE   ', r.invoice ? `${r.invoice.invoice_no}  ${r.invoice.invoice_date}  ${r.invoice.payment_terms}  due ${r.invoice.due_date}  FX ${r.invoice.fx_rate}` : '(no PDF)');
  console.log('TIE-OUT   ', r.tie_out.status.toUpperCase(), '—', r.tie_out.message);
  console.log('           detail', m(r.tie_out.detail_charges), '+ tax', m(r.tie_out.detail_taxes), '=', m(r.tie_out.detail_total),
    '| invoice', m(r.tie_out.invoice_total), '| var', m(r.tie_out.total_variance));
  const t = r.totals;
  console.log('LINES     ', `${t.lines} total · ${t.coded} coded · ${t.needs_attention} need attention · ${t.validated_ok} validated OK · ${t.unvalidatable} unvalidatable`);
  console.log('VARIANCE  ', m(t.variance));

  console.log('\nBY GL');
  r.by_gl.forEach(g => console.log('  ' + String(g.gl ?? 'unmapped').padEnd(9) + m(g.amount) + '  ' + String(g.lines).padStart(5) + ' lines  ' +
    g.classes.map(c => `${c.class} ${c.amount.toFixed(2)}`).join(' / ').padEnd(42) + (g.gl_desc || '')));

  console.log('\nBY SERVICE');
  console.log('  ' + 'service'.padEnd(29) + 'charged'.padStart(12) + 'expected'.padStart(13) + 'variance'.padStart(11) + '  verdict');
  r.by_service.forEach(s => console.log('  ' + String(s.service || '(blank)').padEnd(29) + m(s.charges) + m(s.expected) + m(s.variance) + '  ' + s.verdict));

  console.log('\nFINDINGS');
  r.findings.forEach(f => {
    console.log(`  [${f.severity.toUpperCase()}] ${f.title}`);
    console.log(`      ${f.lines} lines · ${m(f.amount)}` + (f.variance ? ` · variance ${m(f.variance)}` : '') +
      (f.max_aging_multiple ? ` · max ${f.max_aging_multiple}x base` : '') +
      (f.implied_hours ? ` · ${f.implied_hours} hrs` : ''));
    console.log(`      services: ${f.services.join(', ')}`);
    if (f.examples[0]) console.log(`      e.g. ${f.examples[0].detail}`);
  });
})().catch(e => { console.error('FAILED: ' + e.message + '\n' + e.stack); process.exitCode = 1; });
