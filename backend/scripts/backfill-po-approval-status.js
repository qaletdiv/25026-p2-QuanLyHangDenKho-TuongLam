'use strict';

/**
 * backfill-po-approval-status.js
 *
 * Fills `po_orders.approval_status` from NetSuite for the POs the portal already
 * holds, so the "Pending approval" badge works before the next sync.
 *
 * The column is new (2026-09-09). The sync writes and refreshes it from now on
 * (netsuiteSyncService: fold + the post-fold refresh over every held PO), but
 * existing rows have nothing in them — and running a full sync just to populate
 * one field would also renumber all ~12k po_order_lines ids, which is unrelated
 * churn. This touches po_orders and nothing else.
 *
 * SAFE TO RE-RUN. Read-only against NetSuite; writes only rows whose value
 * actually changes, and reports what it would do with --dry-run.
 *
 * Usage:
 *   node --env-file=backend/.env backend/scripts/backfill-po-approval-status.js --dry-run
 *   node --env-file=backend/.env backend/scripts/backfill-po-approval-status.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const integrationService = require('../services/integrationService');

const BaseModel = require('../models/BaseModel');
const { shutdown } = require('../db/tx');

const DRY_RUN = process.argv.includes('--dry-run');

// Through BaseModel, NOT straight at the JSON file, so this edits whatever
// DATA_BACKEND the portal is running on. Reading data/ with fs after the
// Postgres migration would backfill the frozen pre-migration snapshot and
// report an update the live portal never received.
const PoOrders = new BaseModel('migrated/po_orders.json');

async function main() {
  const orders = await PoOrders.read();
  const held = orders.map((o) => o.po_number).filter(Boolean);
  console.log(`Portal holds ${held.length} mainline POs — reading approval status from NetSuite…`);

  const statuses = await integrationService.fetchPoApprovalStatuses(held);
  if (!statuses.size) {
    console.error('NetSuite returned nothing (credentials missing, or the query failed). Nothing written.');
    process.exitCode = 1;
    return;
  }

  const changes = [];
  const missing = [];
  for (const o of orders) {
    const ns = statuses.get(o.po_number);
    if (!ns) { missing.push(o.po_number); continue; }
    const next = ns.approval || null;
    if ((o.approval_status ?? null) !== next) {
      changes.push({ po: o.po_number, from: o.approval_status ?? null, to: next });
      o.approval_status = next;
    }
  }

  const counts = {};
  statuses.forEach((v) => { const k = v.approval || '(none)'; counts[k] = (counts[k] || 0) + 1; });
  console.log('NetSuite says:', Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(' · '));
  console.log(`Rows to update: ${changes.length}`);
  changes.slice(0, 20).forEach((c) => console.log(`  ${c.po}: ${c.from ?? '—'} → ${c.to ?? '—'}`));
  if (changes.length > 20) console.log(`  … and ${changes.length - 20} more`);
  if (missing.length) console.log(`NOT found in NetSuite (left untouched): ${missing.join(', ')}`);

  if (!changes.length) { console.log('\nAlready up to date. No file written.'); return; }
  if (DRY_RUN) { console.log('\n--dry-run — no file written.'); return; }
  await PoOrders.write(orders);
  console.log('\nWritten.');
}

main().then(shutdown).catch(async (e) => {
  console.error('FAILED:', e.response?.status ?? '', e.message);
  await shutdown();
  process.exit(1);
});
