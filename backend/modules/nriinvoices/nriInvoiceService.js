'use strict';
/**
 * The three-way reconcile. PURE — hand it parsed inputs, get a verdict.
 *
 *   INVOICE (pdf)   the SUMMARY   -> control totals. Does the detail add up to
 *                                    what NRI is actually billing?
 *   DATA (xlsx)     the SOURCE    -> the lines being coded.
 *   AGREEMENT       the VALIDATOR -> is each line priced per the rate card?
 *
 * Nothing here reads or writes. The controller supplies the parsed documents and
 * persists the result.
 */

const chargeCodes = require('./chargeCodes');
const rateCard = require('./rateCard');
const lineClass = require('./lineClass');

/**
 * GL re-classifications finance applies by hand every month. Encoded as RULES on
 * stable fields, not as positional overrides.
 *
 * `Data Entry Labour` booked against a Vendor Compliance request is VAS work, not
 * an Extra Charge — 8 of the workbook's 19 manual overrides are exactly this, and
 * it is the $7.56 that moves GL 5204 to $2,021.59 and GL 5211 to $19.56 on
 * invoice 48872.
 */
const GL_RULES = [
  {
    id: 'data_entry_vendor_compliance',
    when: l => norm(l.service) === 'Data Entry Labour' && /vendor\s*compliance/i.test(norm(l.client_ref_1)),
    gl: 5211,
    gl_desc: 'COGS : Distribution/Logistics : Fulfillment - VAS',
    reason: 'Data Entry Labour raised for Vendor Compliance is VAS, not an Extra Charge',
  },
];

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const norm = v => (v === undefined || v === null ? '' : String(v).trim());
const skey = v => norm(v).toUpperCase().replace(/\s+/g, ' ');

/* ------------------------------------------------------------- tie-out ----- */

/**
 * Does the detail reconcile to the invoice? Compared PER SERVICE, not just on the
 * grand total — a compensating pair of errors would pass a total-only check.
 * Returns `status: 'no_summary'` when there is no PDF, so the invoice can still
 * be coded but is visibly unproven.
 */
function tieOut(pdf, lines) {
  const detail = new Map();
  for (const l of lines) {
    const k = skey(l.service);
    const e = detail.get(k) || { service: norm(l.service), charges: 0, taxes: 0, lines: 0 };
    e.charges = round2(e.charges + l.charges);
    e.taxes = round2(e.taxes + l.taxes);
    e.lines++;
    detail.set(k, e);
  }

  const detailCharges = round2([...detail.values()].reduce((s, e) => s + e.charges, 0));
  const detailTaxes = round2([...detail.values()].reduce((s, e) => s + e.taxes, 0));

  if (!pdf) {
    return {
      status: 'no_summary',
      message: 'No invoice PDF supplied, so the detail cannot be proven complete.',
      detail_charges: detailCharges, detail_taxes: detailTaxes,
      detail_total: round2(detailCharges + detailTaxes),
      services: [...detail.values()].map(e => ({ ...e, invoice_amount: null, variance: null, status: 'unproven' })),
      unmatched_on_invoice: [], mismatched: 0,
    };
  }

  const summary = new Map();
  for (const s of pdf.services || []) summary.set(skey(s.service), s);

  const services = [];
  let mismatched = 0;
  for (const k of new Set([...detail.keys(), ...summary.keys()])) {
    const d = detail.get(k);
    const s = summary.get(k);
    const charges = d ? d.charges : 0;
    const invoiceAmount = s ? round2(s.amount) : null;
    const variance = invoiceAmount === null ? null : round2(charges - invoiceAmount);
    let status = 'ok';
    if (!s) {
      // A zero-dollar service in the detail is noise, not a break — the NRI files
      // carry a blank trailing row. Only a service with money behind it can fail
      // the tie-out.
      status = Math.abs(charges) > 0.005 ? 'not_on_invoice' : 'ok';
    } else if (!d) status = 'missing_from_detail';  // invoice bills a service the detail lacks
    else if (Math.abs(variance) > 0.005) status = 'variance';
    if (status !== 'ok') mismatched++;
    services.push({
      service: (d && d.service) || (s && s.service) || k || '(blank)',
      lines: d ? d.lines : 0, charges, taxes: d ? d.taxes : 0,
      invoice_amount: invoiceAmount, variance, status,
    });
  }
  services.sort((a, b) => Math.abs(b.charges) - Math.abs(a.charges));

  const subtotalVar = pdf.subtotal === null ? null : round2(detailCharges - pdf.subtotal);
  const taxVar = pdf.taxes === null ? null : round2(detailTaxes - pdf.taxes);
  const totalVar = pdf.total === null ? null : round2(detailCharges + detailTaxes - pdf.total);
  const balanced = mismatched === 0
    && (subtotalVar === null || Math.abs(subtotalVar) <= 0.005)
    && (totalVar === null || Math.abs(totalVar) <= 0.005);

  return {
    status: balanced ? 'balanced' : 'out_of_balance',
    message: balanced
      ? `Detail ties to invoice ${pdf.invoice_no || ''} across all ${services.length} services.`
      : `${mismatched} service(s) do not tie to invoice ${pdf.invoice_no || ''}.`,
    detail_charges: detailCharges, detail_taxes: detailTaxes,
    detail_total: round2(detailCharges + detailTaxes),
    invoice_subtotal: pdf.subtotal, invoice_taxes: pdf.taxes, invoice_total: pdf.total,
    subtotal_variance: subtotalVar, tax_variance: taxVar, total_variance: totalVar,
    services, mismatched,
    unmatched_on_invoice: services.filter(s => s.status === 'missing_from_detail').map(s => s.service),
  };
}

/* --------------------------------------------------------------- coding ---- */

/**
 * Code + validate every line.
 *
 * Two passes are needed: per-month fees can only be judged by looking across
 * lines (that is what catches a fee billed twice in one month), so the counts
 * are tallied first.
 */
function codeAndValidate(lines, ctx) {
  const { codeIndex, rateIndex, orderIndex, entity } = ctx;

  const monthCounts = new Map();
  for (const l of lines) {
    const rc = rateCard.rateFor(rateIndex, entity, l.service, l.completed);
    if (rc && rc.basis === 'per_month') {
      const k = `${skey(l.service)}|${l.month || '?'}`;
      monthCounts.set(k, (monthCounts.get(k) || 0) + 1);
    }
  }

  return lines.map((l, i) => {
    const coded = chargeCodes.code(codeIndex, l.service, entity);

    // GL: legend, then the hand-rules finance applies every month.
    let gl = coded.gl;
    let glDesc = coded.gl_desc;
    let glBasis = coded.status === 'coded' ? 'legend' : null;
    let glRule = null;
    for (const r of GL_RULES) {
      if (coded.status !== 'coded' || !r.when(l)) continue;
      gl = r.gl; glDesc = r.gl_desc; glBasis = 'rule'; glRule = r.reason;
      break;
    }

    // CLASS is a property of the ORDER, not the service. The legend's single
    // hardcoded class per service cannot express channel x geography, so it is
    // only a fallback for lines whose order we cannot find.
    let status = coded.status;
    let reason = coded.reason;
    const rc = lineClass.resolveClass(
      { service: l.service, clientRef1: l.client_ref_1, clientRef2: l.client_ref_2, customer: l.customer, legendClass: coded.class },
      orderIndex,
    );
    let cls = rc.class;
    const classBasis = rc.basis;
    const classConfidence = rc.confidence;
    const orderType = rc.order_type;

    if (coded.status === 'coded' && !rc.resolved) {
      // Surfaced, never silently defaulted to wholesale — that default is what
      // makes the workbook read US - Whsle $38,369 against finance's $26,543.
      status = 'needs_class';
      reason = rc.reason || 'class could not be resolved from the order data';
    }

    const check = rateCard.checkLine(rateIndex, {
      service: l.service, units: l.units, charge: l.charges,
      date: l.completed, month: l.month, entity,
    }, { monthCount: monthCounts.get(`${skey(l.service)}|${l.month || '?'}`) || 1 });

    return {
      seq: i + 1,
      ...l,
      gl, gl_desc: glDesc, gl_basis: glBasis, gl_rule: glRule,
      class: cls, class_basis: classBasis, class_confidence: classConfidence, order_type: orderType,
      ship_to_country: rc.country || null,
      legend_gl: coded.gl, legend_class: coded.class, legend_note: coded.note || null,
      coding_status: status, coding_reason: reason,
      verdict: check.verdict, expected: check.expected, variance: check.variance,
      rate: check.rate, basis: check.basis, check_detail: check.detail,
      implied_hours: check.implied_hours === undefined ? null : check.implied_hours,
      effective_rate: check.effective_rate === undefined ? null : check.effective_rate,
      aging_multiple: check.aging_multiple === undefined ? null : check.aging_multiple,
    };
  });
}

/* ------------------------------------------------------------- rollups ----- */

function summarise(coded) {
  const byGl = new Map();
  const byService = new Map();

  for (const l of coded) {
    const glKey = l.gl === null ? 'unmapped' : String(l.gl);
    const g = byGl.get(glKey) || { gl: l.gl, gl_desc: l.gl_desc, classes: new Map(), lines: 0, charges: 0, taxes: 0, amount: 0 };
    g.lines++; g.charges = round2(g.charges + l.charges); g.taxes = round2(g.taxes + l.taxes);
    g.amount = round2(g.amount + l.inv_amt);
    const ck = l.class || '(unclassed)';
    g.classes.set(ck, round2((g.classes.get(ck) || 0) + l.inv_amt));
    byGl.set(glKey, g);

    const sk = skey(l.service);
    const s = byService.get(sk) || {
      service: norm(l.service) || '(blank)', gl: l.gl, basis: l.basis, lines: 0, units: 0,
      charges: 0, amount: 0, expected: 0, variance: 0, has_expected: false, verdicts: [],
    };
    s.lines++; s.units += (l.units || 0);
    s.charges = round2(s.charges + l.charges);
    s.amount = round2(s.amount + l.inv_amt);
    if (l.expected !== null && l.expected !== undefined) {
      s.expected = round2(s.expected + l.expected);
      s.variance = round2(s.variance + (l.variance || 0));
      s.has_expected = true;
    }
    s.verdicts.push(l.verdict);
    byService.set(sk, s);
  }

  return {
    by_gl: [...byGl.values()]
      .map(g => ({ ...g, classes: [...g.classes.entries()].map(([cls, amount]) => ({ class: cls, amount })) }))
      .sort((a, b) => b.amount - a.amount),
    by_service: [...byService.values()]
      .map(s => ({
        ...s,
        expected: s.has_expected ? s.expected : null,
        variance: s.has_expected ? s.variance : null,
        verdict: rateCard.worst(s.verdicts),
        verdicts: undefined,
      }))
      .sort((a, b) => b.amount - a.amount),
  };
}

/**
 * Roll the line verdicts into a short, ranked list of things a human should look
 * at. Ordered by dollars so the queue is worth working top-down.
 */
function findings(coded, tie) {
  const out = [];
  // Coding findings must explain the CODING, not the rate check — a line can be
  // priced correctly and still have nowhere to post.
  const CODING_TYPES = new Set(['needs_coding', 'needs_class']);
  const push = (severity, type, title, rows, extra) => {
    if (!rows.length) return;
    const detailOf = l => (CODING_TYPES.has(type) ? (l.coding_reason || l.check_detail) : (l.check_detail || l.coding_reason));
    out.push({
      severity, type, title,
      lines: rows.length,
      amount: round2(rows.reduce((s, l) => s + l.inv_amt, 0)),
      variance: round2(rows.reduce((s, l) => s + (l.variance || 0), 0)),
      services: [...new Set(rows.map(l => norm(l.service) || '(blank)'))].slice(0, 6),
      examples: rows.slice(0, 5).map(l => ({
        seq: l.seq, service: norm(l.service) || '(blank)', month: l.month, units: l.units,
        charges: l.charges, expected: l.expected, detail: detailOf(l),
      })),
      ...extra,
    });
  };

  const V = rateCard.VERDICT;
  if (tie && tie.status === 'out_of_balance') {
    out.push({
      severity: 'blocker', type: 'tie_out', title: 'Detail does not tie to the invoice',
      lines: tie.mismatched, amount: round2(tie.total_variance || 0), variance: round2(tie.total_variance || 0),
      services: tie.services.filter(s => s.status !== 'ok').map(s => s.service).slice(0, 6),
      examples: tie.services.filter(s => s.status !== 'ok').slice(0, 5).map(s => ({
        service: s.service, charges: s.charges, expected: s.invoice_amount,
        detail: `detail $${s.charges.toFixed(2)} vs invoice ${s.invoice_amount === null ? 'n/a' : '$' + s.invoice_amount.toFixed(2)} (${s.status})`,
      })),
    });
  }

  // Value-bearing only, so the finding list and the submit gate agree. The NRI
  // files carry a blank trailing row; flagging a $0.00 line as a blocker would
  // put permanent noise at the top of every invoice's review queue.
  const hasValue = l => Math.abs(l.inv_amt) > 0.005;

  push('blocker', 'duplicate', 'Fixed monthly fee billed more than once in a month',
    coded.filter(l => l.verdict === V.DUPLICATE));
  push('blocker', 'needs_coding', 'No GL mapping for this service',
    coded.filter(l => l.coding_status === 'needs_coding' && hasValue(l)));
  // Not a judgement call — a MISSING INPUT. The class needs the order data
  // covering the invoice's activity period, and NRI delivers that as separate
  // periodic CSVs that can lag the invoice.
  push('blocker', 'needs_class', 'Class unresolved — order data missing for this period',
    coded.filter(l => l.coding_status === 'needs_class' && hasValue(l)));
  push('warning', 'overcharge', 'Charged above the rate agreement',
    coded.filter(l => l.verdict === V.OVERCHARGE));
  push('info', 'undercharge', 'Charged below the rate agreement',
    coded.filter(l => l.verdict === V.UNDERCHARGE));
  push('warning', 'no_rate_on_file', 'No rate on file for this service and date',
    coded.filter(l => l.verdict === V.NO_RATE_ON_FILE && hasValue(l)));

  const aging = coded.filter(l => l.verdict === V.AGING_PREMIUM);
  push('warning', 'aging_premium', 'Storage above the base rate — no aging breakdown on the invoice', aging,
    aging.length ? {
      max_aging_multiple: Math.max(...aging.map(l => l.aging_multiple || 0)),
      premium: round2(aging.reduce((s, l) => s + (l.variance || 0), 0)),
    } : undefined);

  const hourly = coded.filter(l => l.verdict === V.QTY_UNSUPPORTED && l.basis === 'per_hour');
  push('info', 'qty_unsupported', 'Hourly labour — rate verified, hours not evidenced', hourly,
    hourly.length ? { implied_hours: round2(hourly.reduce((s, l) => s + (l.implied_hours || 0), 0)) } : undefined);

  push('info', 'no_contract_rate', 'No rate in the agreement — cannot be validated',
    coded.filter(l => l.verdict === V.NO_CONTRACT_RATE));

  const rank = { blocker: 0, warning: 1, info: 2 };
  return out.sort((a, b) => (rank[a.severity] - rank[b.severity]) || Math.abs(b.amount) - Math.abs(a.amount));
}

/** Full reconcile for one invoice. */
function reconcile({ pdf, lines, codeIndex, rateIndex, orderIndex, entity = 'US' }) {
  const tie = tieOut(pdf, lines);
  const coded = codeAndValidate(lines, { codeIndex, rateIndex, orderIndex, entity });
  const rolled = summarise(coded);
  const found = findings(coded, tie);

  return {
    entity,
    invoice: pdf ? {
      invoice_no: pdf.invoice_no, invoice_date: pdf.invoice_date, ending_date: pdf.ending_date,
      payment_terms: pdf.payment_terms, due_date: pdf.due_date, fx_rate: pdf.fx_rate,
      subtotal: pdf.subtotal, taxes: pdf.taxes, total: pdf.total,
      tax_lines: pdf.tax_lines || [], is_credit: !!pdf.is_credit,
    } : null,
    tie_out: tie,
    totals: {
      lines: coded.length,
      charges: tie.detail_charges, taxes: tie.detail_taxes, amount: tie.detail_total,
      coded: coded.filter(l => l.coding_status === 'coded').length,
      needs_attention: coded.filter(l => l.coding_status !== 'coded').length,
      validated_ok: coded.filter(l => l.verdict === rateCard.VERDICT.OK).length,
      unvalidatable: coded.filter(l => l.verdict === rateCard.VERDICT.NO_CONTRACT_RATE).length,
      variance: round2(coded.reduce((s, l) => s + (l.variance || 0), 0)),
    },
    by_gl: rolled.by_gl,
    by_service: rolled.by_service,
    findings: found,
    lines: coded,
  };
}

module.exports = { reconcile, tieOut, codeAndValidate, summarise, findings };
