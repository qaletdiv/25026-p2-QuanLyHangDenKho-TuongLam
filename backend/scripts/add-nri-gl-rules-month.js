'use strict';
// nri_gl_rules gains "month" (YYYY-MM): GL settings become effective by invoice
// period-end month (see models/NriGlRules.js). The table had no rows when this was
// written, so it is REBUILT from the model — and the script REFUSES if it holds any
// row, because rebuilding would drop them. Idempotent; `--dry-run`.

require('../src/config/env');
const { QueryTypes } = require('sequelize');
const { models, sequelize } = require('../src/models');

const DRY = process.argv.includes('--dry-run');

async function main() {
    const cols = (await sequelize.query(
        `SELECT column_name::text AS c FROM information_schema.columns WHERE table_name = 'nri_gl_rules'`,
        { type: QueryTypes.SELECT },
    )).map((r) => r.c);
    if (!cols.length) { console.log('  nri_gl_rules does not exist — run create-nri-billing-tables.js'); return; }
    if (cols.includes('month')) { console.log('  = "month" present\n\nNothing to do. (idempotent — already applied)'); return; }
    const [{ n }] = await sequelize.query('SELECT COUNT(*)::int AS n FROM nri_gl_rules', { type: QueryTypes.SELECT });
    if (n > 0) throw new Error(`nri_gl_rules holds ${n} rows — refusing to rebuild it. Migrate them by hand.`);
    console.log('  + rebuild nri_gl_rules with "month" (table is empty)');
    if (DRY) { console.log('\n--dry-run — nothing written.'); return; }
    await models.nri_gl_rules.sync({ force: true });
    console.log('  rebuilt');
}

main().then(() => sequelize.close()).catch(async (e) => { console.error(e.message); await sequelize.close(); process.exit(1); });
