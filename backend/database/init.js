// ---------------------------------------------------------------------------
// Initialise the database: create every table from backend/models/, then seed.
//
//   node database/init.js --dry-run   report what would happen, touch nothing
//   node database/init.js             create tables + load REFERENCE data
//   node database/init.js --all       also load the transactional snapshot
//   node database/init.js --force     allow this against a NON-EMPTY database
//   node database/init.js --export    REGENERATE seed-data/ from the live database
//
// The schema comes from the MODELS — `sequelize.sync()` reads db/models/*.js, so
// a column exists because a model declares it, never because some JSON happened
// to contain it. The JSON here is input, and nothing else.
//
// ---------------------------------------------------------------------------
// ⚠️ seed-data/reference vs seed-data/snapshot — the distinction is the point
//
//   reference/   20 tables, ~5,000 rows. REAL seed data: statuses, couriers,
//                modes, ports, roles, facilities, product_skus… Small, stable,
//                and an empty database cannot function without them.
//
//   snapshot/    41 tables, ~79,000 rows. NOT seed data — a frozen copy of the
//                transactional tables taken on migration day (2026-09-14). The
//                portal has written to Postgres ever since, so loading this does
//                not reproduce current state, it rolls the portal BACK to that
//                date. For a real restore use pg_dump, not this.
//
//   documents/    whole-file JSON blobs with no row grain (notification_seen).
//                 They live in the `_documents` table and have no model.
//
// Hence: reference by default, snapshot only when asked for by name.
//
// Every file is named after its table — `seed-data/reference/couriers.json` is
// the `couriers` table. That convention replaced a filename→table registry that
// was the last remnant of the pre-Sequelize era.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { sequelize } = require('./sequelize');
const { models } = require('../models');
const store = require('./modelStore');
const { withTransaction } = require('./txContext');

const SEED = path.join(__dirname, 'seed-data');
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const FORCE = args.has('--force');
const ALL = args.has('--all');
const EXPORT = args.has('--export');

// Which tables are real seed data. Everything else is transactional.
const REFERENCE = new Set([
    'allocation_channels', 'container_types', 'couriers', 'courier_status_map', 'incoterms',
    'landed_cost_rates', 'legacy_statuses', 'modes', 'notify_party', 'ports', 'product_skus',
    'production_schedules', 'roles', 'seasons', 'statuses', 'suppliers',
    'transit_time_standards', 'users', 'warehouse_facilities', 'warehouses',
]);

// `type: SELECT` is passed on every read rather than left to Sequelize's
// inference, which parses the SQL to guess the shape and gets it wrong when a
// statement begins with a newline — returning [results, metadata] instead of
// the rows, so `rows.length` reads undefined.
const SELECT = { type: sequelize.QueryTypes.SELECT };

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const listSeed = (kind) => {
    const dir = path.join(SEED, kind);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
        .map((f) => ({ table: f.replace(/\.json$/, ''), file: path.join(dir, f), kind }));
};

async function countRows(table) {
    const [row] = await sequelize.query(`SELECT count(*)::int AS n FROM "${table}"`, SELECT);
    return row.n;
}

async function existingRowCount() {
    // ⚠️ `table_name::text AS name`, not a bare `table_name`. information_schema
    // types it as the `sql_identifier` DOMAIN, which Sequelize hands back as a
    // positional ARRAY rather than a keyed object — so `r.table_name` reads
    // undefined and every count becomes `relation "undefined" does not exist`.
    // Latent in the original seed.js: it only ever ran against an empty database,
    // where this loop never executes.
    const rows = await sequelize.query(
        `SELECT table_name::text AS name FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
        SELECT,
    );
    if (!rows.length) return { tables: 0, rows: 0 };
    let total = 0;
    for (const r of rows) total += await countRows(r.name);
    return { tables: rows.length, rows: total };
}

/**
 * The one table with no model: whole-file JSON blobs with no row grain.
 * sequelize.sync() cannot create it because nothing declares it as a model, and
 * declaring one would invite someone to treat it as a table.
 */
async function createDocumentsTable() {
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS _documents (
            name       text PRIMARY KEY,
            data       json NOT NULL,
            "updatedAt" timestamptz NOT NULL DEFAULT now()
        )`);
}

/**
 * Write seed-data/ from the live database.
 *
 * ⚠️ THIS IS HOW THE SEED FILES STAY LOADABLE. They are plain JSON with no
 * schema of their own, so they silently rot whenever the schema moves — after
 * the 2026-09-22 snake_case → camelCase column rename the checked-in files
 * still had `courier_id` / `status_id` keys and could no longer seed anything.
 * Nothing catches that until someone tries to build a fresh database, which is
 * exactly when they need it to work.
 *
 * Re-run this after any column rename, and commit the result.
 */
async function exportSeed() {
    const tables = [...new Set(Object.values(models))].map((m) => m.name).sort();
    let refCount = 0, snapCount = 0, rows = 0;

    for (const kind of ['reference', 'snapshot', 'documents']) {
        fs.mkdirSync(path.join(SEED, kind), { recursive: true });
    }

    for (const table of tables) {
        const data = await store.readAll(models[table]);
        const kind = REFERENCE.has(table) ? 'reference' : 'snapshot';
        fs.writeFileSync(path.join(SEED, kind, `${table}.json`), JSON.stringify(data, null, 2) + '\n');
        rows += data.length;
        if (kind === 'reference') refCount++; else snapCount++;
    }

    // The _documents blobs have no model, so they are listed by what is stored.
    const docs = await sequelize.query('SELECT name, data FROM _documents', SELECT).catch(() => []);
    for (const d of docs) {
        fs.writeFileSync(path.join(SEED, 'documents', `${d.name}.json`), JSON.stringify(d.data, null, 2) + '\n');
    }

    console.log(`exported  reference ${refCount} · snapshot ${snapCount} · documents ${docs.length}`);
    console.log(`          ${rows.toLocaleString()} rows -> database/seed-data/`);
}

async function main() {
    const [info] = await sequelize.query('SELECT current_database() AS db', SELECT);
    console.log(`connected  ${info.db}`);

    if (EXPORT) {
        if (DRY_RUN) { console.log('--dry-run: would regenerate seed-data/ from this database.'); return; }
        return exportSeed();
    }

    const plan = [...listSeed('reference'), ...(ALL ? listSeed('snapshot') : [])];
    const documents = ALL ? listSeed('documents') : [];

    // A seed file naming a table no model declares is a hard error: it means the
    // model was deleted (or the file misnamed) and the data would load nowhere.
    const orphans = plan.filter((p) => !models[p.table]);
    if (orphans.length) {
        throw new Error(
            'seed files with no matching model:\n' +
            orphans.map((o) => `  seed-data/${o.kind}/${o.table}.json`).join('\n') +
            '\n  Every file must be named after its table. Check backend/models/.',
        );
    }

    const counts = plan.map((p) => ({ ...p, count: readJson(p.file).length }));
    const totalRows = counts.reduce((n, p) => n + p.count, 0);

    console.log(`models     ${new Set(Object.values(models)).size} tables declared in backend/models/`);
    console.log(`seeding    ${ALL ? 'reference + SNAPSHOT (full restore to migration day)' : 'reference/master data only'}`);
    console.log(`to load    ${plan.length} tables, ${totalRows.toLocaleString()} rows` +
        (documents.length ? ` + ${documents.length} document(s)` : ''));
    if (!ALL) {
        console.log('           (--all also loads seed-data/snapshot — read the warning');
        console.log('            at the top of this file before you do)');
    }

    if (DRY_RUN) {
        counts.forEach((p) => console.log(`  ${p.kind.padEnd(10)} ${p.table.padEnd(34)} ${String(p.count).padStart(7)}`));
        console.log('\n--dry-run: nothing written.');
        return;
    }

    const existing = await existingRowCount();
    if (existing.rows > 0 && !FORCE) {
        throw new Error(
            `refusing to run: the database already holds ${existing.rows.toLocaleString()} rows in ` +
            `${existing.tables} tables.\n` +
            '  Postgres is the source of truth — this JSON is a snapshot from migration day\n' +
            '  and seeding over live rows would roll them back.\n' +
            '  Pass --force only if you genuinely mean to replace them.',
        );
    }

    console.log('\ncreating tables from backend/models/ ...');
    await createDocumentsTable();
    // Creates anything missing and leaves existing tables alone. The models
    // carry the deferrable foreign keys, so sync() reproduces them.
    await sequelize.sync();

    console.log('loading data...');
    await withTransaction(async () => {
        for (const p of counts) await store.replaceAll(models[p.table], readJson(p.file));
        for (const d of documents) await store.writeDocument(d.table, readJson(d.file));
    });

    console.log('verifying row counts...');
    const mismatches = [];
    for (const p of counts) {
        const n = await countRows(p.table);
        if (n !== p.count) mismatches.push(`${p.table}: expected ${p.count}, found ${n}`);
    }
    if (mismatches.length) {
        console.error('\nROW COUNT MISMATCH:');
        mismatches.forEach((m) => console.error('  ' + m));
        process.exitCode = 1;
    } else {
        console.log(`\nseeded ${counts.length} tables, ${totalRows.toLocaleString()} rows — all counts match.`);
    }
}

main()
    .catch((err) => {
        // The refusal above is a message for a human; anything else is a bug and
        // wants the stack.
        const expected = err.message.startsWith('refusing to run') || err.message.startsWith('seed files');
        console.error('\n' + (expected ? err.message : err.stack));
        process.exitCode = 1;
    })
    .finally(() => sequelize.close().catch(() => {}));
