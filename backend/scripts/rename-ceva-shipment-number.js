'use strict';

// One-shot, IDEMPOTENT rename: mainline_shipments.ceva_shipment_number →
// carrier_reference (2026-08-24).
//
// WHY: the old column name hardcoded ONE carrier ("CEVA") into the schema, but not
// every mainline shipment moves with a forwarder — FedEx/DHL are used too. The
// carrier is now DATA (mainline_shipments.courier_id), so the reference column no
// longer names it. It is deliberately NOT called "shipment_number": that already
// exists on the same table (the portal's own SHP-N sequence), and two columns
// meaning "Shipment #" would be worse than the name being fixed.
//
// Safety: refuses to write if any row already holds BOTH keys with conflicting
// non-empty values (nothing to reconcile automatically). Re-running after a
// successful pass is a no-op.
//
//   node scripts/rename-ceva-shipment-number.js --dry-run
//   node scripts/rename-ceva-shipment-number.js

const BaseModel = require('../models/BaseModel');

const OLD = 'ceva_shipment_number';
const NEW = 'carrier_reference';
const dryRun = process.argv.includes('--dry-run');

const isSet = (v) => v !== undefined && v !== null && String(v).trim() !== '';

(async () => {
  const model = new BaseModel('migrated/mainline_shipments.json');
  const rows = await model.read();

  const conflicts = rows.filter((r) => isSet(r[OLD]) && isSet(r[NEW]) && r[OLD] !== r[NEW]);
  if (conflicts.length) {
    console.error(`REFUSING TO WRITE — ${conflicts.length} row(s) hold different values in both columns:`);
    conflicts.forEach((r) => console.error(`  shipment ${r.id}: ${OLD}=${JSON.stringify(r[OLD])} ${NEW}=${JSON.stringify(r[NEW])}`));
    process.exit(1);
  }

  let renamed = 0, carried = 0, alreadyDone = 0;
  const next = rows.map((r) => {
    if (!(OLD in r)) { if (NEW in r) alreadyDone++; return r; }
    const out = {};
    // rebuild in order so carrier_reference lands where ceva_shipment_number was,
    // keeping the JSON diff readable instead of appending at the end
    for (const [k, v] of Object.entries(r)) {
      if (k === OLD) { out[NEW] = isSet(r[NEW]) ? r[NEW] : v; if (isSet(v)) carried++; }
      else if (k === NEW) continue;                 // already emitted above
      else out[k] = v;
    }
    if (!(NEW in out)) out[NEW] = r[NEW] ?? null;
    renamed++;
    return out;
  });

  console.log(`${rows.length} mainline shipments — ${renamed} renamed (${carried} carried a value), ${alreadyDone} already migrated`);
  next.filter((r) => isSet(r[NEW])).forEach((r) => console.log(`  ${r.shipment_number || r.id}: ${NEW} = ${r[NEW]}`));

  if (dryRun) return console.log('\n--dry-run: nothing written');
  if (!renamed) return console.log('nothing to do');
  await model.write(next);
  console.log('written');
})().catch((e) => { console.error(e); process.exit(1); });
