'use strict';

/**
 * fix-mainline-status-ids.js
 *
 * Backfills mainline records that were stamped with SMS status ids.
 *
 * CAUSE: modules/mainline/statuses.js built its name→id map over ALL rows of the
 * shared `statuses` table, keyed on name alone. Six names exist in both modules
 * (Booking Pending, Booking Approved, Rejected, In Transit, Delivered, Cancelled),
 * so the later (SMS) row won and every mainline write through idForName() stored an
 * SMS id. Fixed by scoping both maps to module='mainline'; this script repairs the
 * rows already written.
 *
 * SAFE TO RE-RUN. Translation is by NAME — a row holding an SMS id is mapped to the
 * mainline id carrying the same display name — so the visible status never changes,
 * only the id becomes module-correct. Rows already correct are left untouched.
 *
 * Refuses to guess: if a name has no mainline equivalent, or the mainline row's
 * category does not fit the table (a booking status on a shipment row), the script
 * reports and exits WITHOUT writing.
 *
 * Usage:
 *   node backend/scripts/fix-mainline-status-ids.js --dry-run   # preview only
 *   node backend/scripts/fix-mainline-status-ids.js             # apply
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const DATA = path.resolve(__dirname, '../data/migrated');

// table file → { field, categories that are valid for this table }
const TARGETS = [
  { file: 'mainline_bookings.json',  field: 'booking_status_id', ok: ['booking', 'both'] },
  { file: 'mainline_shipments.json', field: 'status_id',         ok: ['shipment', 'both'] },
];

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function writeAtomic(p, data) {
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function main() {
  const statuses = readJson(path.join(DATA, 'statuses.json'));
  const byId = new Map(statuses.map((s) => [s.id, s]));
  // mainline name → row. Names are unique within mainline, asserted below.
  const mainlineByName = new Map();
  for (const s of statuses.filter((s) => s.module === 'mainline')) {
    if (mainlineByName.has(s.name)) {
      console.error(`ERROR: mainline status name '${s.name}' is not unique — cannot map by name.`);
      process.exit(1);
    }
    mainlineByName.set(s.name, s);
  }

  const plan = [];
  const problems = [];

  for (const { file, field, ok } of TARGETS) {
    const p = path.join(DATA, file);
    if (!fs.existsSync(p)) { console.log(`skip ${file} (not present)`); continue; }
    const rows = readJson(p);
    if (!Array.isArray(rows)) { problems.push(`${file} is not a JSON array`); continue; }

    for (const row of rows) {
      const cur = row[field];
      if (cur == null) continue;
      const curRow = byId.get(cur);

      if (!curRow) { problems.push(`${file} id=${row.id}: unknown status id '${cur}'`); continue; }
      if (curRow.module === 'mainline') continue;                       // already correct

      const target = mainlineByName.get(curRow.name);
      if (!target) {
        problems.push(`${file} id=${row.id}: '${cur}' is "${curRow.name}", which has no mainline equivalent`);
        continue;
      }
      if (!ok.includes(target.category)) {
        problems.push(
          `${file} id=${row.id}: "${curRow.name}" maps to ${target.id} (category '${target.category}'), ` +
          `not valid for this table (expected ${ok.join('|')})`
        );
        continue;
      }
      plan.push({ file, field, rowId: row.id, from: cur, to: target.id, name: curRow.name, row });
    }
  }

  if (problems.length) {
    console.error('REFUSING TO WRITE — unresolved cases:');
    problems.forEach((p) => console.error('  ' + p));
    process.exit(1);
  }

  if (!plan.length) {
    console.log('Nothing to fix — every mainline status id is already module-correct.');
    return;
  }

  console.log(`${DRY_RUN ? '[DRY RUN] Would update' : 'Updating'} ${plan.length} value(s):`);
  for (const c of plan) {
    console.log(`  ${c.file} id=${c.rowId}  ${c.field}: ${c.from} -> ${c.to}   ("${c.name}" unchanged)`);
  }

  if (DRY_RUN) { console.log('[DRY RUN] No files were written.'); return; }

  // group by file so each file is written once, atomically
  const touched = new Map();
  for (const c of plan) {
    c.row[c.field] = c.to;
    if (!touched.has(c.file)) touched.set(c.file, readJson(path.join(DATA, c.file)));
  }
  // re-apply against a fresh read so we write whole, current files
  for (const [file, rows] of touched) {
    const changes = plan.filter((c) => c.file === file);
    for (const c of changes) {
      const target = rows.find((r) => String(r.id) === String(c.rowId));
      if (target) target[c.field] = c.to;
    }
    writeAtomic(path.join(DATA, file), rows);
    console.log(`  wrote ${file}`);
  }

  console.log('\nDone. Display names are unchanged; only the stored ids are now module-correct.');
}

main();
