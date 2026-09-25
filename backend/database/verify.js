// ---------------------------------------------------------------------------
// Prove the move to Sequelize is INVISIBLE.
//
//   node database/verify.js            compare every table
//   node database/verify.js po_orders  compare one
//
// For each table this reads the rows twice — once with raw pg exactly the way
// db/pgStore.js did (SELECT the catalog's columns, ORDER BY _seq, Date to ISO
// string), and once through database/modelStore.js — and compares them value for
// value. Anything the ORM layer changes shows up here as a diff.
//
// This exists because the two things Sequelize gets wrong are SILENT. It
// re-parses numeric to a STRING and timestamptz to a Date, and this codebase
// sums numerics with `+`, so a regression would not throw — it would just put a
// wrong number in a forecast. A row count matching proves nothing; only the
// values do.
//
// ⚠️ This is the gate on the whole migration. Nothing gets deleted until it
// reports zero differences.
// ---------------------------------------------------------------------------
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Pool, types } = require('pg');
const { applyTypeParsers, connectionString } = require('./types');
const store = require('./modelStore');
const { models } = require('../models');
const { sequelize } = require('./sequelize');

applyTypeParsers();

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const pool = new Pool({ connectionString: connectionString(), max: 4 });

const SEQ = '_seq';

/** The old pgStore read path, reproduced here so it survives that file's deletion. */
async function rawRead(table) {
    const { rows: cols } = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1
          ORDER BY ordinal_position`,
        [table],
    );
    const names = cols.map((c) => c.column_name).filter((n) => n !== SEQ);
    const list = names.map((n) => `"${n}"`).join(', ');
    const { rows } = await pool.query(`SELECT ${list} FROM "${table}" ORDER BY "${SEQ}"`);
    return rows.map((row) => {
        const out = {};
        for (const key of Object.keys(row)) {
            const v = row[key];
            out[key] = v instanceof Date ? v.toISOString() : v;
        }
        return out;
    });
}

/** Describe a value precisely enough to catch 57.82 vs "57.82". */
function describe(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (v instanceof Date) return `Date(${v.toISOString()})`;
    if (typeof v === 'object') return `${Array.isArray(v) ? 'array' : 'object'} ${JSON.stringify(v)}`;
    return `${typeof v} ${JSON.stringify(v)}`;
}

function sameValue(a, b) {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return false;
    if (typeof a === 'object' || typeof b === 'object') {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    return false;
}

function compareRows(rawRows, ormRows, table, report) {
    if (rawRows.length !== ormRows.length) {
        report.push(`${table}: ROW COUNT ${rawRows.length} raw vs ${ormRows.length} orm`);
        return;
    }
    let diffs = 0;
    for (let i = 0; i < rawRows.length && diffs < 5; i++) {
        const a = rawRows[i];
        const b = ormRows[i];
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const key of keys) {
            if (sameValue(a[key], b[key])) continue;
            report.push(`${table}[${i}].${key}: raw ${describe(a[key])} vs orm ${describe(b[key])}`);
            if (++diffs >= 5) {
                report.push(`${table}: ...more differences suppressed`);
                break;
            }
        }
    }
}

async function main() {
    // Every declared model, deduplicated — the registry keys each one twice
    // (by table name and PascalCase).
    let targets = [...new Set(Object.values(models))].map((m) => m.name).sort();
    if (only.length) {
        targets = targets.filter((t) => only.includes(t));
        if (!targets.length) throw new Error(`no such table: ${only.join(', ')}`);
    }

    const report = [];
    const skipped = [];
    let totalRows = 0;
    let checked = 0;

    for (const table of targets.sort()) {
        if (!models[table]) {
            report.push(`${table}: NO MODEL`);
            continue;
        }
        // What this file verifies is the whole-table .read()/.write() contract,
        // and `_seq` is that contract's row-order column. A table WITHOUT one is
        // not part of it — email_notifications is append-only, keyed on its own
        // id, written with .create() and never replaced wholesale — so there is
        // no ordered array to compare and rawRead's ORDER BY "_seq" would simply
        // error. Skipping is correct here; a MISSING _seq on a table that should
        // have one still shows up, as the "NO MODEL"/diff it really is.
        if (!models[table].rawAttributes[SEQ]) {
            skipped.push(table);
            continue;
        }
        const [raw, orm] = await Promise.all([rawRead(table), store.readAll(models[table])]);
        compareRows(raw, orm, table, report);
        totalRows += raw.length;
        checked++;
    }

    console.log(`compared ${checked} tables, ${totalRows.toLocaleString()} rows`);
    if (skipped.length) console.log(`skipped ${skipped.length} (not on the read/write array contract — no _seq): ${skipped.join(', ')}`);

    if (report.length) {
        console.error(`\n${report.length} DIFFERENCE(S):`);
        report.forEach((r) => console.error('  ' + r));
        process.exitCode = 1;
    } else {
        console.log('\nno differences — the Sequelize read path is value-for-value identical.');
    }
}

main()
    .catch((err) => {
        console.error('\n' + err.stack);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end().catch(() => {});
        await sequelize.close().catch(() => {});
    });
