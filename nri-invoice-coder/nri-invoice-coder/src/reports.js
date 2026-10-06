// Replaces the pivot tables in "Pivot" and "Unit Rates".
import { round2 } from './io.js';

// Generic pivot: rows grouped by rowKeys, columns by colKey (optional), summing valueField.
export function pivot(lines, { rows, col = null, value = 'charges' }) {
  const colSet = new Set();
  const map = new Map();
  for (const l of lines) {
    const rk = rows.map((k) => l[k] ?? '(blank)');
    const key = JSON.stringify(rk);
    if (!map.has(key)) map.set(key, { keys: rk, cells: {}, total: 0 });
    const g = map.get(key);
    const c = col ? (l[col] ?? '(blank)') : null;
    const v = l[value] || 0;
    if (c !== null) { colSet.add(c); g.cells[c] = (g.cells[c] || 0) + v; }
    g.total += v;
  }
  const columns = [...colSet].sort();
  const body = [...map.values()]
    .sort((a, b) => String(a.keys).localeCompare(String(b.keys), undefined, { numeric: true }))
    .map((g) => {
      const o = {};
      rows.forEach((k, i) => (o[k] = g.keys[i]));
      for (const c of columns) o[c] = g.cells[c] !== undefined ? round2(g.cells[c]) : null;
      o['Grand Total'] = round2(g.total);
      return o;
    });
  const grand = { [rows[0]]: 'Grand Total' };
  for (const c of columns) grand[c] = round2(body.reduce((s, r) => s + (r[c] || 0), 0));
  grand['Grand Total'] = round2(body.reduce((s, r) => s + r['Grand Total'], 0));
  return { columns: [...rows, ...columns, 'Grand Total'], rows: [...body, grand] };
}

// Pivot 1: Sum of Charges — Revised GL × Revised Class
export const glByClass = (lines) =>
  pivot(lines, { rows: ['revisedGl', 'revisedGlDesc'], col: 'revisedClass', value: 'charges' });

// Pivot 2/3: Sum of Charges — GL / Service × invoice file
export const serviceByInvoice = (lines) =>
  pivot(lines, { rows: ['revisedGl', 'revisedGlDesc', 'service'], col: 'source', value: 'charges' });

// Unit Rates pivot: Sum of Inv. Amt — GL Desc / Service
export const glByServiceInvAmt = (lines) =>
  pivot(lines, { rows: ['revisedGlDesc', 'service'], value: 'invAmt' });

// Unit Rates monthly pivots (charges, inv amt, units, unit rate) — GL Desc × Class × Month
export function monthlyUnitRates(lines) {
  const map = new Map();
  for (const l of lines) {
    const k = [l.revisedGlDesc, l.revisedClass, l.monthKey].join('||');
    if (!map.has(k)) map.set(k, { glDesc: l.revisedGlDesc, cls: l.revisedClass, monthKey: l.monthKey, month: l.month, charges: 0, invAmt: 0, units: 0 });
    const g = map.get(k);
    g.charges += l.charges; g.invAmt += l.invAmt; g.units += l.units;
  }
  return [...map.values()]
    .sort((a, b) => `${a.glDesc}${a.cls}${a.monthKey}`.localeCompare(`${b.glDesc}${b.cls}${b.monthKey}`))
    .map((g) => ({
      'GL Desc': g.glDesc, Class: g.cls, Month: g.month,
      Charges: round2(g.charges), 'Inv. Amt': round2(g.invAmt), Units: g.units,
      'Unit Rate': g.units ? Math.round((g.charges / g.units) * 10000) / 10000 : null, // no #DIV/0!
    }));
}

// "Unit Rates" top table: effective rate = (fixed + perUnit × avgUPT) / avgUPT
export function contractUnitRates(cfg) {
  const fulfillment = cfg.fulfillment.map((r) => ({
    ...r,
    unitRate: Math.round(((r.fixedFee + r.feePerUnit * r.avgUPT) / r.avgUPT) * 10000) / 10000,
  }));
  const tiers = Object.values(cfg.storage.tiers);
  const storageAvg = Math.round((tiers.reduce((a, b) => a + b, 0) / tiers.length) * 10000) / 10000;
  return { fulfillment, storage: { ...cfg.storage, avg: storageAvg } };
}

export const exceptions = (lines) => lines.filter((l) => l.flags.length);
