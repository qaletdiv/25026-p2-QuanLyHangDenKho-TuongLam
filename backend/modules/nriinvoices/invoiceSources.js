'use strict';

// WHICH WAREHOUSES BILL US — the registry behind the All Invoices tabs.
//
// Every 3PL sends a differently-built invoice workbook, so "can we load this
// warehouse's invoices?" is a property of the WAREHOUSE, not of the module. That
// property used to be a hardcoded `if (entity !== 'US') return 400` in the
// controller, which is why adding NRI CA — let alone a third warehouse — meant a
// code change. It is data now.
//
// `parser` is the switch: it names the detail-file layout to read the workbook
// with, and NULL means none is wired, so uploads are refused with a reason
// instead of loading a misread file. A warehouse added through the UI always
// starts that way (registering a warehouse cannot conjure a parser for a format
// nobody has seen) — it gets its tab, its own invoice list and its own slice of
// the legend/rate card, and uploads open when its layout is mapped.
//
// `entity` stays the key the rest of the module already turns on (nri_charge_codes
// `class_us`/`class_ca`, the entity-keyed rate card, `lineClass`, the `nri_<entity>_
// <invoice_no>` id). The registry does not replace that — it just stops the
// controller from hardcoding which entities exist.

const M = require('./NriInvoiceModels');

const arr = (x) => (Array.isArray(x) ? x : []);
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function list() {
  return arr(await M.sources.read().catch(() => []));
}

/** Look one up by URL code (`nri-us`) or by entity (`US`). Returns null if unknown. */
async function find(codeOrEntity) {
  const key = String(codeOrEntity || '').trim().toLowerCase();
  if (!key) return null;
  const rows = await list();
  return rows.find((s) => s.code === key)
    || rows.find((s) => String(s.entity || '').toLowerCase() === key)
    || null;
}

/**
 * Can this warehouse's invoices be uploaded, and if not, WHY? The reason is the
 * whole point: "NRI CA has no verified layout yet" is actionable, a bare 400 is not.
 * @returns {{ok: true, source: object} | {ok: false, status: number, error: string}}
 */
function uploadable(source, codeOrEntity) {
  if (!source) {
    return { ok: false, status: 404, error: `Unknown warehouse "${codeOrEntity}". Check Invoices → the tab strip for the registered ones.` };
  }
  if (!source.parser || !source.upload_enabled) {
    return {
      ok: false,
      status: 400,
      error: `${source.label} has no verified invoice-file layout yet, so uploads are off.`
        + (source.note ? ` ${source.note}` : ' Send a sample invoice workbook to have its format mapped.'),
    };
  }
  return { ok: true, source };
}

module.exports = { list, find, uploadable, slug };
