'use strict';
/**
 * The rate agreement as the VALIDATOR. All pure — no IO except `load`.
 *
 * Three principles the data forced:
 *
 * 1. RATES ARE EFFECTIVE-DATED. The 2026 agreement starts 2026-02-01 and the GRI
 *    moved four rates ($1.66->$1.70, $0.64->$0.657, $0.126->$0.129,
 *    $10.50->$10.76). A single-rate table gets all 1,430 January order lines
 *    wrong. Rates are selected on the line's `Completed` (activity) date.
 *
 * 2. COMPARE THE LINE TOTAL, NEVER THE IMPLIED RATE. NRI rounds each line to
 *    cents, so `charge / units` yields 30 distinct "rates" for a flat $0.657
 *    (1 unit -> $0.66 -> 0.660; 2 units -> $1.31 -> 0.655). Tolerance is +/-$0.01
 *    on the total, scaled by the number of cents that could round.
 *
 * 3. HOURLY QUANTITY IS NOT VERIFIABLE. The `Units` column on hourly lines is a
 *    ROUNDED hour count that does not tie to the charge (Cycle Count: Units 332
 *    against 340.00 actual hours). So hours are DERIVED from the charge and only
 *    the rate is checked — the verdict says so rather than pretending.
 */

const BaseModel = require('../../models/BaseModel');

const rateTable = new BaseModel('nri/nri_rate_card.json');

const norm = v => (v === undefined || v === null ? '' : String(v).trim());
const key = v => norm(v).toUpperCase().replace(/\s+/g, ' ');
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const num = v => (typeof v === 'number' && isFinite(v) ? v : null);

/** Verdicts, worst-first — this is also the UI's severity order. */
const VERDICT = Object.freeze({
  OVERCHARGE: 'overcharge',            // charged MORE than the agreement
  UNDERCHARGE: 'undercharge',          // charged LESS (still a variance worth seeing)
  DUPLICATE: 'duplicate',              // a per-month fee billed twice in one month
  NO_RATE_ON_FILE: 'no_rate_on_file',  // service exists but no rate row covers this date
  NO_CONTRACT_RATE: 'no_contract_rate',// agreement says "Market Rates" / says nothing
  QTY_UNSUPPORTED: 'qty_unsupported',  // rate correct, quantity not evidenced on the line
  AGING_PREMIUM: 'aging_premium',      // storage above base, within the aging schedule
  OK: 'ok',
});

const SEVERITY = Object.freeze([
  VERDICT.OVERCHARGE, VERDICT.DUPLICATE, VERDICT.UNDERCHARGE, VERDICT.NO_RATE_ON_FILE,
  VERDICT.AGING_PREMIUM, VERDICT.NO_CONTRACT_RATE, VERDICT.QTY_UNSUPPORTED, VERDICT.OK,
]);

let cache = null;

async function load() {
  if (cache) return cache;
  const rows = await rateTable.read().catch(() => []);
  cache = index(Array.isArray(rows) ? rows : []);
  return cache;
}
function reload() { cache = null; }

/** Group rate rows by entity+service so date selection is a small scan. */
function index(rows) {
  const byService = new Map();
  for (const r of rows) {
    const k = `${key(r.entity) || 'US'}|${key(r.service)}`;
    if (!byService.has(k)) byService.set(k, []);
    byService.get(k).push(r);
  }
  for (const list of byService.values()) {
    list.sort((a, b) => norm(b.effective_from).localeCompare(norm(a.effective_from)));
  }
  return { rows, byService };
}

/** The rate row in force for `service` on `date` (ISO yyyy-mm-dd), or null. */
function rateFor(idx, entity, service, date) {
  const list = idx.byService.get(`${key(entity) || 'US'}|${key(service)}`);
  if (!list) return null;
  const d = norm(date);
  if (!d) return list[0] || null;
  for (const r of list) {
    const from = norm(r.effective_from);
    const to = norm(r.effective_to);
    if (from && d < from) continue;
    if (to && d > to) continue;
    return r;
  }
  return null;
}

/**
 * Rounding tolerance. NRI rounds each *component* to cents, so a line covering
 * `n` roundable pieces can drift by up to n/2 cents. We allow 1c plus 1c per 100
 * units, which absorbed every clean line across all 16 US invoices.
 */
function tolerance(units) {
  const u = Math.abs(num(units) || 0);
  return round2(0.01 + Math.ceil(u / 100) * 0.01);
}

/**
 * Check ONE line against the agreement.
 *
 * line: { service, units, charge, date, entity }
 * returns { verdict, expected, variance, rate, basis, detail }
 *
 * `monthCount` (optional) is how many times this per-month fee appears in the
 * line's own month — supplied by the caller, which is the only thing that can see
 * across lines. That is what catches the June double-billing.
 */
function checkLine(idx, line, opts) {
  const service = norm(line.service);
  const charge = num(line.charge) || 0;
  const units = num(line.units);
  const rc = rateFor(idx, line.entity, service, line.date);

  const base = { service, charge, units, rate: rc ? rc.rate : null, basis: rc ? rc.basis : null, rate_source: rc ? rc.source : null };

  if (!rc) {
    return { ...base, verdict: VERDICT.NO_RATE_ON_FILE, expected: null, variance: null,
      detail: `no rate row covers ${service} on ${norm(line.date) || 'an unknown date'}` };
  }

  switch (rc.basis) {
    case 'market':
    case 'passthrough':
    case 'none':
      return { ...base, verdict: VERDICT.NO_CONTRACT_RATE, expected: null, variance: null,
        detail: rc.source };

    case 'per_hour': {
      // Derive hours from the charge; the Units column is unreliable here.
      const hours = rc.rate ? charge / rc.rate : null;
      const clean = hours !== null && Math.abs(hours - Math.round(hours * 100) / 100) < 1e-6;
      return { ...base, verdict: VERDICT.QTY_UNSUPPORTED,
        expected: null, variance: null, implied_hours: hours === null ? null : Math.round(hours * 10000) / 10000,
        detail: clean
          ? `${(Math.round(hours * 100) / 100).toFixed(2)} hrs at the contracted $${rc.rate.toFixed(2)}/hr — rate verified, hours not evidenced on the line`
          : `charge is not a clean multiple of $${rc.rate.toFixed(2)}/hr (implies ${hours === null ? '?' : hours.toFixed(4)} hrs)` };
    }

    case 'per_month': {
      const count = opts && Number.isFinite(opts.monthCount) ? opts.monthCount : 1;
      const expected = round2(rc.rate);
      if (count > 1) {
        return { ...base, verdict: VERDICT.DUPLICATE, expected, variance: round2(charge),
          detail: `billed ${count}x in ${norm(line.month) || 'this month'} — the agreement is one $${expected.toFixed(2)} fee per month` };
      }
      return compare(base, charge, expected, 0.01, `$${expected.toFixed(2)}/month`);
    }

    case 'per_unit_month': {
      // Storage. The base rate is a FLOOR; the agreement permits +50/+100/+200%
      // aging uplift, so this reports the multiple rather than passing/failing.
      if (!units || !rc.rate) {
        return { ...base, verdict: VERDICT.NO_CONTRACT_RATE, expected: null, variance: null,
          detail: 'storage line carries no unit count — the aging basis cannot be checked' };
      }
      const effective = charge / units;
      const multiple = effective / rc.rate;
      const atBase = round2(units * rc.rate);
      const maxMultiple = Math.max(...(rc.tiers || [{ multiple: 1 }]).map(t => Number(t.multiple) || 1));
      if (multiple <= 1.02) {
        return compare(base, charge, atBase, tolerance(units), `${units} units at the <180-day rate $${rc.rate}`);
      }
      const verdict = multiple > maxMultiple + 0.02 ? VERDICT.OVERCHARGE : VERDICT.AGING_PREMIUM;
      return { ...base, verdict, expected: atBase, variance: round2(charge - atBase),
        effective_rate: Math.round(effective * 10000) / 10000,
        aging_multiple: Math.round(multiple * 1000) / 1000,
        detail: verdict === VERDICT.OVERCHARGE
          ? `$${effective.toFixed(4)}/unit is ${multiple.toFixed(2)}x the base rate — above the ${maxMultiple}x ceiling the aging schedule allows`
          : `$${effective.toFixed(4)}/unit = ${multiple.toFixed(2)}x base. Within the aging schedule (max ${maxMultiple}x), but the invoice gives no aging breakdown to prove it` };
    }

    case 'composite': {
      // Returns: fixed fee per return + per-unit receipt & verification.
      const fixed = num(rc.fixed) || 0;
      const expected = round2(fixed + (units || 0) * (rc.rate || 0));
      return compare(base, charge, expected, tolerance(units),
        `$${fixed.toFixed(2)} per return + ${units || 0} units at $${rc.rate}`);
    }

    default: {
      // per_unit / per_order / per_receipt / per_shipment / per_edit / per_pallet
      if (units === null) {
        return { ...base, verdict: VERDICT.QTY_UNSUPPORTED, expected: null, variance: null,
          detail: `no quantity on the line, so $${rc.rate} per ${rc.uom || 'unit'} cannot be applied` };
      }
      const expected = round2(units * rc.rate);
      return compare(base, charge, expected, tolerance(units),
        `${units} x $${rc.rate} per ${rc.uom || 'unit'}`);
    }
  }
}

function compare(base, charge, expected, tol, detail) {
  const variance = round2(charge - expected);
  if (Math.abs(variance) <= tol) {
    return { ...base, verdict: VERDICT.OK, expected, variance: 0, detail };
  }
  return {
    ...base,
    verdict: variance > 0 ? VERDICT.OVERCHARGE : VERDICT.UNDERCHARGE,
    expected, variance,
    detail: `${detail} = $${expected.toFixed(2)}, charged $${charge.toFixed(2)}`,
  };
}

/** Worst verdict in a set (for rolling a service or an invoice up to one status). */
function worst(verdicts) {
  for (const v of SEVERITY) if (verdicts.includes(v)) return v;
  return VERDICT.OK;
}

module.exports = { rateTable, load, reload, index, rateFor, checkLine, worst, tolerance, VERDICT, SEVERITY };
