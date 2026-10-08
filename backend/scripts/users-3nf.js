'use strict';
// users → 3NF (2026-10-08, per Lam). The users table stored the ROLE and the
// SUPPLIER as NAMES (`role`, `supplier`) while its `roleId` / `supplierId` FK
// columns sat NULL on every row — so vendor scoping had to match supplier names
// loosely (supplierKey), which is how "Best Star Fashions Co Ltd" vs
// "Co., Ltd." broke it before. This makes the ids the truth and adds the
// forwarder link:
//
//   default        add users."courierId" (FK → couriers, deferrable), then
//                  backfill roleId (exact role name) and supplierId (supplierKey
//                  match) on rows where they are NULL. REFUSES to write if any
//                  name cannot be resolved — fix the row, then re-run.
//   --drop-names   additionally DROP the `role` and `supplier` name columns,
//                  after re-checking every named row has its id. Run this only
//                  once the code that reads the ids is deployed.
//   --dry-run      report, write nothing.
//
// Idempotent: re-running after a full run does nothing.
// Deploy order: run (no flags) → deploy the new code → run --drop-names.

require('../src/config/env');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../src/models');
const { supplierKey } = require('../src/utils/nameKey');

const DRY = process.argv.includes('--dry-run');
const DROP = process.argv.includes('--drop-names');
const SELECT = { type: QueryTypes.SELECT };

(async () => {
  const cols = new Set((await sequelize.query(
    `SELECT column_name::text AS c FROM information_schema.columns WHERE table_name = 'users'`, SELECT)).map((r) => r.c));
  const hasNames = cols.has('role') || cols.has('supplier');
  const plan = [];

  if (!cols.has('courierId')) plan.push(`+ users."courierId" TEXT → couriers(id)`);

  // ── backfill ids from names (only while the name columns still exist) ───────
  let updates = [];
  if (hasNames) {
    const [users, roles, suppliers] = await Promise.all([
      sequelize.query(`SELECT id, email, ${cols.has('role') ? 'role' : 'NULL AS role'}, ${cols.has('supplier') ? 'supplier' : 'NULL AS supplier'}, "roleId", "supplierId" FROM users ORDER BY _seq`, SELECT),
      sequelize.query(`SELECT id, name FROM roles`, SELECT),
      sequelize.query(`SELECT id, name FROM suppliers`, SELECT),
    ]);
    const roleByName = new Map(roles.map((r) => [r.name, r.id]));
    const supByKey = new Map();
    suppliers.forEach((s) => { const k = supplierKey(s.name); supByKey.set(k, [...(supByKey.get(k) || []), s.id]); });

    const problems = [];
    for (const u of users) {
      const set = {};
      if (u.role && !u.roleId) {
        const rid = roleByName.get(u.role);
        if (!rid) problems.push(`${u.email}: role "${u.role}" is not in roles`);
        else set.roleId = rid;
      }
      if (u.supplier && !u.supplierId) {
        const ids = supByKey.get(supplierKey(u.supplier)) || [];
        if (ids.length !== 1) problems.push(`${u.email}: supplier "${u.supplier}" matches ${ids.length} suppliers`);
        else set.supplierId = ids[0];
      }
      if (Object.keys(set).length) updates.push({ id: u.id, email: u.email, set, from: { role: u.role, supplier: u.supplier } });
    }
    if (problems.length) {
      console.error('REFUSING — unresolved names (nothing written):');
      problems.forEach((p) => console.error('  ' + p));
      process.exitCode = 1; return;
    }
    updates.forEach((u) => plan.push(`~ ${u.email}: ${Object.entries(u.set).map(([k, v]) => `${k}=${v}`).join(', ')}  (from ${JSON.stringify(u.from)})`));
  }

  if (DROP && hasNames) {
    // Re-check AFTER the planned backfill: every named row must end with its id.
    const missing = await sequelize.query(
      `SELECT email FROM users WHERE (${cols.has('role') ? 'role IS NOT NULL' : 'false'} AND "roleId" IS NULL)
                                  OR (${cols.has('supplier') ? 'supplier IS NOT NULL' : 'false'} AND "supplierId" IS NULL)`, SELECT);
    const pending = new Set(updates.map((u) => u.email));
    const stillMissing = missing.filter((m) => !pending.has(m.email));
    if (stillMissing.length) {
      console.error('REFUSING to drop — rows without ids:', stillMissing.map((m) => m.email).join(', '));
      process.exitCode = 1; return;
    }
    ['role', 'supplier'].filter((c) => cols.has(c)).forEach((c) => plan.push(`- DROP users."${c}"`));
  }

  if (!plan.length) { console.log('Nothing to do. (idempotent — already applied)'); return; }
  plan.forEach((p) => console.log('  ' + p));
  if (DRY) { console.log('\n--dry-run — nothing written.'); return; }

  await sequelize.transaction(async (t) => {
    if (!cols.has('courierId')) {
      await sequelize.query(`ALTER TABLE users ADD COLUMN "courierId" TEXT
        REFERENCES couriers(id) DEFERRABLE INITIALLY DEFERRED`, { transaction: t });
    }
    for (const u of updates) {
      const keys = Object.keys(u.set);
      await sequelize.query(
        `UPDATE users SET ${keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`,
        { bind: [...keys.map((k) => u.set[k]), u.id], transaction: t });
    }
    if (DROP) {
      for (const c of ['role', 'supplier'].filter((x) => cols.has(x))) {
        await sequelize.query(`ALTER TABLE users DROP COLUMN "${c}"`, { transaction: t });
      }
    }
  });
  console.log('\napplied.');
})().then(() => sequelize.close()).catch(async (e) => { console.error(e); await sequelize.close(); process.exit(1); });
