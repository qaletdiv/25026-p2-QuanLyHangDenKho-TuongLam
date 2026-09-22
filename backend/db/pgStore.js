// ---------------------------------------------------------------------------
// The Postgres implementation of the two calls the whole portal is built on:
//
//     readData(filename)        -> the rows, as an array of plain objects
//     writeData(filename, rows) -> replace the table with exactly these rows
//
// Same signatures as driveStorage's filesystem path, same JavaScript values in
// and out, so the 45+ modules above it are untouched. What changes underneath is
// that "the table" is a real table with real column types, real keys and real
// foreign keys instead of a JSON file rewritten in place.
//
// WHY WHOLE-TABLE REPLACE AND NOT A DIFF. BaseModel.write() has always been
// given the complete array and has always rewritten the complete file, so every
// caller above is written for those semantics: controllers filter, map and
// concat whole arrays and hand back the result, and a row missing from that
// array MEANS deleted. A diff would have to reconstruct that intent from row
// identity, and tables like mainline_po_leg_lines have duplicate ids to
// reconstruct it from. DELETE + INSERT is what the callers already mean, and
// inside the request transaction it is atomic.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');
const { currentClient, withTransaction } = require('./txContext');

const SCHEMA_PATH = path.join(__dirname, 'schema.json');

// Row order is meaningful to this codebase (see the _seq note in schema.sql), so
// it is carried in a column rather than left to the planner. It is stripped from
// everything handed back — no caller has ever seen it.
const SEQ = '_seq';

let registry = null;

function loadRegistry() {
    if (registry) return registry;
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const byFile = new Map();
    for (const t of schema.tables) {
        byFile.set(normalizeFile(t.file), { name: t.name, kind: 'rows', columns: null });
    }
    for (const d of schema.documents) {
        byFile.set(normalizeFile(d.file), { name: d.name, kind: 'document' });
    }
    registry = { byFile };
    return registry;
}

/** BaseModel filenames are written as 'migrated/x.json' / 'x.json'. */
function normalizeFile(filename) {
    return String(filename).replace(/\\/g, '/').replace(/^\.?\//, '');
}

function entryFor(filename) {
    return loadRegistry().byFile.get(normalizeFile(filename)) || null;
}

function runner() {
    return currentClient() || pool;
}

// ---------------------------------------------------------------------------
//  Column metadata, read from the live catalog rather than schema.json.
//
//  The catalog is the truth about what the table can hold: it already reflects
//  any column added by the auto-evolve path below, which a file written at build
//  time would not.
// ---------------------------------------------------------------------------
const columnCache = new Map();

async function columnsOf(table) {
    if (columnCache.has(table)) return columnCache.get(table);
    const { rows } = await runner().query(
        `SELECT column_name, data_type, udt_name
           FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1
          ORDER BY ordinal_position`,
        [table],
    );
    if (!rows.length) throw new Error(`[db] table "${table}" does not exist — run db/migrate.js`);
    const cols = rows
        .filter((r) => r.column_name !== SEQ)
        .map((r) => ({ name: r.column_name, type: r.udt_name }));
    columnCache.set(table, cols);
    return cols;
}

const q = (id) => `"${id}"`;

// ---------------------------------------------------------------------------
//  Decoding — Postgres value to the value JSON.parse used to give.
// ---------------------------------------------------------------------------
// pool.js pins the parsers for date and numeric, so by the time a value arrives
// here only timestamptz still needs work: pg hands back a JS Date, and the JSON
// held the canonical ISO string it came from.
function decodeValue(v) {
    if (v instanceof Date) return v.toISOString();
    return v;
}

function decodeRow(row) {
    const out = {};
    for (const key of Object.keys(row)) {
        if (key === SEQ) continue;
        out[key] = decodeValue(row[key]);
    }
    return out;
}

// ---------------------------------------------------------------------------
//  Encoding — JavaScript value to a parameter Postgres will accept.
// ---------------------------------------------------------------------------
function encodeValue(value, type) {
    if (value === undefined) return null;
    if (value === null) return null;
    // json columns hold whatever shape the JSON had (roles.permissions is an
    // array of keys, nri_rate_card.tiers an array of objects); pg needs the text.
    if (type === 'json' || type === 'jsonb') return JSON.stringify(value);
    // An object reaching a scalar column would stringify to "[object Object]".
    // That is a caller bug and is worth an error rather than a corrupted cell.
    if (typeof value === 'object' && !(value instanceof Date)) {
        throw new Error(`[db] cannot store ${JSON.stringify(value).slice(0, 80)} in a ${type} column`);
    }
    return value;
}

// ---------------------------------------------------------------------------
//  Auto-evolve: a key with no column.
//
//  Code changes add fields (mainline_shipments gained carrier_reference, sms_pos
//  gained approval_status). Under JSON that just worked; here the column has to
//  exist or the value is dropped. Dropping data silently is the one outcome not
//  worth allowing, so the column is added and the addition is logged loudly
//  enough to be noticed and written into database.dbml.
// ---------------------------------------------------------------------------
function pgTypeForValue(v) {
    if (v === null || v === undefined) return 'text';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'numeric';
    if (typeof v === 'object') return 'json';
    return 'text';
}

async function addMissingColumns(table, known, rows) {
    const have = new Set(known.map((c) => c.name));
    const added = [];
    for (const row of rows) {
        for (const key of Object.keys(row)) {
            if (have.has(key) || key === SEQ) continue;
            const sample = rows.find((r) => r[key] !== null && r[key] !== undefined);
            const type = pgTypeForValue(sample ? sample[key] : null);
            await runner().query(`ALTER TABLE ${q(table)} ADD COLUMN IF NOT EXISTS ${q(key)} ${type}`);
            console.warn(`[db] added column ${table}.${key} ${type} — add it to database.dbml`);
            have.add(key);
            added.push({ name: key, type });
        }
    }
    if (added.length) {
        columnCache.delete(table);
        return columnsOf(table);
    }
    return known;
}

// ---------------------------------------------------------------------------
//  read / write
// ---------------------------------------------------------------------------

async function readData(filename) {
    const entry = entryFor(filename);
    // An unknown file is not an error: BaseModel points at several that have
    // never existed on disk, and the filesystem path returned [] for those.
    if (!entry) return [];

    if (entry.kind === 'document') {
        const { rows } = await runner().query('SELECT data FROM _documents WHERE name = $1', [entry.name]);
        return rows.length ? rows[0].data : [];
    }

    const cols = await columnsOf(entry.name);
    const list = cols.map((c) => q(c.name)).join(', ');
    const { rows } = await runner().query(`SELECT ${list} FROM ${q(entry.name)} ORDER BY ${q(SEQ)}`);
    return rows.map(decodeRow);
}

// Parameters per INSERT. Postgres caps a statement at 65,535 parameters, and
// batching also keeps the largest table (mainline_item_receipt_lines, 10k rows)
// off a single enormous statement.
const MAX_PARAMS = 30_000;

async function writeData(filename, data) {
    const entry = entryFor(filename);
    if (!entry) {
        throw new Error(
            `[db] no table is mapped to "${filename}". Add the file under backend/data/ ` +
            'and re-run `node db/buildSchema.js && node db/migrate.js`.',
        );
    }

    const run = async () => {
        if (entry.kind === 'document') {
            await runner().query(
                `INSERT INTO _documents (name, data, updated_at) VALUES ($1, $2, now())
                 ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
                [entry.name, JSON.stringify(data)],
            );
            return;
        }

        if (!Array.isArray(data)) {
            throw new Error(`[db] ${entry.name} expects an array, got ${typeof data}`);
        }
        const rows = data.filter((r) => r && typeof r === 'object');

        let cols = await columnsOf(entry.name);
        cols = await addMissingColumns(entry.name, cols, rows);

        await runner().query(`DELETE FROM ${q(entry.name)}`);
        if (!rows.length) return;

        const names = [...cols.map((c) => c.name), SEQ];
        const typeByName = new Map(cols.map((c) => [c.name, c.type]));
        const colSql = names.map(q).join(', ');
        const perRow = names.length;
        const rowsPerBatch = Math.max(1, Math.floor(MAX_PARAMS / perRow));

        for (let start = 0; start < rows.length; start += rowsPerBatch) {
            const batch = rows.slice(start, start + rowsPerBatch);
            const values = [];
            const tuples = batch.map((row, i) => {
                const placeholders = names.map((name, j) => {
                    values.push(name === SEQ
                        ? start + i
                        : encodeValue(row[name], typeByName.get(name)));
                    return `$${i * perRow + j + 1}`;
                });
                return `(${placeholders.join(', ')})`;
            });
            await runner().query(
                `INSERT INTO ${q(entry.name)} (${colSql}) VALUES ${tuples.join(', ')}`,
                values,
            );
        }
    };

    // Inside a request transaction this joins it, so the whole request still
    // commits or rolls back as one. Outside one (cron poll, a maintenance
    // script) it gets its own, so DELETE + INSERT is never half-applied.
    return withTransaction(run);
}

function resetCache() {
    registry = null;
    columnCache.clear();
}

module.exports = { readData, writeData, entryFor, resetCache, loadRegistry, SEQ };
