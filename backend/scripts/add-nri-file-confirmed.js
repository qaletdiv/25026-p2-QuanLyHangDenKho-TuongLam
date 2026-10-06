'use strict';
// Adds nri_billing_files."confirmedAt" / ."confirmedBy": an uploaded invoice is
// REVIEWED (services → channel + GL confirmed for its month) before its Cost per GL
// is relied on. Nullable, no backfill (nothing was reviewed before). Idempotent; --dry-run.
require('../src/config/env');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../src/models');
const DRY = process.argv.includes('--dry-run');
(async () => {
    const have = new Set((await sequelize.query(`SELECT column_name::text AS c FROM information_schema.columns WHERE table_name = 'nri_billing_files'`, { type: QueryTypes.SELECT })).map((r) => r.c));
    const todo = ['confirmedAt', 'confirmedBy'].filter((c) => !have.has(c));
    if (!todo.length) { console.log('Nothing to do. (idempotent — already applied)'); return; }
    todo.forEach((c) => console.log(`  + ${c} TEXT`));
    if (DRY) { console.log('\n--dry-run — nothing written.'); return; }
    for (const c of todo) await sequelize.query(`ALTER TABLE nri_billing_files ADD COLUMN "${c}" TEXT`);
    console.log('  added');
})().then(() => sequelize.close()).catch(async (e) => { console.error(e); await sequelize.close(); process.exit(1); });
