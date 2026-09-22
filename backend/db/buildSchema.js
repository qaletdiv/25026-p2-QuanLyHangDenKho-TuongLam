// ---------------------------------------------------------------------------
// Build the Postgres schema for the portal.
//
// Two inputs, and BOTH are needed:
//   1. database.dbml  — the authoritative declared schema (types, PKs, uniques,
//                       FKs). What the data is SUPPOSED to be.
//   2. data/**.json   — what is actually on disk. The dbml has drifted in places
//                       (users.json carries `role`/`supplier` name strings where
//                       the dbml declares `role_id`/`supplier_id`; seven nri_*
//                       tables and mainline_documents aren't in the dbml at all),
//                       and a column that exists in the data but not the schema
//                       would be silently dropped at load.
//
// So a column set is the UNION of the two, and a column's type is the dbml's
// unless the live values don't round-trip through it, in which case it falls back
// to text and the fallback is REPORTED rather than silently applied.
//
// ROUND-TRIP IS THE WHOLE GAME. Every consumer of this data is JavaScript that
// reads whole tables and compares, sorts and keys on the values it gets back, so
// `readData()` after the migration must hand back what `JSON.parse` handed back
// before it. Two live cases prove why this can't be assumed:
//   • sms_tracking_events.event_time is "2026-07-13T13:02:00-08:00" — an
//     offset-bearing instant. Through timestamptz it comes back as UTC, a
//     DIFFERENT string, and smsTrackingService.js:31 dedupes incoming courier
//     scans on `${shipment_id}|${event_time}|${courier_code}` — so every poll
//     would re-insert every event. That column stays text.
//   • Most other timestamps are canonical "…T20:14:09.137Z" and DO round-trip,
//     so they get to be real timestamptz columns and stay comparable in SQL.
// The rule is applied per column, against the actual values, and recorded.
//
// Output: db/schema.json (the runtime registry pgStore reads) and db/schema.sql
// (the DDL, for review and for `psql -f`).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { load: loadDbml } = require('./dbml');

const BACKEND = path.join(__dirname, '..');
const DATA = path.join(BACKEND, 'data');

// Files whose basename collides with another file's. `statuses.json` (7 legacy
// master-data rows behind /master-data/statuses) and `migrated/statuses.json`
// (21 rows, the module-aware table the dbml describes) are different tables that
// happen to share a name; the legacy one is the one that gets renamed, because
// the migrated one is what the dbml calls `statuses`.
//
// Keyed on the path RELATIVE TO data/, not the basename — keying on the basename
// renames both halves of the collision it exists to resolve.
const TABLE_NAME_OVERRIDES = {
    'statuses.json': 'legacy_statuses',
};

// Files that are not a list of records. notification_seen.json is a per-user map
// of seen notification keys, keyed positionally by user id — it JSON.parses to an
// ARRAY whose element 0 is null, and notificationController treats it as
// `seenMap[req.user.id]`. There is no row grain to model, so it is stored whole
// as a jsonb document and handed back byte-identical.
const DOCUMENT_FILES = new Set(['notification_seen.json']);

// Referenced by a BaseModel somewhere but absent from disk, so readData() has
// always returned []. Created empty so a first write has somewhere to land
// instead of erroring. `shipments/bookings/history*` belong to the frozen
// controllers/reportController.js, which nothing requires any more.
const EMPTY_TABLES = {
    'eom-tasks.json': ['id'],
    'bookings.json': ['id'],
    'shipments.json': ['id'],
    'history.json': ['id'],
    'history-bookings.json': ['id'],
};

// Where the dbml's declared key is demonstrably not the grain the live data is
// at. Each of these was found by trying to create the dbml's constraint and
// having it fail on real rows; the replacement is the key that DOES hold, so the
// table still gets a real uniqueness guarantee instead of none.
const SCHEMA_OVERRIDES = {
    // The dbml declares (module, shipment_id) unique — "one landed cost per
    // shipment". True for SMS (38 rows, po_number always null) but NOT for
    // mainline, which posts PER PO: all 16 mainline rows carry a po_number and
    // their ids read lc_ml_<shipment>_<po>. The dbml simply predates the
    // mainline path (CLAUDE.md: per-PO split, "landed cost keys on the SHIPMENT"
    // was written about SMS). (module, shipment_id, po_number) has 0 duplicates
    // over all 54 rows. NULLS NOT DISTINCT so SMS's null po_number still collides
    // with itself — otherwise the unique would stop protecting the SMS double-post
    // that the posting route's 409 depends on.
    landed_costs: {
        uniques: [{ columns: ['module', 'shipment_id', 'po_number'], nullsNotDistinct: true }],
        replacesDbmlUnique: ['module', 'shipment_id'],
    },
    // netsuite_line_id is declared unique and is the intended PK source
    // (id = spol_ns_<line_id>). The values stored are NOT NetSuite's global
    // transactionline.id — they are the PO's line SEQUENCE (245 distinct values
    // "1".."245" over 4,961 rows), so both the unique and the id collapse. They
    // are unique WITHIN a PO (0 repeats across all 120 POs), so that is the key
    // that can actually be created. See the report — the ids want regenerating.
    sms_po_lines: {
        uniques: [{ columns: ['po_number', 'netsuite_line_id'] }],
        replacesDbmlUnique: ['netsuite_line_id'],
    },
};

// ---------------------------------------------------------------------------

function tableNameFor(relPath) {
    const rel = relPath.replace(/\\/g, '/');
    if (TABLE_NAME_OVERRIDES[rel]) return TABLE_NAME_OVERRIDES[rel];
    return path.basename(rel).replace(/\.json$/, '').replace(/-/g, '_');
}

function listDataFiles() {
    const out = [];
    for (const dir of ['', 'migrated', 'nri']) {
        const abs = path.join(DATA, dir);
        if (!fs.existsSync(abs)) continue;
        for (const f of fs.readdirSync(abs)) {
            if (!f.endsWith('.json')) continue;
            if (!fs.statSync(path.join(abs, f)).isFile()) continue;
            out.push(dir ? `${dir}/${f}` : f);
        }
    }
    return out;
}

/**
 * Merge every row's key order into one column order.
 *
 * Rows are sparse (product_skus alone has 8 distinct shapes), and a plain
 * first-seen union would reorder keys relative to the richest rows. Inserting
 * each unseen key directly after the key that preceded it in ITS row keeps the
 * result close to how the JSON actually reads, which keeps response payloads
 * close to byte-identical.
 */
function mergeKeyOrder(rows) {
    const order = [];
    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        let prevIdx = -1;
        for (const key of Object.keys(row)) {
            const at = order.indexOf(key);
            if (at === -1) {
                order.splice(prevIdx + 1, 0, key);
                prevIdx += 1;
            } else {
                prevIdx = at;
            }
        }
    }
    return order;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Does `v` survive `date` — i.e. is it exactly a calendar date string? */
function roundTripsAsDate(v) {
    return typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v));
}

/**
 * Does `v` survive timestamptz? Postgres keeps the INSTANT, not the text, so the
 * only strings that come back identical are canonical UTC ISO-8601 ones.
 */
function roundTripsAsTimestamp(v) {
    if (typeof v !== 'string') return false;
    const t = Date.parse(v);
    if (Number.isNaN(t)) return false;
    return new Date(t).toISOString() === v;
}

function isPlainObjectOrArray(v) {
    return v !== null && typeof v === 'object';
}

/**
 * Pick a Postgres type for a column from the values actually present, then check
 * the dbml's declared type against it. Returns { pgType, declared, fallback }.
 */
function inferType(values, declaredType) {
    const present = values.filter((v) => v !== null && v !== undefined);

    if (present.length === 0) {
        // No evidence either way — trust the dbml, else text.
        return { pgType: declaredType || 'text', fallback: null };
    }

    let inferred;
    if (present.every(isPlainObjectOrArray)) {
        // json, NOT jsonb. jsonb normalises — it reorders object keys by length
        // then bytewise — so purchase_orders.line_items and nri_rate_card.tiers
        // came back with the same values in a different key order. Nothing
        // queries INSIDE these columns in SQL, which is the only thing jsonb
        // would buy, so json's exact-text storage is the better trade.
        inferred = 'json';
    } else if (present.every((v) => typeof v === 'boolean')) {
        inferred = 'boolean';
    } else if (present.every((v) => typeof v === 'number' && Number.isInteger(v))) {
        inferred = 'integer';
    } else if (present.every((v) => typeof v === 'number')) {
        inferred = 'numeric';
    } else if (present.every(roundTripsAsDate)) {
        inferred = 'date';
    } else if (present.every(roundTripsAsTimestamp)) {
        inferred = 'timestamptz';
    } else {
        inferred = 'text';
    }

    if (!declaredType) return { pgType: inferred, fallback: null };
    if (declaredType === inferred) return { pgType: declaredType, fallback: null };

    // The dbml and the data disagree. The data wins — it is what has to load and
    // what has to come back out unchanged — but say so.
    //
    // A widening that keeps round-trip is not a fallback, it is just the dbml
    // being more precise than one column's sample: integer values in a column the
    // dbml calls decimal are still numeric.
    if (declaredType === 'numeric' && inferred === 'integer') return { pgType: 'numeric', fallback: null };
    if (declaredType === 'text' && (inferred === 'date' || inferred === 'timestamptz')) {
        return { pgType: 'text', fallback: null };
    }
    return {
        pgType: inferred,
        fallback: { declared: declaredType, used: inferred },
    };
}

function build() {
    const dbmlTables = loadDbml();
    const dbmlByName = new Map(dbmlTables.map((t) => [t.name, t]));

    const files = listDataFiles();
    const tables = [];
    const notes = [];
    const documents = [];
    // Kept only to validate foreign keys below — the parent table's rows are
    // needed to know whether a child's values actually resolve.
    const rowsByTable = new Map();

    const seenTableNames = new Map();

    for (const rel of files) {
        const tableName = tableNameFor(rel);
        if (seenTableNames.has(tableName)) {
            notes.push({
                kind: 'name_collision',
                detail: `${rel} and ${seenTableNames.get(tableName)} both map to "${tableName}"`,
            });
            continue;
        }
        seenTableNames.set(tableName, rel);

        const raw = JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8'));

        if (DOCUMENT_FILES.has(path.basename(rel))) {
            documents.push({ file: rel, name: tableName });
            continue;
        }
        if (!Array.isArray(raw)) {
            documents.push({ file: rel, name: tableName });
            notes.push({ kind: 'not_an_array', detail: `${rel} stored as a jsonb document` });
            continue;
        }

        const rows = raw.filter((r) => r && typeof r === 'object');
        if (rows.length !== raw.length) {
            notes.push({ kind: 'non_object_rows', detail: `${rel}: ${raw.length - rows.length} non-object entries` });
        }

        const dbml = dbmlByName.get(tableName);
        const declared = new Map((dbml ? dbml.columns : []).map((c) => [c.name, c]));

        const observedOrder = mergeKeyOrder(rows);
        const columnNames = [...observedOrder];
        for (const c of (dbml ? dbml.columns : [])) {
            if (!columnNames.includes(c.name)) columnNames.push(c.name);
        }

        const columns = columnNames.map((name) => {
            const d = declared.get(name);
            const values = rows.map((r) => r[name]);
            const { pgType, fallback } = inferType(values, d ? d.pgType : null);
            if (fallback) {
                notes.push({
                    kind: 'type_fallback',
                    table: tableName,
                    column: name,
                    detail: `dbml says ${fallback.declared}, live values need ${fallback.used}`,
                });
            }
            const hasValue = values.some((v) => v !== null && v !== undefined);
            return {
                name,
                type: pgType,
                // NOT NULL is only honoured when the data actually satisfies it —
                // a declared-but-violated constraint would block the load rather
                // than inform anyone.
                notNull: Boolean(d && d.notNull) && rows.length > 0
                    && values.every((v) => v !== null && v !== undefined),
                declaredNotNull: Boolean(d && d.notNull),
                inDbml: Boolean(d),
                inData: hasValue || observedOrder.includes(name),
            };
        });

        // -- primary key ----------------------------------------------------
        let primaryKey = null;
        if (dbml) {
            const pkCols = dbml.columns.filter((c) => c.pk).map((c) => c.name);
            const pkIndex = dbml.indexes.find((i) => i.pk);
            if (pkCols.length) primaryKey = pkCols;
            else if (pkIndex) primaryKey = pkIndex.columns;
        }
        if (!primaryKey && columnNames.includes('id')) primaryKey = ['id'];

        // A declared PK that the live data violates cannot be created. Report it
        // — a duplicate or null key is a finding, not a reason to give up on the
        // rest of the table's constraints.
        if (primaryKey) {
            const bad = pkViolation(rows, primaryKey);
            if (bad) {
                notes.push({ kind: 'pk_violation', table: tableName, detail: `${primaryKey.join('+')}: ${bad}` });
                primaryKey = null;
            }
        }

        // -- unique indexes --------------------------------------------------
        const override = SCHEMA_OVERRIDES[tableName];
        const uniques = [];
        if (dbml) {
            for (const c of dbml.columns) {
                if (c.unique && columnNames.includes(c.name)) uniques.push({ columns: [c.name] });
            }
            for (const i of dbml.indexes) {
                if (!i.unique) continue;
                if (i.columns.every((c) => columnNames.includes(c))) uniques.push({ columns: i.columns });
            }
        }
        if (override) {
            for (const u of override.uniques) uniques.push(u);
        }

        const keptUniques = [];
        for (const u of uniques) {
            const cols = u.columns;
            if (primaryKey && sameCols(cols, primaryKey)) continue;
            if (keptUniques.some((k) => sameCols(k.columns, cols))) continue;
            const bad = uniqueViolation(rows, cols, u.nullsNotDistinct);
            if (bad) {
                // A dbml unique that an override already replaces is expected to
                // fail — that is why the override exists. Note it as superseded so
                // the real violations in the report stay legible.
                const superseded = override && override.replacesDbmlUnique
                    && sameCols(cols, override.replacesDbmlUnique);
                notes.push({
                    kind: superseded ? 'unique_superseded' : 'unique_violation',
                    table: tableName,
                    detail: `${cols.join('+')}: ${bad}`,
                });
                continue;
            }
            keptUniques.push({ columns: cols, nullsNotDistinct: Boolean(u.nullsNotDistinct) });
        }

        // -- non-unique lookup indexes --------------------------------------
        const indexes = (dbml ? dbml.indexes : [])
            .filter((i) => !i.unique && !i.pk && i.columns.every((c) => columnNames.includes(c)))
            .map((i) => i.columns);

        rowsByTable.set(tableName, rows);
        tables.push({
            name: tableName,
            file: rel,
            columns,
            primaryKey,
            uniques: keptUniques,
            indexes,
            refs: dbml ? dbml.refs : [],
            rowCount: rows.length,
            inDbml: Boolean(dbml),
        });
    }

    // Tables a BaseModel points at that have no file on disk.
    for (const [file, cols] of Object.entries(EMPTY_TABLES)) {
        const name = tableNameFor(file);
        if (seenTableNames.has(name)) continue;
        seenTableNames.set(name, file);
        tables.push({
            name,
            file,
            columns: cols.map((c) => ({ name: c, type: 'text', notNull: false, declaredNotNull: false, inDbml: false, inData: false })),
            primaryKey: ['id'],
            uniques: [],
            indexes: [],
            refs: [],
            rowCount: 0,
            inDbml: false,
            placeholder: true,
        });
    }

    // -- foreign keys --------------------------------------------------------
    // Three things have to hold before a FK can be created, and each failure is
    // worth a different note:
    //   • the target table exists;
    //   • the target column is a PK or a unique — Postgres will not reference
    //     anything else;
    //   • every non-null value in the child column has a parent. A declared FK
    //     the data violates cannot be created, and the orphans are the finding.
    const byName = new Map(tables.map((t) => [t.name, t]));
    const foreignKeys = [];
    for (const t of tables) {
        for (const ref of t.refs) {
            const target = byName.get(ref.table);
            if (!target) {
                notes.push({ kind: 'fk_skipped', table: t.name, detail: `${ref.column} → ${ref.table}.${ref.refColumn} (no such table)` });
                continue;
            }
            if (!t.columns.some((c) => c.name === ref.column)) continue;
            const targetIsKey = (target.primaryKey && sameCols(target.primaryKey, [ref.refColumn]))
                || target.uniques.some((u) => !u.nullsNotDistinct && sameCols(u.columns, [ref.refColumn]));
            if (!targetIsKey) {
                notes.push({ kind: 'fk_skipped', table: t.name, detail: `${ref.column} → ${ref.table}.${ref.refColumn} (target is not a key)` });
                continue;
            }
            const orphans = orphanCheck(rowsByTable.get(t.name) || [], ref.column, rowsByTable.get(ref.table) || [], ref.refColumn);
            if (orphans) {
                notes.push({
                    kind: 'fk_violation',
                    table: t.name,
                    detail: `${ref.column} → ${ref.table}.${ref.refColumn}: ${orphans}`,
                });
                continue;
            }
            foreignKeys.push({ table: t.name, column: ref.column, refTable: ref.table, refColumn: ref.refColumn });
        }
    }

    return { tables, documents, foreignKeys, notes };
}

function sameCols(a, b) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Do all of `childRows[column]` resolve to a `parentRows[refColumn]`?
 * NULL is not an orphan — an optional reference is simply absent.
 * Compared as strings because ids are text columns but some JSON holds them as
 * numbers (sms_shipments.shipment_id is "39" in one table, 39 in another).
 */
function orphanCheck(childRows, column, parentRows, refColumn) {
    const keys = new Set(parentRows.map((r) => String(r[refColumn])));
    const missing = new Map();
    for (const r of childRows) {
        const v = r[column];
        if (v === undefined || v === null) continue;
        const k = String(v);
        if (!keys.has(k)) missing.set(k, (missing.get(k) || 0) + 1);
    }
    if (!missing.size) return null;
    const rows = [...missing.values()].reduce((a, b) => a + b, 0);
    const sample = [...missing.keys()].slice(0, 3).join(', ');
    return `${rows} row(s) reference ${missing.size} missing key(s), e.g. ${sample}`;
}

function keyOf(row, cols) {
    return cols.map((c) => (row[c] === undefined || row[c] === null ? '\u0000NULL' : String(row[c]))).join('\u0001');
}

function pkViolation(rows, cols) {
    const seen = new Set();
    for (const r of rows) {
        for (const c of cols) {
            if (r[c] === undefined || r[c] === null) return `null in ${c}`;
        }
        const k = keyOf(r, cols);
        if (seen.has(k)) return `duplicate ${k.replace(/\u0001/g, '+')}`;
        seen.add(k);
    }
    return null;
}

/**
 * Postgres treats NULLs as distinct in a unique index by default, so null-bearing
 * keys are skipped here to match — unless the index is NULLS NOT DISTINCT, in
 * which case they collide like any other value and have to be checked.
 */
function uniqueViolation(rows, cols, nullsNotDistinct = false) {
    const seen = new Set();
    let dupes = 0;
    let example = '';
    for (const r of rows) {
        if (!nullsNotDistinct && cols.some((c) => r[c] === undefined || r[c] === null)) continue;
        const k = keyOf(r, cols);
        if (seen.has(k)) {
            dupes += 1;
            if (!example) example = k.replace(/\u0001/g, '+');
        }
        seen.add(k);
    }
    return dupes ? `${dupes} duplicate row(s), e.g. ${example}` : null;
}

// ---------------------------------------------------------------------------
//  DDL
// ---------------------------------------------------------------------------

const q = (id) => `"${id}"`;

function toSql({ tables, foreignKeys }) {
    const out = [];
    out.push('-- GENERATED by backend/db/buildSchema.js from database.dbml + data/**.json.');
    out.push('-- Do not edit by hand: edit database.dbml and re-run `node db/buildSchema.js`.');
    out.push('');
    out.push('BEGIN;');
    out.push('');
    out.push('-- Whole-file JSON blobs that have no row grain (see DOCUMENT_FILES).');
    out.push('CREATE TABLE IF NOT EXISTS _documents (');
    out.push('    name       text PRIMARY KEY,');
    out.push('    data       json NOT NULL,');
    out.push('    updated_at timestamptz NOT NULL DEFAULT now()');
    out.push(');');
    out.push('');

    out.push('-- _seq preserves the ORDER the JSON array had. SQL has no inherent row');
    out.push('-- order, and this codebase depends on the file order in places it states');
    out.push('-- outright: plGenerator takes rows[0] of a carton group, the receipt');
    out.push('-- matcher walks "first still-free IR", and CLAUDE.md records a bug where');
    out.push('-- reversing row order changed 25 of 34 packing summaries. Every read is');
    out.push('-- ORDER BY _seq so that order survives the move.');
    out.push('');

    for (const t of tables) {
        const lines = t.columns.map((c) => `    ${q(c.name)} ${c.type}${c.notNull ? ' NOT NULL' : ''}`);
        lines.push('    _seq bigint NOT NULL');
        if (t.primaryKey) lines.push(`    PRIMARY KEY (${t.primaryKey.map(q).join(', ')})`);
        out.push(`CREATE TABLE IF NOT EXISTS ${q(t.name)} (`);
        out.push(lines.join(',\n'));
        out.push(');');
        for (const u of t.uniques) {
            const nd = u.nullsNotDistinct ? ' NULLS NOT DISTINCT' : '';
            out.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${q(`${t.name}_${u.columns.join('_')}_uniq`)} ` +
                `ON ${q(t.name)} (${u.columns.map(q).join(', ')})${nd};`);
        }
        for (const i of t.indexes) {
            out.push(`CREATE INDEX IF NOT EXISTS ${q(`${t.name}_${i.join('_')}_idx`)} ON ${q(t.name)} (${i.map(q).join(', ')});`);
        }
        out.push('');
    }

    out.push('-- Foreign keys are DEFERRABLE INITIALLY DEFERRED: the app writes whole tables');
    out.push('-- one at a time (BaseModel.write), so a delete that spans a parent and its');
    out.push('-- children is momentarily inconsistent mid-request and only has to balance at');
    out.push('-- COMMIT. db/txContext.js wraps each HTTP request in one transaction so that');
    out.push('-- is exactly when it is checked.');
    for (const fk of foreignKeys) {
        const name = `${fk.table}_${fk.column}_fkey`;
        out.push(`ALTER TABLE ${q(fk.table)} ADD CONSTRAINT ${q(name)} FOREIGN KEY (${q(fk.column)}) ` +
            `REFERENCES ${q(fk.refTable)} (${q(fk.refColumn)}) DEFERRABLE INITIALLY DEFERRED;`);
    }
    out.push('');
    out.push('COMMIT;');
    out.push('');
    return out.join('\n');
}

if (require.main === module) {
    const schema = build();
    fs.writeFileSync(path.join(__dirname, 'schema.json'), JSON.stringify(schema, null, 2));
    fs.writeFileSync(path.join(__dirname, 'schema.sql'), toSql(schema));

    const cols = schema.tables.reduce((n, t) => n + t.columns.length, 0);
    console.log(`tables      ${schema.tables.length}`);
    console.log(`columns     ${cols}`);
    console.log(`documents   ${schema.documents.length}`);
    console.log(`foreign keys${String(schema.foreignKeys.length).padStart(4)}`);
    console.log(`rows        ${schema.tables.reduce((n, t) => n + t.rowCount, 0)}`);
    if (schema.notes.length) {
        console.log(`\n${schema.notes.length} note(s):`);
        for (const n of schema.notes) {
            console.log(`  [${n.kind}] ${n.table ? n.table + '.' : ''}${n.column || ''} ${n.detail}`);
        }
    }
}

module.exports = { build, toSql, tableNameFor, DOCUMENT_FILES };
