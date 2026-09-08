'use strict';
/**
 * Charge-code coder — the workbook's `Service` -> (GL, Class) join, as data.
 *
 * Reproduces the Power Query step
 *   Table.NestedJoin(NRI_Invoices, {"Service"}, #"NRI Invoice Coding", {"Service"}, LeftOuter)
 * but fixes four defects that make the original unsafe:
 *
 *  1. `EDI Transmission` appears TWICE in the legend (once with a trailing space).
 *     NestedJoin + Expand MULTIPLIES rows on duplicate keys, so if both ever
 *     matched the same value the charge would silently DOUBLE. Here the key is
 *     unique by construction and a duplicate is reported, never joined twice.
 *  2. `"Recoverable Materials "` and `"EDI Transmission "` carry trailing spaces.
 *     The M join is exact-match, so they only resolve because NRI's file happens
 *     to carry the same trailing space. Matching is normalised here instead.
 *  3. `Warehouse Labor` -> GL 5211 but `Warehouse Labour` -> GL 5204. Same service,
 *     two spellings, two different accounts. Aliases collapse them.
 *  4. A LeftOuter miss yields a NULL GL, which the pivots render as GL 0. Here an
 *     unmapped service returns status `needs_coding` and never a GL.
 *
 * Class is entity-aware: the legend's `Class` column is US and
 * `Class (NRI CAN)` is CA — the CA workbook keeps its own diverged copy, which is
 * why both live in one table here.
 */

const BaseModel = require('../../models/BaseModel');

const codesTable = new BaseModel('nri/nri_charge_codes.json');

const norm = v => (v === undefined || v === null ? '' : String(v).trim());
/** Match key: trimmed, case-folded, inner whitespace collapsed. */
const key = v => norm(v).toUpperCase().replace(/\s+/g, ' ');

/**
 * Spelling variants NRI uses for the same service. Left = alias, right = the
 * canonical service the legend is keyed on.
 */
const ALIASES = Object.freeze({
  'WAREHOUSE LABOUR': 'Warehouse Labor',
  'OVERTIME LABOUR': 'Overtime',
});

let cache = null;

/** Load + index the legend. `reload()` clears the cache after a re-sync. */
async function load() {
  if (cache) return cache;
  const rows = await codesTable.read().catch(() => []);
  const list = Array.isArray(rows) ? rows : [];

  const byKey = new Map();
  const duplicates = [];
  for (const r of list) {
    const k = key(r.service);
    if (!k) continue;
    if (byKey.has(k)) { duplicates.push(r.service); continue; }
    byKey.set(k, r);
  }
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    const target = byKey.get(key(canonical));
    if (target && !byKey.has(alias)) byKey.set(alias, target);
  }

  cache = { list, byKey, duplicates };
  return cache;
}

function reload() { cache = null; }

/**
 * Code one line. Always returns an object — an unmapped service yields
 * `status: 'needs_coding'` with a null GL rather than a silent zero.
 */
function code(index, service, entity) {
  const row = index.byKey.get(key(service));
  const ent = norm(entity).toUpperCase() === 'CA' ? 'CA' : 'US';

  if (!row) {
    return {
      service: norm(service), gl: null, gl_desc: null, class: null,
      status: 'needs_coding',
      reason: `service "${norm(service)}" is not in the coding legend`,
    };
  }

  const cls = ent === 'CA' ? row.class_ca : row.class_us;
  if (!norm(cls)) {
    return {
      service: norm(service), gl: row.gl, gl_desc: row.gl_desc, class: null,
      status: 'needs_coding',
      reason: `legend has no ${ent} class for "${row.service}"`,
    };
  }

  return {
    service: norm(service), gl: row.gl, gl_desc: row.gl_desc, class: norm(cls),
    status: 'coded', reason: null, note: row.note || null,
  };
}

module.exports = { codesTable, load, reload, code, key, ALIASES };
