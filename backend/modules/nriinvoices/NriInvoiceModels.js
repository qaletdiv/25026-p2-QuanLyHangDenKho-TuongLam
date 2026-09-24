'use strict';

// NRI invoice verification — its OWN tables only, all under data/nri/.
// Reads NOTHING from sms_* / mainline_* / po_* and writes nothing outside this
// folder, so the module is additive to the portal in the same way Landed Costs is.

const { models } = require('../../models');

module.exports = {
  // WHICH warehouses bill us. One row per invoicing warehouse (NRI US, NRI CA, …)
  // = one tab under All Invoices. `parser` names the detail-file layout; null means
  // no layout is mapped, so uploads are refused with a reason. See invoiceSources.js.
  sources:     models.nri_invoice_sources,

  // Master data (the AGREEMENT and the coding legend — the two validators)
  chargeCodes: models.nri_charge_codes,  // Service -> GL + class per entity
  rateCard:    models.nri_rate_card,     // effective-dated contracted rates

  // The ORDER MASTER, uploaded through the UI (the `NRI Order data` sheet or a
  // period CSV). It is what supplies channel (OrderType) and ship-to country —
  // neither of which appears anywhere on an invoice line — so the CLASS cannot be
  // derived without it. Held here so coding an invoice never depends on a mapped
  // G: drive; rows carry `entity` because each warehouse has its own order data.
  orderMaster:  models.nri_order_master,

  // Loaded invoices
  invoices:    models.nri_invoices,      // header + tie-out + rollups
  lines:       models.nri_invoice_lines,  // coded + validated detail

  // Per-line human decisions, keyed on (invoiceNo, seq) — stable WITHIN an
  // invoice, so loading a new invoice can never renumber an older one's rows.
  // This is what replaces the workbook's positional `Index` override join.
  overrides:   models.nri_line_overrides,
};
