'use strict';

// NRI invoice verification — its OWN tables only, all under data/nri/.
// Reads NOTHING from sms_* / mainline_* / po_* and writes nothing outside this
// folder, so the module is additive to the portal in the same way Landed Costs is.

const BaseModel = require('../../models/BaseModel');

module.exports = {
  // Master data (the AGREEMENT and the coding legend — the two validators)
  chargeCodes: new BaseModel('nri/nri_charge_codes.json'),  // Service -> GL + class per entity
  rateCard:    new BaseModel('nri/nri_rate_card.json'),     // effective-dated contracted rates

  // Loaded invoices
  invoices:    new BaseModel('nri/nri_invoices.json'),      // header + tie-out + rollups
  lines:       new BaseModel('nri/nri_invoice_lines.json'),  // coded + validated detail

  // Per-line human decisions, keyed on (invoice_no, seq) — stable WITHIN an
  // invoice, so loading a new invoice can never renumber an older one's rows.
  // This is what replaces the workbook's positional `Index` override join.
  overrides:   new BaseModel('nri/nri_line_overrides.json'),
};
