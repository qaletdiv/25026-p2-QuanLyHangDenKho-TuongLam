'use strict';

// NRI invoice verification — its OWN tables only, all under data/nri/.
// Reads NOTHING from sms_* / mainline_* / po_* and writes nothing outside this
// folder, so the module is additive to the portal in the same way Landed Costs is.

const BaseModel = require('../../models/BaseModel');

module.exports = {
  // WHICH warehouses bill us. One row per invoicing warehouse (NRI US, NRI CA, …)
  // = one tab under All Invoices. `parser` names the detail-file layout; null means
  // no layout is mapped, so uploads are refused with a reason. See invoiceSources.js.
  sources:     new BaseModel('nri/nri_invoice_sources.json'),

  // Master data (the AGREEMENT and the coding legend — the two validators)
  chargeCodes: new BaseModel('nri/nri_charge_codes.json'),  // Service -> GL + class per entity
  rateCard:    new BaseModel('nri/nri_rate_card.json'),     // effective-dated contracted rates

  // The ORDER MASTER, uploaded through the UI (the `NRI Order data` sheet or a
  // period CSV). It is what supplies channel (OrderType) and ship-to country —
  // neither of which appears anywhere on an invoice line — so the CLASS cannot be
  // derived without it. Held here so coding an invoice never depends on a mapped
  // G: drive; rows carry `entity` because each warehouse has its own order data.
  orderMaster:  new BaseModel('nri/nri_order_master.json'),

  // Loaded invoices
  invoices:    new BaseModel('nri/nri_invoices.json'),      // header + tie-out + rollups
  lines:       new BaseModel('nri/nri_invoice_lines.json'),  // coded + validated detail

  // Per-line human decisions, keyed on (invoice_no, seq) — stable WITHIN an
  // invoice, so loading a new invoice can never renumber an older one's rows.
  // This is what replaces the workbook's positional `Index` override join.
  overrides:   new BaseModel('nri/nri_line_overrides.json'),
};
