'use strict';

// POST /po/sync/netsuite (Phase 2a) — Admin only.
// Pulls mainline POs from NetSuite and upserts po_masters/po_orders/po_order_lines,
// honoring R1 (skip locked-by-booking orders). Degrades gracefully when NetSuite
// credentials are absent (integrationService returns [] → 0 upserts).

const netsuiteSyncService = require('./netsuiteSyncService');

async function syncNetSuite(req, res) {
  const result = await netsuiteSyncService.sync();
  res.json({ ok: true, source: 'netsuite', ...result });
}

module.exports = { syncNetSuite };
