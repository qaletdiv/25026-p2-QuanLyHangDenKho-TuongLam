'use strict';

// Copy address + port_of_discharge from the legacy `warehouses` table onto the
// `warehouse_facilities` rows the documents actually read.
//
// WHY THIS EXISTS. Settings → Warehouses wrote those two fields to `warehouses`,
// the pre-3NF warehouse × allocation-channel list (NRI US Reserved, NRI CA First,
// …). Nothing has ever read them from there: ciGenerator/plGenerator take the
// consignee off `warehouse_facilities`, resolved from the PO's facility_id. So the
// details were entered, correctly, into a table no document consults — and every
// downloaded CI showed a blank consignee address and port of discharge.
//
// The address is a FACILITY fact stored at facility×channel grain, which is why
// both NRI US rows carry the same address and both NRI CA rows carry the other.
// This lifts it to the grain it belongs at; the fields were then removed from the
// Warehouses screen so there is one place to maintain it.
//
// Mapping is by NAME PREFIX (facility "NRI US" ← warehouse "NRI US Reserved"),
// longest match wins. Idempotent. Refuses to write if two warehouses for the same
// facility disagree on a non-empty value, or if the facility already holds a
// different non-empty value — a silent overwrite here lands on a customs document.
//
//   node scripts/backfill-facility-addresses.js --dry-run
//   node scripts/backfill-facility-addresses.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const BaseModel = require('../models/BaseModel');
const { warehouses } = require('../models/MasterDataModel');
const { atomically } = require('../db/tx');

const facilitiesModel = new BaseModel('migrated/warehouse_facilities.json');
const FIELDS = ['address', 'port_of_discharge'];
const DRY = process.argv.includes('--dry-run');

const clean = (v) => String(v ?? '').trim();

async function main() {
  const [facilities, whs] = await Promise.all([facilitiesModel.read(), warehouses.read()]);

  // longest-prefix match so "Direct US" doesn't also claim "Direct USA" if one appears
  const byFacility = new Map(facilities.map((f) => [f.id, []]));
  const unmatched = [];
  for (const w of whs) {
    const hit = facilities
      .filter((f) => clean(w.name).toLowerCase().startsWith(clean(f.name).toLowerCase()))
      .sort((a, b) => clean(b.name).length - clean(a.name).length)[0];
    if (!hit) { unmatched.push(w.name); continue; }
    byFacility.get(hit.id).push(w);
  }

  const conflicts = [];
  const updates = [];
  for (const f of facilities) {
    const sources = byFacility.get(f.id) || [];
    const patch = {};
    for (const field of FIELDS) {
      const values = [...new Set(sources.map((w) => clean(w[field])).filter(Boolean))];
      if (values.length > 1) {
        conflicts.push(`${f.name}.${field}: ${sources.map((w) => `${w.name}="${clean(w[field])}"`).join(' vs ')}`);
        continue;
      }
      const incoming = values[0];
      const current = clean(f[field]);
      if (!incoming) continue;                       // nothing to carry over
      if (current === incoming) continue;            // already done — idempotent
      if (current) {
        conflicts.push(`${f.name}.${field}: facility already has "${current}", warehouses say "${incoming}"`);
        continue;
      }
      patch[field] = incoming;
    }
    if (Object.keys(patch).length) updates.push({ facility: f, patch });
  }

  if (unmatched.length) console.log(`note: ${unmatched.length} warehouse(s) match no facility: ${unmatched.join(', ')}`);

  if (conflicts.length) {
    console.error('REFUSING TO WRITE — conflicting values:');
    conflicts.forEach((c) => console.error('  ' + c));
    process.exitCode = 1;
    return;
  }

  if (!updates.length) { console.log('nothing to do — every facility already matches.'); return; }

  updates.forEach(({ facility, patch }) => {
    console.log(`${facility.name}: ` + FIELDS.filter((k) => k in patch).map((k) => `${k} = "${patch[k]}"`).join(', '));
  });

  if (DRY) { console.log(`\n--dry-run — ${updates.length} facility row(s) would be written.`); return; }

  const patchById = new Map(updates.map(({ facility, patch }) => [facility.id, patch]));
  await atomically(() => facilitiesModel.write(
    facilities.map((f) => ({ ...f, ...(patchById.get(f.id) || {}) })),
  ));
  console.log(`\nwrote ${updates.length} facility row(s).`);
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(e); process.exit(1); });
