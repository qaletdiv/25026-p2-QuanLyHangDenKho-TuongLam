'use strict';
/**
 * Seed the month-by-month SERVICE CHANNELS (Rules step 2) and GL CODES from the
 * team's own 2026 coding, so that a RAW invoice coded by the rules alone lands where
 * the team used to put it by hand — and the latest month carries into the next.
 *
 *   node scripts/seed-nri-month-settings.js [--entity=CA] [--dry-run] [--force]
 *
 * For each period-end month, in order:
 *   channel  per service, the team's channel by $ MAJORITY over the lines the service
 *            columns actually decide — no order type, no matching exception rule.
 *            "Team's channel" = the hand-coded class, else the legend's default.
 *   GL       per service, the team's GL by $ majority over all its lines
 *            (hand-coded GL, else the legend's).
 * A service not billed in a month keeps the previous month's value. A month is SAVED
 * only where its list differs from what it would inherit, so an unchanged month keeps
 * reading "inherited". Months that already hold settings are left alone (--force to
 * replace them). Splits — a majority under 80% — are reported: a per-service setting
 * cannot reproduce them, they need an exception or a decision.
 */

require('../src/config/env');
const { models, sequelize } = require('../src/models');
const { atomically } = require('../database/tx');
const { txOptions } = require('../database/txContext');
const svc = require('../src/services/nriBillingService');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const FORCE = args.includes('--force');
const ENTITY = ((args.find((a) => a.startsWith('--entity=')) || '--entity=CA').split('=')[1] || 'CA').toUpperCase();
const SPLIT = 0.8;

const norm = (v) => (v === undefined || v === null ? '' : String(v).trim());
const key = (v) => norm(v).toLowerCase();
const majority = (byValue) => {
    const e = Object.entries(byValue).sort((a, b) => b[1] - a[1]);
    const total = e.reduce((s, [, v]) => s + v, 0);
    return e.length && total > 0 ? { value: e[0][0], share: e[0][1] / total } : null;
};

async function main() {
    const [codes, orders, rules, glRules, files] = await Promise.all([
        models.nri_charge_codes.read(),
        models.nri_order_master.findAll({ where: { entity: ENTITY }, raw: true }),
        models.nri_class_rules.findAll({ where: { entity: ENTITY }, raw: true }),
        models.nri_gl_rules.findAll({ where: { entity: ENTITY }, raw: true }),
        models.nri_billing_files.findAll({ where: { entity: ENTITY }, raw: true }),
    ]);
    const legend = svc.legendIndex(codes, ENTITY);
    const classes = [...new Set([...legend.byService.values()].map((m) => m.class).filter(Boolean))];
    const ONLINE = classes.find((c) => /online/i.test(c)) || `${ENTITY} - Online`;
    const WHSLE = classes.find((c) => /whsle/i.test(c)) || `${ENTITY} - Whsle`;
    const orderTypes = svc.orderTypeIndex(orders);
    const exceptions = rules.filter((r) => r.kind === 'custom' && r.enabled !== false);
    const fileMonth = new Map(files.map((f) => [f.id, f.periodEnd ? String(f.periodEnd).slice(0, 7) : null]));
    const months = [...new Set([...fileMonth.values()].filter(Boolean))].sort();
    const lines = (await models.nri_billing_lines.findAll({ where: { fileId: files.map((f) => f.id) }, raw: true })).map(svc.toLine);

    // starting point = the base columns (month NULL), else the legend default
    const baseCols = rules.filter((r) => r.kind === 'serviceColumn' && !r.month);
    const baseSide = new Map();
    for (const r of baseCols) for (const v of r.conditions[0].values) baseSide.set(key(v), r.setClass === ONLINE ? 'online' : 'whsle');
    const services = new Map();
    for (const [k] of legend.byService) services.set(k, null);
    for (const l of lines) services.set(key(l.service), null);
    const names = new Map();
    for (const c of codes) names.set(key(c.service), norm(c.service));
    for (const l of lines) if (!names.has(key(l.service))) names.set(key(l.service), norm(l.service));
    let side = new Map([...services.keys()].map((k) => [k, baseSide.get(k) || (/online/i.test(legend.byService.get(k)?.class || '') ? 'online' : 'whsle')]));
    let gl = new Map([...services.keys()].map((k) => [k, legend.byService.get(k)?.gl ?? null]));

    const heldCols = new Set(rules.filter((r) => r.kind === 'serviceColumn' && r.month).map((r) => r.month));
    const heldGl = new Set(glRules.map((r) => r.month));
    const plan = [];
    const splits = [];
    for (const m of months) {
        const inMonth = lines.filter((l) => fileMonth.get(l.fileId) === m);
        const chan = new Map();
        const gls = new Map();
        for (const l of inMonth) {
            const k = key(l.service);
            const map = legend.byService.get(k);
            const g = l.glOverride ?? (map ? map.gl : null);
            if (g !== null) { const o = gls.get(k) || {}; o[g] = (o[g] || 0) + l.charges; gls.set(k, o); }
            // does the SERVICE COLUMN decide this line? (no order type, no exception)
            if (svc.orderTypeOf(orderTypes, l)) continue;
            const ctx = svc.ruleContext(l, null);
            if (exceptions.some((r) => svc.ruleMatches(r, ctx))) continue;
            const cls = l.classOverride || (map ? map.class : null);
            if (!cls) continue;
            const o = chan.get(k) || {};
            const s = cls === ONLINE ? 'online' : 'whsle';
            o[s] = (o[s] || 0) + l.charges;
            chan.set(k, o);
        }
        const nextSide = new Map(side);
        const nextGl = new Map(gl);
        for (const [k, o] of chan) {
            const mj = majority(o);
            if (!mj) continue;
            nextSide.set(k, mj.value);
            if (mj.share < SPLIT) splits.push({ month: m, service: names.get(k), kind: 'channel', winner: mj.value, share: mj.share, dollars: Object.values(o).reduce((a, b) => a + b, 0) });
        }
        for (const [k, o] of gls) {
            const mj = majority(o);
            if (!mj) continue;
            nextGl.set(k, Number(mj.value));
            if (mj.share < SPLIT) splits.push({ month: m, service: names.get(k), kind: 'GL', winner: mj.value, share: mj.share, dollars: Object.values(o).reduce((a, b) => a + b, 0) });
        }
        const sideChanged = [...nextSide].filter(([k, v]) => side.get(k) !== v).map(([k, v]) => `${names.get(k)} → ${v === 'online' ? 'Ecomm' : 'Wholesale'}`);
        const glChanged = [...nextGl].filter(([k, v]) => gl.get(k) !== v).map(([k, v]) => `${names.get(k)} → ${v}`);
        plan.push({ month: m, side: nextSide, gl: nextGl, sideChanged, glChanged });
        side = nextSide;
        gl = nextGl;
    }

    console.log(`${ENTITY}: ${months.length} months, ${lines.length} lines${DRY ? '  (dry run)' : ''}\n`);
    for (const p of plan) {
        const c = p.sideChanged.length ? `channel: ${p.sideChanged.join(', ')}` : 'channel: inherit';
        const g = p.glChanged.length ? `GL: ${p.glChanged.join(', ')}` : 'GL: inherit';
        const skip = [(p.sideChanged.length && heldCols.has(p.month) && !FORCE) ? 'channel already set — kept' : '', (p.glChanged.length && heldGl.has(p.month) && !FORCE) ? 'GL already set — kept' : ''].filter(Boolean).join('; ');
        console.log(`  ${p.month}  ${c}\n           ${g}${skip ? `\n           (${skip})` : ''}`);
    }
    if (splits.length) {
        console.log('\nSPLIT within a month (majority < 80%) — a per-service setting cannot reproduce these:');
        for (const s of splits.sort((a, b) => b.dollars - a.dollars)) {
            console.log(`  ${s.month}  ${s.kind.padEnd(7)} ${s.service.padEnd(28)} ${(s.share * 100).toFixed(0)}% ${s.kind === 'channel' ? (s.winner === 'online' ? 'Ecomm' : 'Wholesale') : s.winner}  of $${s.dollars.toFixed(2)}`);
        }
    }
    if (DRY) { console.log('\n--dry-run — nothing written.'); return; }

    const now = new Date().toISOString();
    let colMonths = 0;
    let glMonths = 0;
    await atomically(async () => {
        for (const p of plan) {
            if (p.sideChanged.length && (!heldCols.has(p.month) || FORCE)) {
                await models.nri_class_rules.destroy({ where: { entity: ENTITY, kind: 'serviceColumn', month: p.month }, ...txOptions() });
                const list = (s) => [...p.side].filter(([, v]) => v === s).map(([k]) => names.get(k)).sort();
                const mk = (s, i) => ({
                    id: `ncr_${ENTITY.toLowerCase()}_${p.month}_${i}`, entity: ENTITY, seq: 100 + i, kind: 'serviceColumn',
                    month: p.month, enabled: true, setClass: s === 'online' ? ONLINE : WHSLE,
                    name: s === 'online' ? 'Ecomm services' : 'Wholesale services',
                    conditions: [{ field: 'service', op: 'is', values: list(s) }],
                    updatedAt: now, updatedBy: 'seed: team 2026 coding',
                });
                const rows = [mk('whsle', 1), mk('online', 2)].filter((r) => r.conditions[0].values.length);
                await models.nri_class_rules.bulkCreate(rows, txOptions());
                colMonths++;
            }
            if (p.glChanged.length && (!heldGl.has(p.month) || FORCE)) {
                await models.nri_gl_rules.destroy({ where: { entity: ENTITY, month: p.month }, ...txOptions() });
                const rows = [...p.gl].filter(([, v]) => v !== null).map(([k, v], i) => ({
                    id: `ngr_${ENTITY.toLowerCase()}_${p.month}_${i + 1}`, entity: ENTITY, month: p.month,
                    service: names.get(k), gl: v, updatedAt: now, updatedBy: 'seed: team 2026 coding',
                }));
                await models.nri_gl_rules.bulkCreate(rows, txOptions());
                glMonths++;
            }
        }
    });
    console.log(`\nsaved: service columns for ${colMonths} month(s), GL codes for ${glMonths} month(s)`);
}

main()
    .then(() => sequelize.close())
    .catch(async (e) => { console.error(e); await sequelize.close(); process.exit(1); });
