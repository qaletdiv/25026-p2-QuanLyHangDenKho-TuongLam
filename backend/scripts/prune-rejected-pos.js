'use strict';

/**
 * prune-rejected-pos.js
 *
 * Removes mainline POs that NetSuite has REJECTED from the three NetSuite-owned
 * grains (po_masters / po_orders / po_order_lines).
 *
 * CAUSE: the mainline sync scoped POs with `t.status IN ('A','B','C')`, described
 * in a comment as "Pending Receipt / Partially Received / Pending Billing" — a
 * legend that was already known to be wrong. Verified against production
 * 2026-09-08, 'C' is **Rejected by Supervisor**, so the "active only" filter was
 * pulling rejected POs in as live ones (PO03521, PO03789), and buildUpserts never
 * looked at approval_status either. Both holes are closed
 * (integrationService.poStatusClause + NOT_REJECTED_CLAUSE, and R4 in
 * netsuiteSyncService.buildUpserts), and the sync now prunes on every run — this
 * script exists to do the cleanup on demand, without a full sync.
 *
 * SAFE TO RE-RUN. It asks NetSuite which of the POs the portal holds are rejected
 * (read-only SuiteQL) and deletes only those, plus their lines, plus a TRN master
 * whose LAST PO just went.
 *
 * REFUSES to delete a PO anything points at — a leg, a booking, a shipment or an
 * Item Receipt. That combination (rejected in NetSuite, yet booked here) is a real
 * contradiction for a human to resolve; the script reports it and leaves it alone.
 *
 * Usage:
 *   node backend/scripts/prune-rejected-pos.js --dry-run   # preview only
 *   node backend/scripts/prune-rejected-pos.js             # apply
 *
 * Needs the NetSuite credentials from backend/.env:
 *   node --env-file=backend/.env backend/scripts/prune-rejected-pos.js --dry-run
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const integrationService = require('../services/integrationService');
const { pruneRejected, computeReferenced } = require('../modules/po/netsuiteSyncService');
const BaseModel = require('../models/BaseModel');
const { atomically, shutdown } = require('../db/tx');

const DRY_RUN = process.argv.includes('--dry-run');

// Through BaseModel, NOT straight at the JSON files, so this edits whatever
// DATA_BACKEND the portal is running on. Reading data/ with fs after the
// Postgres migration would prune the frozen pre-migration snapshot and report a
// cleanup the live portal never received.
const model = (f) => new BaseModel(`migrated/${f}`);
const readJson = (f) => model(f).read();
const write = (f, data) => model(f).write(data);

async function main() {
  const masters = await readJson('po_masters.json');
  const orders = await readJson('po_orders.json');
  const orderLines = await readJson('po_order_lines.json');

  const held = orders.map((o) => o.po_number).filter(Boolean);
  console.log(`Portal holds ${held.length} mainline POs — asking NetSuite which are rejected…`);
  const rejected = await integrationService.fetchRejectedPoTranids(held);
  if (!rejected.size) {
    console.log('No rejected POs in the portal. Nothing to do.');
    return;
  }
  console.log(`NetSuite reports ${rejected.size} rejected: ${[...rejected].join(', ')}`);

  const referenced = await computeReferenced();
  const result = pruneRejected({
    rejectedPoNumbers: rejected, masters, orders, orderLines, referencedPoNumbers: referenced,
  });

  for (const po of result.removed.po_numbers) {
    const o = orders.find((r) => r.po_number === po);
    const lines = orderLines.filter((l) => l.po_number === po).length;
    console.log(`  remove ${po}  (TRN ${o?.trn_number ?? '—'}, ${lines} line${lines === 1 ? '' : 's'})`);
  }
  for (const po of result.kept_referenced) {
    console.log(`  KEEP   ${po}  — rejected in NetSuite but referenced here (leg / booking / shipment / receipt). Resolve by hand.`);
  }
  console.log(`\nRows: orders ${orders.length} → ${result.orders.length}, `
    + `lines ${orderLines.length} → ${result.orderLines.length}, `
    + `masters ${masters.length} → ${result.masters.length}`
    + (result.removed.trns.length ? ` (TRNs dropped: ${result.removed.trns.join(', ')})` : ''));

  if (!result.removed.po_numbers.length) {
    console.log('\nNothing removable (all rejected POs are referenced). No files written.');
    return;
  }
  if (DRY_RUN) {
    console.log('\n--dry-run — no files written.');
    return;
  }
  // One transaction: a PO removed while its lines survive (or a master left
  // without its last PO) is a hierarchy no reader is written for.
  await atomically(async () => {
    await write('po_order_lines.json', result.orderLines);
    await write('po_orders.json', result.orders);
    await write('po_masters.json', result.masters);
  });
  console.log('\nWritten.');
}

main().then(shutdown).catch(async (e) => {
  console.error('FAILED:', e.response?.status ?? '', e.message);
  await shutdown();
  process.exit(1);
});
