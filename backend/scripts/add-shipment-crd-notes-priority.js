'use strict';
// Adds three columns to mainline_shipments:
//   cargoReadyDate  DATE     — the REVISED cargo ready date (the forwarder's)
//   notes           TEXT     — free-text operational note
//   priority        BOOLEAN  — "needs attention", Admin/Logistics only
//
// Idempotent. `--dry-run` reports without writing. Safe to re-run.
//
// ⚠️ IDENTIFIERS ARE QUOTED. Postgres folds unquoted names to lowercase, so
// ALTER TABLE ... ADD "cargoReadyDate" without quotes creates `cargoreadydate`
// and every Sequelize read of the attribute comes back undefined — silently.
// See the camelCase note in CLAUDE.md.
//
// cargoReadyDate is left NULL on existing rows rather than backfilled from the
// booking: a revised date is something a forwarder asserts, and inventing one for
// 11 historical consignments would put a number nobody typed next to their name.
// The UI falls back to showing the booked/PO date when this is null.

require('dotenv').config({ quiet: true });
const { sequelize } = require('../models');

const DRY = process.argv.includes('--dry-run');

const COLUMNS = [
  { name: 'cargoReadyDate', ddl: 'DATE' },
  { name: 'notes', ddl: 'TEXT' },
  { name: 'priority', ddl: 'BOOLEAN DEFAULT FALSE' },
];

async function main() {
  const [existing] = await sequelize.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'mainline_shipments'`,
  );
  const have = new Set(existing.map((r) => r.column_name));
  const [cnt] = await sequelize.query(`SELECT COUNT(*)::int AS count FROM mainline_shipments`);
  console.log(`mainline_shipments: ${cnt[0].count} rows, ${have.size} columns`);
  const todo = COLUMNS.filter((c) => !have.has(c.name));
  const already = COLUMNS.filter((c) => have.has(c.name));
  already.forEach((c) => console.log(`  = ${c.name} already present — skipping`));

  if (!todo.length) {
    console.log('\nNothing to do. (idempotent — already applied)');
    return;
  }
  todo.forEach((c) => console.log(`  + ${c.name} ${c.ddl}`));

  if (DRY) {
    console.log('\n--dry-run — nothing written.');
    return;
  }

  await sequelize.transaction(async (t) => {
    for (const c of todo) {
      // quoted identifier — see the banner above
      await sequelize.query(
        `ALTER TABLE mainline_shipments ADD COLUMN "${c.name}" ${c.ddl}`,
        { transaction: t },
      );
      console.log(`  added ${c.name}`);
    }
    // priority is a flag, not a tri-state: NULL would make every filter and
    // every `!priority` test ambiguous, so existing rows get an explicit false.
    if (todo.some((c) => c.name === 'priority')) {
      const [, meta] = await sequelize.query(
        `UPDATE mainline_shipments SET "priority" = FALSE WHERE "priority" IS NULL`,
        { transaction: t },
      );
      console.log(`  backfilled priority=false on ${meta?.rowCount ?? 0} row(s)`);
    }
  });

  // prove it landed and that the existing data is untouched
  const [after] = await sequelize.query(
    `SELECT COUNT(*)::int AS rows,
            COUNT("cargoReadyDate")::int AS with_crd,
            COUNT("notes")::int AS with_notes,
            COUNT(*) FILTER (WHERE "priority") ::int AS flagged,
            COUNT(*) FILTER (WHERE "priority" IS NULL)::int AS priority_null
       FROM mainline_shipments`,
  );
  console.log('\nafter:', JSON.stringify(after[0]));
  console.log('done.');
}

main()
  .then(() => sequelize.close())
  .catch(async (e) => { console.error('FAILED:', e.message); await sequelize.close(); process.exit(1); });
