'use strict';

/**
 * split-sms-cartons.js — move the PHYSICAL-carton facts out of sms_packing_cartons
 * into their own table, sms_cartons.
 *
 * WHY. net_weight_kgs / gross_weight_kgs / measure_cm describe the BOX, but they
 * were stored on every (carton × SKU) row: 890 rows for 114 real cartons. The
 * uploader wrote the real value on the carton's first line and zeroed the rest, so
 * 103 of 114 cartons held rows that contradict each other. Every total therefore
 * depended on ROW ORDER — Σ net weight reads 827.8 counting each carton once, or
 * 976.3 summing all rows — and row order is undefined in SQL, so the same query
 * could return either number after the Postgres migration. That value feeds the
 * packing list, the CI and (through the CI basis) the landed cost.
 *
 * WHAT IT DOES, per (shipment_id, ctn_number):
 *   1. collects every DISTINCT non-empty value of each carton field
 *   2. REFUSES TO WRITE if any carton has two different non-empty values for the
 *      same field (that would be a real conflict, not a zeroed repeat) — it prints
 *      them and exits non-zero instead of guessing
 *   3. writes one sms_cartons row per carton, and strips the three columns from
 *      sms_packing_cartons
 *
 * SAFETY. Idempotent: re-running after a successful run finds the columns already
 * gone and reports "nothing to do". Verifies row counts and that every SKU row's
 * carton exists in the new table before writing. Pass --dry-run to see the plan
 * without touching disk. Reads/writes only these two SMS files; mainline is not
 * touched (mainline_packing_cartons has the same shape and the same latent issue,
 * deliberately left alone here).
 *
 *   node scripts/split-sms-cartons.js --dry-run
 *   node scripts/split-sms-cartons.js
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'migrated');
const SKU_FILE = path.join(DIR, 'sms_packing_cartons.json');
const CTN_FILE = path.join(DIR, 'sms_cartons.json');
const DRY = process.argv.includes('--dry-run');

const FIELDS = ['net_weight_kgs', 'gross_weight_kgs', 'measure_cm'];
const isEmpty = (v) => v == null || v === '' || Number(v) === 0;

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');   // tolerate a BOM
  return JSON.parse(raw);
}

function main() {
  const skuRows = readJson(SKU_FILE, null);
  if (!Array.isArray(skuRows)) { console.error(`Cannot read ${SKU_FILE}`); process.exit(1); }

  const stillHasFacts = skuRows.some((r) => FIELDS.some((f) => f in r));
  const existingCartons = readJson(CTN_FILE, []);

  if (!stillHasFacts) {
    console.log(`Nothing to do — sms_packing_cartons carries no carton-level columns.`);
    console.log(`sms_cartons.json: ${existingCartons.length} row(s).`);
    return;
  }

  // ---- group by the real carton key ----
  const byCarton = new Map();
  for (const r of skuRows) {
    const key = `${r.shipment_id}|${r.ctn_number}`;
    if (!byCarton.has(key)) byCarton.set(key, { shipment_id: r.shipment_id, ctn_number: r.ctn_number, rows: [] });
    byCarton.get(key).rows.push(r);
  }

  // ---- conflict detection (refuse rather than guess) ----
  const conflicts = [];
  const cartons = [];
  for (const [key, g] of byCarton) {
    const out = { id: `sctn_${g.shipment_id}_${g.ctn_number}`, shipment_id: g.shipment_id, ctn_number: g.ctn_number };
    for (const f of FIELDS) {
      const distinct = [...new Set(g.rows.map((r) => r[f]).filter((v) => !isEmpty(v)).map(String))];
      if (distinct.length > 1) conflicts.push({ carton: key, field: f, values: distinct });
      out[f] = distinct.length ? (f === 'measure_cm' ? distinct[0] : Number(distinct[0])) : null;
    }
    cartons.push(out);
  }

  if (conflicts.length) {
    console.error(`REFUSING TO WRITE — ${conflicts.length} carton field(s) hold conflicting non-empty values:`);
    conflicts.slice(0, 20).forEach((c) => console.error(`  carton ${c.carton} · ${c.field} = ${c.values.join(' vs ')}`));
    console.error(`Resolve these in the source data first; the script guesses nothing.`);
    process.exit(2);
  }

  // ---- strip the columns from the SKU rows ----
  const strippedRows = skuRows.map((r) => {
    const o = { ...r };
    FIELDS.forEach((f) => delete o[f]);
    return o;
  });

  // ---- invariants before writing ----
  const problems = [];
  if (strippedRows.length !== skuRows.length) problems.push('row count changed');
  const cartonKeys = new Set(cartons.map((k) => `${k.shipment_id}|${k.ctn_number}`));
  const orphan = strippedRows.filter((r) => !cartonKeys.has(`${r.shipment_id}|${r.ctn_number}`));
  if (orphan.length) problems.push(`${orphan.length} SKU row(s) have no carton row`);
  if (new Set(cartons.map((k) => k.id)).size !== cartons.length) problems.push('duplicate carton id');
  if (problems.length) { console.error('REFUSING TO WRITE —', problems.join('; ')); process.exit(3); }

  // Σ weights must survive: once-per-carton before == Σ over the new table
  const seen = new Set();
  let beforeNet = 0, beforeGross = 0;
  for (const r of skuRows) {
    const k = `${r.shipment_id}|${r.ctn_number}`;
    if (seen.has(k)) continue;
    seen.add(k);
    beforeNet += Number(r.net_weight_kgs) || 0;
    beforeGross += Number(r.gross_weight_kgs) || 0;
  }
  const afterNet = cartons.reduce((a, k) => a + (Number(k.net_weight_kgs) || 0), 0);
  const afterGross = cartons.reduce((a, k) => a + (Number(k.gross_weight_kgs) || 0), 0);
  const drift = Math.abs(beforeNet - afterNet) > 0.001 || Math.abs(beforeGross - afterGross) > 0.001;

  console.log(`SKU rows          : ${skuRows.length}`);
  console.log(`physical cartons  : ${cartons.length}`);
  console.log(`cartons with no weight at all: ${cartons.filter((k) => FIELDS.every((f) => k[f] == null)).length}`);
  console.log(`Σ net   before/after: ${beforeNet.toFixed(2)} / ${afterNet.toFixed(2)}`);
  console.log(`Σ gross before/after: ${beforeGross.toFixed(2)} / ${afterGross.toFixed(2)}`);
  if (drift) { console.error('REFUSING TO WRITE — weight totals drifted'); process.exit(4); }

  if (DRY) { console.log('\n--dry-run: nothing written.'); return; }

  fs.writeFileSync(CTN_FILE, JSON.stringify(cartons, null, 2) + '\n');
  fs.writeFileSync(SKU_FILE, JSON.stringify(strippedRows, null, 2) + '\n');
  console.log(`\nWrote ${cartons.length} row(s) to sms_cartons.json and stripped ${FIELDS.join('/')} from sms_packing_cartons.json.`);
}

main();
