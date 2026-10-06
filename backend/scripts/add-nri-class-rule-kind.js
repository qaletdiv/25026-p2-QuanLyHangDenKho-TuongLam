'use strict';
// Adds nri_class_rules."kind" (orderType | custom | serviceColumn) — how the Rules
// page presents a rule, and what fixes its evaluation order — and sorts the stored
// rules into kinds BY SHAPE:
//   one condition, Order type is …   → orderType
//   one condition, NRI service is …  → serviceColumn, MERGED into one rule per channel
//   anything else                    → custom (the Advanced rules)
// Then renumbers `seq` by kind. Idempotent (a second run finds nothing to change);
// `--dry-run` reports without writing.
//
// ⚠️ The identifier is QUOTED — Postgres folds unquoted names to lowercase (see the
// camelCase note in CLAUDE.md).

require('../src/config/env');
const { QueryTypes } = require('sequelize');
const { models, sequelize } = require('../src/models');
const { kindRank } = require('../src/services/nriBillingService');

const DRY = process.argv.includes('--dry-run');

function shapeKind(r) {
    const c = Array.isArray(r.conditions) ? r.conditions : [];
    if (c.length === 1 && c[0].op === 'is' && c[0].field === 'orderType') return 'orderType';
    if (c.length === 1 && c[0].op === 'is' && c[0].field === 'service') return 'serviceColumn';
    return 'custom';
}

async function main() {
    const cols = await sequelize.query(
        `SELECT column_name::text AS column_name FROM information_schema.columns WHERE table_name = 'nri_class_rules'`,
        { type: QueryTypes.SELECT },
    );
    const hasKind = cols.some((c) => c.column_name === 'kind');
    console.log(hasKind ? '  = column "kind" present' : '  + column "kind" TEXT NOT NULL DEFAULT \'custom\'');
    if (!hasKind && !DRY) {
        await sequelize.query(`ALTER TABLE nri_class_rules ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'custom'`);
    }
    if (!hasKind && DRY) { console.log('\n--dry-run — nothing written.'); return; }

    await sequelize.transaction(async (transaction) => {
        const rows = await models.nri_class_rules.findAll({ raw: true, order: [['entity', 'ASC'], ['seq', 'ASC']], transaction });
        const next = [];
        for (const entity of [...new Set(rows.map((r) => r.entity))]) {
            const mine = rows.filter((r) => r.entity === entity).map((r) => ({ ...r, kind: shapeKind(r) }));
            // one column rule per channel: merge service lists, first occurrence wins a service
            const columns = new Map();
            const placed = new Set();
            const rest = [];
            for (const r of mine) {
                if (r.kind !== 'serviceColumn') { rest.push(r); continue; }
                const col = columns.get(r.setClass) || { ...r, conditions: [{ field: 'service', op: 'is', values: [] }] };
                for (const v of r.conditions[0].values) if (!placed.has(v.toLowerCase())) { placed.add(v.toLowerCase()); col.conditions[0].values.push(v); }
                col.enabled = col.enabled && r.enabled;
                columns.set(r.setClass, col);
            }
            const ordered = [...rest, ...columns.values()].sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.seq - b.seq);
            ordered.forEach((r, i) => next.push({ ...r, seq: i + 1, id: `ncr_${entity.toLowerCase()}_${i + 1}` }));
        }
        const same = JSON.stringify(rows.map((r) => [r.id, r.kind, r.seq, r.conditions]))
            === JSON.stringify(next.map((r) => [r.id, r.kind, r.seq, r.conditions]));
        for (const r of next) console.log(`  ${r.entity} ${r.seq} [${r.kind}] ${r.name} → ${r.setClass}`);
        if (same) { console.log('\nNothing to change. (idempotent — already applied)'); return; }
        if (DRY) { console.log('\n--dry-run — nothing written.'); return; }
        await models.nri_class_rules.destroy({ where: {}, transaction });
        await models.nri_class_rules.bulkCreate(next, { transaction });
        console.log(`\n  rewrote ${rows.length} → ${next.length} rules`);
    });
}

main()
    .then(() => sequelize.close())
    .catch(async (e) => { console.error(e); await sequelize.close(); process.exit(1); });
