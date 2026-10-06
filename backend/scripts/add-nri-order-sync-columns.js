'use strict';
// Adds nri_order_master."salesChannel", ."source", ."recordType" and ."altRef" for the NetSuite Item
// Fulfillment + Return Authorization pull (src/lib/nriOrderSync.js). All nullable, no backfill: rows
// that came from an uploaded file genuinely have neither. Idempotent; `--dry-run`.
//
// ⚠️ Identifiers are QUOTED (camelCase — see CLAUDE.md), and the existence check
// casts column_name to text (information_schema's sql_identifier comes back as an
// array through this codebase's type parsers).

require('../src/config/env');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../src/models');

const DRY = process.argv.includes('--dry-run');
const COLUMNS = ['salesChannel', 'source', 'recordType', 'altRef'];

async function main() {
    const have = new Set((await sequelize.query(
        `SELECT column_name::text AS c FROM information_schema.columns WHERE table_name = 'nri_order_master'`,
        { type: QueryTypes.SELECT },
    )).map((r) => r.c));
    const todo = COLUMNS.filter((c) => !have.has(c));
    COLUMNS.filter((c) => have.has(c)).forEach((c) => console.log(`  = ${c} present`));
    todo.forEach((c) => console.log(`  + ${c} TEXT`));
    if (!todo.length) { console.log('\nNothing to do. (idempotent — already applied)'); return; }
    if (DRY) { console.log('\n--dry-run — nothing written.'); return; }
    await sequelize.transaction(async (t) => {
        for (const c of todo) await sequelize.query(`ALTER TABLE nri_order_master ADD COLUMN "${c}" TEXT`, { transaction: t });
    });
    const [{ n }] = await sequelize.query(`SELECT COUNT(*)::int AS n FROM nri_order_master`, { type: QueryTypes.SELECT });
    console.log(`\n  added ${todo.length} column(s); nri_order_master still holds ${n} rows`);
}

main().then(() => sequelize.close()).catch(async (e) => { console.error(e); await sequelize.close(); process.exit(1); });
