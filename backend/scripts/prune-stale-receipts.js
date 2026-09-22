'use strict';

/**
 * prune-stale-receipts.js
 *
 * Removes Item Receipts the portal holds that NetSuite no longer has, for either
 * module. Touches ONLY the receipt tables — no PO/line churn.
 *
 * CAUSE (PO04801, 2026-09-10): both receipt folds were upsert-only. Delete an IR
 * in NetSuite, post a replacement, re-sync, and the portal kept BOTH and summed
 * them as received — PO04801 read 658 against NetSuite's 329, and PO04800 read 352
 * against 200 ordered (the "over-receipt" the SMS report notes cite). Both folds
 * now prune on every sync (utils/pruneStaleReceipts); this script does the cleanup
 * on demand, which matters for mainline because a full PO sync would also
 * renumber every po_order_lines id for nothing.
 *
 * SAFE TO RE-RUN. Read-only against NetSuite. It NEVER removes: a receipt whose PO
 * was not in the query scope, a `source: 'manual'` row (a human's override, which
 * may deliberately point at another PO's IR), or a row with no netsuite_ir_id.
 * A removed row that carried a CONFIRMED match is reported loudly — a confirmation
 * pointing at a deleted IR asserts a receipt that does not exist.
 *
 * Usage:
 *   node --env-file=backend/.env backend/scripts/prune-stale-receipts.js --dry-run
 *   node --env-file=backend/.env backend/scripts/prune-stale-receipts.js --module=mainline
 *   (default --module=both)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const integrationService = require('../services/integrationService');
const { pruneStaleReceipts } = require('../utils/pruneStaleReceipts');
const BaseModel = require('../models/BaseModel');
const { atomically, shutdown } = require('../db/tx');

const DRY_RUN = process.argv.includes('--dry-run');
const MODULE = (process.argv.find((a) => a.startsWith('--module=')) || '--module=both').split('=')[1];

// Goes through BaseModel, NOT straight at the JSON files, so this script edits
// whatever DATA_BACKEND the portal is actually running on. Reading data/ with fs
// after the Postgres migration would operate on the frozen pre-migration
// snapshot and report a clean prune the live portal never received.
const model = (f) => new BaseModel(`migrated/${f}`);
const read = (f) => model(f).read();
const write = (f, data) => model(f).write(data);

// Each module: where its POs live, which receipt tables, and how the sync scopes
// the receipt query (that scope is exactly what may be pruned).
const MODULES = {
  mainline: {
    label: 'mainline',
    posFile: 'po_orders.json',
    receiptsFile: 'mainline_item_receipts.json',
    linesFile: 'mainline_item_receipt_lines.json',
  },
  sms: {
    label: 'SMS',
    posFile: 'sms_pos.json',
    receiptsFile: 'sms_item_receipts.json',
    linesFile: 'sms_item_receipt_lines.json',
  },
};

async function run(cfg) {
  const pos = (await read(cfg.posFile)).filter((p) => p.netsuite_id && p.po_number);
  const receipts = await read(cfg.receiptsFile);
  const lines = await read(cfg.linesFile);
  console.log(`\n=== ${cfg.label} ===`);
  console.log(`POs with a NetSuite id: ${pos.length} | stored receipts: ${receipts.length}`);
  if (!pos.length) { console.log('nothing to ask NetSuite about — skipped'); return; }

  const nsReceipts = await integrationService.fetchNetSuiteItemReceipts(pos.map((p) => p.netsuite_id));
  if (!nsReceipts.length) {
    // Refuse to interpret "no answer" as "everything is deleted".
    console.error('NetSuite returned NO receipts for these POs — treating that as an error, not as "all deleted". Nothing written.');
    process.exitCode = 1;
    return;
  }
  const out = pruneStaleReceipts({
    nsReceipts, queriedPoNumbers: new Set(pos.map((p) => p.po_number)), receipts, receiptLines: lines,
  });
  console.log(`NetSuite has ${nsReceipts.length} | stale here: ${out.removed.length}`);
  out.removed.forEach((r) => console.log(
    `  remove ${r.ir.padEnd(9)} ${r.po_number}${r.was_confirmed ? '   ⚠ CARRIED A CONFIRMED MATCH' : ''}`,
  ));
  if (!out.removed.length) { console.log('already in step with NetSuite. No file written.'); return; }
  console.log(`receipts ${receipts.length} → ${out.receipts.length} | lines ${lines.length} → ${out.receiptLines.length}`);
  if (DRY_RUN) { console.log('--dry-run — nothing written.'); return; }
  // Both tables in ONE transaction: a receipt whose lines were removed but which
  // survived itself (or the reverse) is a state no reader is written for.
  await atomically(async () => {
    await write(cfg.linesFile, out.receiptLines);
    await write(cfg.receiptsFile, out.receipts);
  });
  console.log('Written.');
}

(async () => {
  const targets = MODULE === 'both' ? ['mainline', 'sms'] : [MODULE];
  for (const t of targets) {
    if (!MODULES[t]) { console.error(`unknown --module=${t} (use mainline | sms | both)`); process.exit(1); }
    await run(MODULES[t]);
  }
})().then(shutdown).catch(async (e) => {
  console.error('FAILED:', e.response?.status ?? '', e.message);
  await shutdown();
  process.exit(1);
});
