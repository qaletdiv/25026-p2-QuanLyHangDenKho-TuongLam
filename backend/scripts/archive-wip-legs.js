'use strict';

/**
 * archive-wip-legs.js
 *
 * Saves every leg the retired WIP import built (mainline_po_legs.source !=
 * 'netsuite') to a JSON file BEFORE the NetSuite sync starts retiring them
 * (2026-10-09, per Lam). The sync now replaces a PO's WIP legs with its NetSuite
 * leg whenever nothing points at them, and those legs carry what NetSuite cannot
 * say (air/sea splits, staged CRDs) — this file is the only copy afterwards.
 *
 * Saved per WIP leg: the leg, its SKU allocation (mainline_po_leg_lines) and the
 * rows that point at it (booking junction, shipment junction, packing cartons,
 * documents), so a leg can be put back with everything that referenced it.
 *
 * READ-ONLY against the database. Safe to re-run: it never overwrites an
 * existing archive, it writes a new timestamped file.
 *
 * Usage:
 *   node backend/scripts/archive-wip-legs.js [--out=<dir>]
 *   (default dir: backend/storage/archive)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { models } = require('../src/models');
const { shutdown } = require('../database/tx');

const outArg = process.argv.find((a) => a.startsWith('--out='));
const OUT_DIR = outArg ? outArg.split('=')[1] : path.join(__dirname, '..', 'storage', 'archive');

(async () => {
  const legs = (await models.mainline_po_legs.read()).filter((l) => l.source !== 'netsuite');
  const ids = new Set(legs.map((l) => String(l.id)));
  const pick = async (t) => (await models[t].read()).filter((r) => ids.has(String(r.legId)));

  const archive = {
    archivedAt: new Date().toISOString(),
    note: 'Legs built by the retired WIP import (source != netsuite), with their lines and every row pointing at them.',
    mainline_po_legs: legs,
    mainline_po_leg_lines: await pick('mainline_po_leg_lines'),
    mainline_booking_po_legs: await pick('mainline_booking_po_legs'),
    mainline_shipment_legs: await pick('mainline_shipment_legs'),
    mainline_packing_cartons: await pick('mainline_packing_cartons'),
    mainline_documents: await pick('mainline_documents'),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `wip-legs-${archive.archivedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(archive, null, 1));

  const units = archive.mainline_po_leg_lines.reduce((s, l) => s + (Number(l.allocatedQty) || 0), 0);
  console.log(`archived ${legs.length} WIP legs over ${new Set(legs.map((l) => l.poNumber)).size} POs, ${units} units`);
  for (const k of Object.keys(archive).filter((k) => Array.isArray(archive[k]))) console.log(`  ${k.padEnd(26)} ${archive[k].length}`);
  console.log(`-> ${file}`);
  await shutdown?.();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
