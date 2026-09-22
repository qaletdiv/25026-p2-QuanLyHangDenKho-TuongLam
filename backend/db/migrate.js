// ---------------------------------------------------------------------------
// Create the schema and load backend/data/**.json into it.
//
//   node db/migrate.js --dry-run     report what would load, touch nothing
//   node db/migrate.js               create + load an empty database
//   node db/migrate.js --force       WIPE the database and reload from JSON
//
// ⚠️ --force DISCARDS EVERYTHING IN POSTGRES and reloads from the JSON files.
// Once the app is running on DATA_BACKEND=postgres, Postgres is the source of
// truth and those files are a frozen pre-migration snapshot — reloading them
// would silently roll the portal back to migration day. That is why a non-empty
// database is refused without the flag, the same protection CLAUDE.md puts
// around migrate-to-normalized.js.
//
// The load goes through pgStore.writeData — the same path the application uses —
// inside ONE transaction with constraints deferred. So the load exercises the
// real write path, and foreign keys are checked once at COMMIT, which means the
// tables can be loaded in any order.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { pool, ping } = require('./pool');
const { withTransaction } = require('./txContext');
const pgStore = require('./pgStore');
const { build, toSql } = require('./buildSchema');

const DATA = path.join(__dirname, '..', 'data');
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const FORCE = args.has('--force');

function readJson(rel) {
    return JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8'));
}

async function existingRowCount() {
    const { rows } = await pool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
    );
    if (!rows.length) return { tables: 0, rows: 0 };
    let total = 0;
    for (const r of rows) {
        const { rows: c } = await pool.query(`SELECT count(*)::int AS n FROM "${r.table_name}"`);
        total += c[0].n;
    }
    return { tables: rows.length, rows: total };
}

async function main() {
    const info = await ping();
    console.log(`connected  ${info.db} — ${info.version.split(',')[0]}`);

    // Rebuild the schema definition from database.dbml + the live JSON every run,
    // so the DDL can never be stale relative to what is about to be loaded.
    const schema = build();
    const sql = toSql(schema);
    fs.writeFileSync(path.join(__dirname, 'schema.json'), JSON.stringify(schema, null, 2));
    fs.writeFileSync(path.join(__dirname, 'schema.sql'), sql);

    const totalRows = schema.tables.reduce((n, t) => n + t.rowCount, 0);
    console.log(`schema     ${schema.tables.length} tables, ` +
        `${schema.tables.reduce((n, t) => n + t.columns.length, 0)} columns, ` +
        `${schema.foreignKeys.length} foreign keys`);
    console.log(`to load    ${totalRows.toLocaleString()} rows + ${schema.documents.length} document(s)`);

    report(schema.notes);

    if (DRY_RUN) {
        console.log('\n--dry-run: nothing written.');
        return;
    }

    const existing = await existingRowCount();
    if (existing.rows > 0 && !FORCE) {
        throw new Error(
            `refusing to run: the database already holds ${existing.rows.toLocaleString()} rows in ` +
            `${existing.tables} tables.\n` +
            '  If the portal has been running on Postgres, THOSE ROWS ARE THE LIVE DATA and the\n' +
            '  JSON files are a frozen snapshot from migration day — reloading would roll it back.\n' +
            '  Pass --force only if you genuinely mean to discard them.',
        );
    }
    if (existing.rows > 0) {
        console.log(`\n--force: discarding ${existing.rows.toLocaleString()} existing rows.`);
    }

    console.log('\napplying schema...');
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await pool.query(sql);
    pgStore.resetCache();

    console.log('loading data...');
    const loaded = [];
    await withTransaction(async () => {
        for (const t of schema.tables) {
            if (t.placeholder) continue;
            const rows = readJson(t.file);
            await pgStore.writeData(t.file, rows);
            loaded.push({ name: t.name, file: t.file, expected: rows.length });
        }
        for (const d of schema.documents) {
            await pgStore.writeData(d.file, readJson(d.file));
        }
    });

    console.log('verifying row counts...');
    const mismatches = [];
    for (const l of loaded) {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${l.name}"`);
        if (rows[0].n !== l.expected) {
            mismatches.push(`${l.name}: expected ${l.expected}, found ${rows[0].n}`);
        }
    }
    if (mismatches.length) {
        console.error('\nROW COUNT MISMATCH:');
        mismatches.forEach((m) => console.error('  ' + m));
        process.exitCode = 1;
    } else {
        console.log(`\nloaded ${loaded.length} tables, ${totalRows.toLocaleString()} rows — all counts match.`);
    }
}

function report(notes) {
    if (!notes.length) return;
    const groups = notes.reduce((m, n) => ((m[n.kind] = m[n.kind] || []).push(n), m), {});
    const headings = {
        pk_violation: 'PRIMARY KEY NOT CREATED — the declared key is not unique in the data',
        unique_violation: 'UNIQUE INDEX NOT CREATED — the declared key is not unique in the data',
        unique_superseded: 'unique replaced (see SCHEMA_OVERRIDES in db/buildSchema.js)',
        fk_violation: 'FOREIGN KEY NOT CREATED — rows point at a parent that does not exist',
        type_fallback: 'column stored as text — the declared type would not round-trip',
        fk_skipped: 'foreign key not created',
        name_collision: 'file name collision',
        not_an_array: 'stored as a jsonb document',
        non_object_rows: 'non-object entries in the array',
    };
    console.log('');
    for (const [kind, list] of Object.entries(groups)) {
        console.log(`${headings[kind] || kind}:`);
        for (const n of list) {
            console.log(`  ${n.table ? n.table + (n.column ? '.' + n.column : '') + ' — ' : ''}${n.detail}`);
        }
    }
}

main()
    .then(() => pool.end())
    .catch(async (err) => {
        console.error('\n' + err.message);
        await pool.end().catch(() => {});
        process.exit(1);
    });
