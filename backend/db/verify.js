// ---------------------------------------------------------------------------
// Prove the swap is invisible: for every table, compare what pgStore.readData()
// returns against what JSON.parse of the original file returns.
//
//   node db/verify.js            summary + any differences
//   node db/verify.js --verbose  also list every value difference found
//
// The one difference that is EXPECTED and allowed is a key that was absent from
// a sparse JSON row coming back present-and-null. A table is a rectangle: if any
// row in mainline_shipments carried `ata`, every row now has an `ata` column,
// and the rows that never had the key read null instead of undefined. That is
// reported separately as `null_filled` rather than as a failure, because in
// JavaScript `row.ata` is falsy either way and every consumer in this codebase
// tests it with `||`, `??` or a truthiness check.
//
// Everything else — a changed value, a changed type, a changed row order, a lost
// or extra row — is a failure.
//
// ⚠️ THIS IS A MIGRATION-DAY CHECK, NOT A HEALTH CHECK. It compares Postgres
// against the FROZEN JSON snapshot, so it only reads 0 differences immediately
// after `db/migrate.js`. Once the portal has been running, every legitimate
// write — a booking, a shipping-data upload, the 4-hourly NetSuite/FedEx sync
// crons — is a real difference from the snapshot and will be reported here.
// Seen in practice within hours of the cutover: the mainline PO sync rebuilds
// po_order_lines and renumbers its surrogate ids, which showed up as 2,468
// "differences" while the row count, the ordered quantities and every
// (po_number, sku_code, qty, price) tuple were identical.
// So: a clean run proves the migration; a dirty run later proves nothing on its
// own — check WHAT differs before concluding anything.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { pool } = require('./pool');
const pgStore = require('./pgStore');

const DATA = path.join(__dirname, '..', 'data');
const VERBOSE = process.argv.includes('--verbose');

function classify(a, b) {
    if (Object.is(a, b)) return 'same';
    if (JSON.stringify(a) === JSON.stringify(b)) return 'same';
    if ((a === undefined || a === null) && b === null) return 'null_filled';
    return 'different';
}

async function main() {
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));
    const targets = [
        ...schema.tables.filter((t) => !t.placeholder).map((t) => ({ name: t.name, file: t.file })),
        ...schema.documents.map((d) => ({ name: d.name, file: d.file, document: true })),
    ];

    let failures = 0;
    let nullFilled = 0;
    const nullFilledCols = new Map();
    const diffCols = new Map();
    const report = [];

    for (const t of targets) {
        const original = JSON.parse(fs.readFileSync(path.join(DATA, t.file), 'utf8'));
        const fromPg = await pgStore.readData(t.file);

        if (t.document) {
            const same = JSON.stringify(original) === JSON.stringify(fromPg);
            if (!same) { failures += 1; report.push(`${t.name}: document content differs`); }
            continue;
        }

        const src = original.filter((r) => r && typeof r === 'object');
        if (src.length !== fromPg.length) {
            failures += 1;
            report.push(`${t.name}: ${src.length} rows in JSON, ${fromPg.length} from Postgres`);
            continue;
        }

        for (let i = 0; i < src.length; i += 1) {
            const a = src[i];
            const b = fromPg[i];
            const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
            for (const k of keys) {
                const verdict = classify(a[k], b[k]);
                if (verdict === 'same') continue;
                if (verdict === 'null_filled') {
                    nullFilled += 1;
                    const key = `${t.name}.${k}`;
                    nullFilledCols.set(key, (nullFilledCols.get(key) || 0) + 1);
                    continue;
                }
                failures += 1;
                const col = `${t.name}.${k}`;
                const seen = diffCols.get(col) || { n: 0, sample: null };
                seen.n += 1;
                if (!seen.sample) {
                    const trim = (v) => {
                        const s = JSON.stringify(v);
                        return s === undefined ? 'undefined'
                            : (s.length > 120 && !VERBOSE ? s.slice(0, 120) + '…' : s);
                    };
                    seen.sample = `row ${i}: JSON ${trim(a[k])} (${typeof a[k]}) vs PG ${trim(b[k])} (${typeof b[k]})`;
                }
                diffCols.set(col, seen);
            }
        }
    }

    console.log(`tables compared      ${targets.length}`);
    console.log(`value differences    ${failures}`);
    console.log(`absent-key -> null   ${nullFilled} cell(s) across ${nullFilledCols.size} column(s)`);

    if (nullFilledCols.size) {
        console.log('\nColumns where a sparse JSON key now reads null (expected — see the header):');
        for (const [col, n] of [...nullFilledCols].sort((x, y) => y[1] - x[1])) {
            console.log(`  ${col.padEnd(48)} ${n}`);
        }
    }

    if (failures) {
        console.log('\nDIFFERENCES:');
        for (const [col, d] of [...diffCols].sort((x, y) => y[1].n - x[1].n)) {
            console.log(`  ${col} — ${d.n} cell(s)`);
            console.log(`      ${d.sample}`);
        }
        report.forEach((r) => console.log('  ' + r));
        process.exitCode = 1;
    } else {
        console.log('\nPASS — every value round-trips identically.');
    }
}

main()
    .then(() => pool.end())
    .catch(async (err) => {
        console.error(err);
        await pool.end().catch(() => {});
        process.exit(1);
    });
