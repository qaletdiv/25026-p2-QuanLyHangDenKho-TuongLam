'use strict';
// Grants the new `shipment_flag_priority` permission to Admin + Logistics
// Coordinator only. Idempotent; `--dry-run` reports without writing.
//
// Deliberately NOT granted to Production or Freight Forwarder, both of which hold
// `shipment_update_status` — the flag is Logistics' own "needs attention" marker,
// which is the whole reason it is a separate key.

require('dotenv').config({ quiet: true });
const { models } = require('../models');
const { atomically } = require('../database/tx');

const KEY = 'shipment_flag_priority';
const GRANT_TO = ['Admin', 'Logistics Coordinator'];
const DRY = process.argv.includes('--dry-run');

async function main() {
  const roles = await models.roles.read();
  const parse = (r) => (Array.isArray(r.permissions) ? r.permissions : JSON.parse(r.permissions || '[]'));

  const plan = roles.map((r) => {
    const perms = parse(r);
    const should = GRANT_TO.includes(r.name);
    const has = perms.includes(KEY);
    return { r, perms, should, has, action: should && !has ? 'grant' : (!should && has ? 'revoke' : 'none') };
  });

  plan.forEach((p) => console.log(
    `  ${p.r.name.padEnd(22)} ${p.has ? 'has' : '—  '}  -> ${p.action === 'none' ? 'unchanged' : p.action.toUpperCase()}`,
  ));

  const changes = plan.filter((p) => p.action !== 'none');
  if (!changes.length) { console.log('\nNothing to do. (idempotent)'); return; }
  if (DRY) { console.log(`\n--dry-run — ${changes.length} role(s) would change, nothing written.`); return; }

  const next = roles.map((row) => {
    const p = plan.find((x) => x.r.id === row.id);
    if (!p || p.action === 'none') return row;
    const perms = p.action === 'grant' ? [...p.perms, KEY] : p.perms.filter((k) => k !== KEY);
    // keep the stored shape — some rows hold a JSON string, not an array
    return { ...row, permissions: Array.isArray(row.permissions) ? perms : JSON.stringify(perms) };
  });

  await atomically(() => models.roles.write(next));

  const after = await models.roles.read();
  console.log('\nafter:');
  after.forEach((r) => console.log(`  ${r.name.padEnd(22)} ${parse(r).includes(KEY) ? 'YES' : '·'}`));
  console.log('done.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
