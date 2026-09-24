// ---------------------------------------------------------------------------
// The two table operations the whole portal is built on:
//
//     readAll(Model)         -> the rows, as an array of plain objects
//     replaceAll(Model, rows)-> replace the table with exactly these rows
//
// models/index.js attaches these to every model as `.read()` / `.write(rows)`,
// which is what ~190 call sites use:
//
//     const rows = await models.po_orders.read();
//     await models.po_orders.write(next);
//
// WHY WHOLE-TABLE REPLACE AND NOT A DIFF. Those call sites have always been
// handed the complete array and have always written the complete array back:
// controllers filter, map and concat whole arrays and hand back the result, and
// a row missing from that array MEANS deleted. A diff would have to reconstruct
// that intent from row identity, and tables like mainline_po_leg_lines have
// duplicate ids to reconstruct it from. DELETE + INSERT is what the callers
// already mean, and inside the request transaction it is atomic.
//
// Columns are camelCase in the database as of 2026-09-21, so an attribute IS a
// column and nothing is translated here any more — the `field:` mapping layer
// this file used to carry is gone.
// ---------------------------------------------------------------------------
// ⚠️ Deliberately does NOT require ../models. models/index.js requires THIS
// file (lazily, inside read/write) to attach those statics, so a top-level
// require here would be a cycle and one side would see a half-built module.
const { sequelize } = require('./sequelize');
const { txOptions, withTransaction } = require('./txContext');

// Row order is meaningful to this codebase (see the _seq note in models/), so it
// is carried in a column rather than left to the planner. It is stripped from
// everything handed back — no caller has ever seen it.
const SEQ = '_seq';

// ---------------------------------------------------------------------------
//  Decoding — Sequelize's value back to the value callers expect.
//
//  ⚠️ THIS LAYER IS LOAD-BEARING AND BOTH FAILURES ARE SILENT.
//
//  database/types.js pins node-pg's parsers, but Sequelize registers its OWN on top
//  for two types, and both corrupt this codebase. Measured against raw pg:
//
//    DECIMAL (numeric)  Sequelize -> "57.82" (a STRING). This app is built on
//                       `(m.get(k) || 0) + (l.allocatedQty || 0)`; with strings
//                       that is CONCATENATION, so 28 + 5 becomes "285" and a
//                       forecast quietly gains 250,000 units.
//
//    DATE (timestamptz) Sequelize -> a JS Date. Callers expect the ISO string.
//
//  DATEONLY, INTEGER, BOOLEAN and JSON round-trip unchanged and pass through.
//  database/verify.js proves the result matches value for value; do not remove this
//  without re-running it.
// ---------------------------------------------------------------------------

/** model name -> Map(attribute -> 'number' | 'iso'). Computed once. */
const decoderCache = new Map();

function decodersFor(model) {
    if (decoderCache.has(model.name)) return decoderCache.get(model.name);
    const decoders = new Map();
    for (const [attr, def] of Object.entries(model.rawAttributes)) {
        const key = def.type && def.type.key;
        if (key === 'DECIMAL') decoders.set(attr, 'number');
        else if (key === 'DATE') decoders.set(attr, 'iso');
    }
    decoderCache.set(model.name, decoders);
    return decoders;
}

function decodeRow(row, decoders) {
    const out = {};
    for (const key of Object.keys(row)) {
        if (key === SEQ) continue;
        const value = row[key];
        if (value === null || value === undefined) {
            out[key] = null;
            continue;
        }
        switch (decoders.get(key)) {
            case 'number':
                out[key] = Number(value);
                break;
            case 'iso':
                out[key] = value instanceof Date ? value.toISOString() : value;
                break;
            default:
                out[key] = value;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
//  A key with no column.
//
//  Sequelize writes only its declared attributes, so a field the model does not
//  know would be dropped without a word. That is the one outcome not worth
//  allowing, so it is a hard error naming the file to edit.
// ---------------------------------------------------------------------------
function assertKnownKeys(model, rows) {
    const known = new Set(Object.keys(model.rawAttributes));
    const unknown = new Set();
    for (const row of rows) {
        for (const key of Object.keys(row)) {
            if (!known.has(key)) unknown.add(key);
        }
    }
    if (!unknown.size) return;
    const pascal = model.name.split(/[^a-zA-Z0-9]+/).filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1)).join('');
    throw new Error(
        `[db] ${model.name} has no column for: ${[...unknown].join(', ')}. ` +
        `Add the field to models/${pascal}.js (and database.dbml), then ALTER the table. ` +
        'Refusing to write, because Sequelize would drop the value without saying so.',
    );
}

// ---------------------------------------------------------------------------
//  Tables
// ---------------------------------------------------------------------------

/** Every row of `model`, in stored order. */
async function readAll(model) {
    const rows = await model.findAll({ order: [[SEQ, 'ASC']], raw: true, ...txOptions() });
    const decoders = decodersFor(model);
    return rows.map((r) => decodeRow(r, decoders));
}

// Rows per INSERT. Postgres caps a statement at 65,535 parameters, and batching
// also keeps the largest table (nri_order_master, 32k rows) off a single
// enormous statement.
const MAX_PARAMS = 30_000;

/** Replace every row of `model` with exactly `data`. */
async function replaceAll(model, data) {
    if (!Array.isArray(data)) {
        throw new Error(`[db] ${model.name} expects an array, got ${typeof data}`);
    }
    const rows = data.filter((r) => r && typeof r === 'object');
    assertKnownKeys(model, rows);

    const run = async () => {
        await model.destroy({ where: {}, truncate: false, ...txOptions() });
        if (!rows.length) return;

        // Every attribute is listed explicitly so a key absent from a sparse row
        // is written as NULL rather than left to a column default. Rows are
        // RECTANGLES — see the null-vs-undefined note in database/README.md.
        const fields = Object.keys(model.rawAttributes);
        const rowsPerBatch = Math.max(1, Math.floor(MAX_PARAMS / fields.length));

        for (let start = 0; start < rows.length; start += rowsPerBatch) {
            const batch = rows.slice(start, start + rowsPerBatch).map((row, i) => {
                const record = { [SEQ]: start + i };
                for (const attr of fields) {
                    if (attr === SEQ) continue;
                    record[attr] = row[attr] === undefined ? null : row[attr];
                }
                return record;
            });
            await model.bulkCreate(batch, {
                fields, validate: false, hooks: false, ...txOptions(),
            });
        }
    };

    // Inside a request transaction this joins it, so the whole request still
    // commits or rolls back as one. Outside one (cron poll, a maintenance
    // script) it gets its own, so DELETE + INSERT is never half-applied.
    return withTransaction(run);
}

// ---------------------------------------------------------------------------
//  Documents — whole-file JSON blobs with no row grain (notification_seen).
//  They are not tables and have no model; they live in `_documents`.
// ---------------------------------------------------------------------------

async function readDocument(name) {
    const [row] = await sequelize.query(
        'SELECT data FROM _documents WHERE name = :name',
        { replacements: { name }, type: sequelize.QueryTypes.SELECT, ...txOptions() },
    );
    return row ? row.data : [];
}

async function writeDocument(name, data) {
    return withTransaction(() => sequelize.query(
        // ⚠️ "updatedAt" MUST be quoted. Postgres folds unquoted identifiers to
        // lowercase, so a bare updatedAt becomes `updatedat` and the statement
        // fails with `column "updatedat" does not exist`. Every camelCase column
        // in this database carries the same requirement in hand-written SQL.
        `INSERT INTO _documents (name, data, "updatedAt") VALUES (:name, :data, now())
         ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, "updatedAt" = now()`,
        { replacements: { name, data: JSON.stringify(data) }, ...txOptions() },
    ));
}

function resetCache() {
    decoderCache.clear();
}

module.exports = { readAll, replaceAll, readDocument, writeDocument, resetCache, SEQ };
