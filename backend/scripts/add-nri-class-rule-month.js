'use strict';
// Adds nri_class_rules."month" (YYYY-MM, nullable): the SERVICE COLUMNS (Rules step 2)
// become effective by invoice period-end month, like GL Codes. NULL = the base
// columns, used by any month before the first saved one. Order-type and exception
// rules keep month NULL — they apply to every month. No backfill. Idempotent; --dry-run.
require('../src/config/env');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../src/models');
const DRY = process.argv.includes('--dry-run');
(async () => {
    const cols = (await sequelize.query(`SELECT column_name::text AS c FROM information_schema.columns WHERE table_name = 'nri_class_rules'`, { type: QueryTypes.SELECT })).map((r) => r.c);
    if (cols.includes('month')) { console.log('  = "month" present\n\nNothing to do. (idempotent — already applied)'); return; }
    console.log('  + nri_class_rules."month" TEXT (nullable)');
    if (DRY) { console.log('\n--dry-run — nothing written.'); return; }
    await sequelize.query(`ALTER TABLE nri_class_rules ADD COLUMN "month" TEXT`);
    const [{ n }] = await sequelize.query('SELECT COUNT(*)::int AS n FROM nri_class_rules', { type: QueryTypes.SELECT });
    console.log(`  added; ${n} rules untouched (month NULL = every month)`);
})().then(() => sequelize.close()).catch(async (e) => { console.error(e); await sequelize.close(); process.exit(1); });
