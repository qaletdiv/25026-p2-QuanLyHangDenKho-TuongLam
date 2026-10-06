'use strict';
// Creates the NRI billing tables from their models:
//   nri_contract_rates · nri_contract_terms · nri_billing_files · nri_billing_lines
//   nri_class_rules · nri_gl_rules — and SEEDS nri_class_rules with the starting channel rules when it is
//   empty (nriBillingService.DEFAULT_RULES). A non-empty rules table is never
//   touched: from then on the rules belong to All Invoices → Rules.
//
// Idempotent: Model.sync() without `alter`/`force` only CREATES a missing table
// and never touches an existing one. `--dry-run` reports, writes nothing.
//
// ⚠️ The existence check casts table_name to TEXT. information_schema returns it as
// the domain type sql_identifier, which this codebase's pg type parsers hand back as a
// one-element ARRAY — so every table read as missing (harmless with sync(), but the report lied).

require('../src/config/env');
const { QueryTypes } = require('sequelize');
const { models, sequelize } = require('../src/models');
const { DEFAULT_RULES } = require('../src/services/nriBillingService');

const DRY = process.argv.includes('--dry-run');
// parent before child — nri_billing_lines references nri_billing_files
const TABLES = ['nri_contract_rates', 'nri_contract_terms', 'nri_billing_files', 'nri_billing_lines', 'nri_class_rules', 'nri_gl_rules'];

async function main() {
    const rows = await sequelize.query(
        `SELECT table_name::text AS table_name FROM information_schema.tables WHERE table_schema = 'public'`,
        { type: QueryTypes.SELECT },
    );
    const have = new Set(rows.map((r) => r.table_name));
    for (const t of TABLES) {
        if (have.has(t)) { console.log(`  = ${t} exists — skipping`); continue; }
        if (DRY) { console.log(`  + ${t} would be created`); continue; }
        await models[t].sync();
        console.log(`  + ${t} created`);
    }

    const held = have.has('nri_class_rules') || !DRY ? await models.nri_class_rules.count() : 0;
    if (held) {
        console.log(`  = nri_class_rules holds ${held} rules — not reseeding`);
    } else {
        const seed = Object.entries(DEFAULT_RULES).flatMap(([entity, rules]) => rules.map((r, i) => ({
            ...r, id: `ncr_${entity.toLowerCase()}_${i + 1}`, entity, seq: i + 1, enabled: true,
            updatedAt: new Date().toISOString(), updatedBy: 'seed: create-nri-billing-tables',
        })));
        if (DRY) console.log(`  + would seed ${seed.length} channel rules`);
        else { await models.nri_class_rules.bulkCreate(seed); console.log(`  + seeded ${seed.length} channel rules`); }
    }
    if (DRY) console.log('\n--dry-run — nothing written.');
}

main()
    .then(() => sequelize.close())
    .catch(async (e) => { console.error(e); await sequelize.close(); process.exit(1); });
