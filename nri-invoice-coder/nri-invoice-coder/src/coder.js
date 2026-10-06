// Replaces the Summary_Coded table logic:
//   Netsuite GL / Description / Class (NRI CAN)  <- merge Service with "NRI Invoice Coding"
//   Revised Class    = IF(ISBLANK(Manual Class Override), Class (NRI CAN), Manual Class Override)
//   Revised GL Code  = IF(ISBLANK(Manual GL Override), Netsuite GL, Manual GL Override)
//   Revised GL Desc  = override ? XLOOKUP(override GL, coding GL, coding Desc) : Description
//   MMM-YYYY         = TEXT(Completed, "mmm-yyyy")
//   Order Type       = VLOOKUP(Client Ref 1, 'NRI Order data'!A:J, 10, FALSE)
// Added on top of Excel: auto class rules for NEW invoice files (locked files untouched) + exception flags.
import { toNumber, toDate, monthLabel, monthKey, round2 } from './io.js';

export const overrideKey = (source, orderId, service) =>
  `${source}|${String(orderId ?? '').trim()}|${String(service ?? '').trim()}`;

export function buildCoder({ coding, orders = [], overrides = [], rules = [], lockedSources = [] }) {
  const locked = new Set(lockedSources); // already booked in NetSuite -> never auto-recode
  const byService = new Map();
  const glDesc = new Map();
  for (const c of coding) {
    if (!byService.has(c.service)) byService.set(c.service, c);   // first match, like VLOOKUP
    if (!glDesc.has(c.gl)) glDesc.set(c.gl, c.description);         // first match, like XLOOKUP
  }

  const orderType = new Map();
  for (const o of orders) {
    const k = String(o['Order #'] ?? '').trim();
    if (k && !orderType.has(k)) orderType.set(k, o['OrderType'] ?? null);
  }

  const ov = new Map();
  for (const o of overrides) {
    ov.set(overrideKey(o.source, o.orderId, o.service), {
      cls: o.classOverride || null,
      gl: o.glOverride ? Number(o.glOverride) : null,
    });
  }

  const activeRules = rules.filter((r) => r.enabled !== false);
  // when: { field: ["exact", ...] }  or  { field: { startsWith: [...], contains: [...] } } (case-insensitive)
  const test = (cond, val) => {
    if (Array.isArray(cond)) return cond.includes(val);
    const v = String(val ?? '').toLowerCase();
    return (cond.startsWith ?? []).some((p) => v.startsWith(p.toLowerCase()))
        || (cond.contains ?? []).some((p) => v.includes(p.toLowerCase()));
  };
  const matches = (when, ctx) => Object.entries(when).every(([f, cond]) => test(cond, ctx[f]));

  return function codeLine(raw) {
    const service = String(raw['Service'] ?? '').trim();
    const source = raw['Source.Name'];
    const orderId = String(raw['OrderID'] ?? '').trim();
    const clientRef1 = String(raw['Client Ref 1'] ?? '').trim();
    const completed = toDate(raw['Completed']);
    const charges = toNumber(raw['Charges']);
    const taxes = toNumber(raw['Taxes']);
    const invAmt = toNumber(raw['Inv. Amt']);

    const map = byService.get(service);
    const ot = clientRef1 ? orderType.get(clientRef1) ?? null : null;
    const manual = ov.get(overrideKey(source, orderId, service));

    // Class: manual override > first matching rule > coding default
    let cls = map?.class ?? null;
    let classSource = map ? 'coding' : 'unmapped';
    let gl = map?.gl ?? null;
    let glSource = map ? 'coding' : 'unmapped';

    if (manual?.cls) { cls = manual.cls; classSource = 'manual'; }
    else if (!locked.has(source)) {
      const ctx = { service, orderType: ot, source, clientRef1, customer: raw['Customer'] ?? '' };
      const rule = activeRules.find((r) => matches(r.when, ctx));
      if (rule?.set?.class) { cls = rule.set.class; classSource = `rule:${rule.name}`; }
      if (rule?.set?.gl && !manual?.gl) { gl = rule.set.gl; glSource = `rule:${rule.name}`; }
    }
    if (manual?.gl) { gl = manual.gl; glSource = 'manual'; }

    const flags = [];
    if (!map) flags.push('UNMAPPED_SERVICE');
    if (!completed) flags.push('NO_COMPLETED_DATE');
    if (Math.abs(round2(charges + taxes) - invAmt) > 0.01) flags.push('TOTAL_MISMATCH');
    if (gl && !glDesc.has(gl)) flags.push('UNKNOWN_GL');

    return {
      source,
      orderId,
      clientRef1,
      clientRef2: raw['Client Ref 2'] ?? '',
      customer: raw['Customer'] ?? '',
      poNumber: raw['PO Number'] ?? '',
      docDate: toDate(raw['Doc. Date']),
      completed,
      units: toNumber(raw['Units']),
      value: toNumber(raw['Value']),
      service,
      charges,
      taxes,
      invAmt,
      netsuiteGl: map?.gl ?? null,
      description: map?.description ?? null,
      defaultClass: map?.class ?? null,
      classOverride: manual?.cls ?? null,
      glOverride: manual?.gl ?? null,
      revisedClass: cls,
      revisedGl: gl,
      revisedGlDesc: gl ? glDesc.get(gl) ?? null : null,
      month: monthLabel(completed),
      monthKey: monthKey(completed),
      orderType: ot,
      classSource,
      glSource,
      flags,
    };
  };
}

// Power Query combine artifacts: repeated header rows and blank rows.
export const isJunkRow = (r) => {
  const s = String(r['Service'] ?? '').trim();
  return !s || s === 'Service';
};
