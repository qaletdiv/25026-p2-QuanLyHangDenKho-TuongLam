// ---------------------------------------------------------------------------
// A small parser for the subset of DBML that database.dbml actually uses.
//
// database.dbml is the authoritative schema (CLAUDE.md, "3NF discipline"), so the
// Postgres DDL is GENERATED from it rather than hand-maintained alongside it —
// a hand-written schema.sql would be a second source of truth and would drift the
// first time someone edits one and not the other.
//
// Understood subset: `Table x { col type [settings] ... indexes { (a,b) [unique] } }`,
// inline `ref:` settings, `pk` / `unique` / `not null` / `default:` / `note:`, and
// `//` comments. Everything else in the file (the header essays, the trailing VIEWS
// block) is prose and is skipped.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const DBML_PATH = path.join(__dirname, '..', 'database.dbml');

// DBML type -> Postgres type. The DBML says `varchar` with no length everywhere,
// which in Postgres is just `text`; using text avoids inventing length limits the
// JSON data never had and that nothing validates.
const TYPE_MAP = {
    varchar: 'text',
    text: 'text',
    integer: 'integer',
    int: 'integer',
    decimal: 'numeric',
    boolean: 'boolean',
    date: 'date',
    timestamp: 'timestamptz',
};

function stripComment(line) {
    // No string literal in this file contains "//", so a plain split is safe.
    const i = line.indexOf('//');
    return (i === -1 ? line : line.slice(0, i)).trim();
}

/** Split `[a, b: c, note: 'x, y']` on commas that are not inside quotes. */
function splitSettings(s) {
    const out = [];
    let depth = 0, quote = null, cur = '';
    for (const ch of s) {
        if (quote) {
            if (ch === quote) quote = null;
            cur += ch;
        } else if (ch === "'" || ch === '"') {
            quote = ch; cur += ch;
        } else if (ch === '[' || ch === '(') { depth++; cur += ch; }
        else if (ch === ']' || ch === ')') { depth--; cur += ch; }
        else if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
        else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

function parse(dbmlText) {
    const lines = dbmlText.split(/\r?\n/);
    const tables = [];
    let table = null;
    let inIndexes = false;

    for (const raw of lines) {
        const line = stripComment(raw);
        if (!line) continue;

        if (!table) {
            const m = line.match(/^Table\s+([A-Za-z_][\w]*)\s*(?:as\s+\w+\s*)?\{/);
            if (m) table = { name: m[1], columns: [], indexes: [], refs: [] };
            continue;
        }

        if (inIndexes) {
            if (line === '}') { inIndexes = false; continue; }
            // `(a, b) [unique]`  |  `(a, b) [pk]`  |  `(a, b)`  |  `col [unique]`
            const m = line.match(/^\(?([^)\[]+?)\)?\s*(?:\[([^\]]*)\])?$/);
            if (!m) continue;
            const cols = m[1].split(',').map((c) => c.trim()).filter(Boolean);
            const settings = splitSettings(m[2] || '');
            table.indexes.push({
                columns: cols,
                unique: settings.some((s) => s === 'unique'),
                pk: settings.some((s) => s === 'pk'),
            });
            continue;
        }

        if (line.startsWith('indexes')) {
            inIndexes = !line.includes('}');
            if (line.includes('}')) {
                // single-line `indexes { (a, b) [unique] }`
                const inner = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}')).trim();
                const m = inner.match(/^\(?([^)\[]+?)\)?\s*(?:\[([^\]]*)\])?$/);
                if (m) {
                    const settings = splitSettings(m[2] || '');
                    table.indexes.push({
                        columns: m[1].split(',').map((c) => c.trim()).filter(Boolean),
                        unique: settings.some((s) => s === 'unique'),
                        pk: settings.some((s) => s === 'pk'),
                    });
                }
            }
            continue;
        }

        if (line === '}') { tables.push(table); table = null; continue; }

        // column: `name type [settings]`
        const m = line.match(/^([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*)\s*(?:\[(.*)\])?\s*$/);
        if (!m) continue;
        const [, name, dbmlType, settingsRaw] = m;
        const pgType = TYPE_MAP[dbmlType.toLowerCase()];
        if (!pgType) continue; // not a column line we understand

        const settings = splitSettings(settingsRaw || '');
        const col = {
            name,
            dbmlType,
            pgType,
            pk: false,
            unique: false,
            notNull: false,
            default: null,
        };
        for (const s of settings) {
            if (s === 'pk' || s === 'primary key') col.pk = true;
            else if (s === 'unique') col.unique = true;
            else if (s === 'not null') col.notNull = true;
            else if (/^default:/.test(s)) col.default = s.replace(/^default:\s*/, '').trim();
            else if (/^ref:/.test(s)) {
                // `ref: > other.col` (many-to-one) | `ref: - other.col` (one-to-one)
                const r = s.match(/^ref:\s*([<>-])\s*([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)/);
                if (r) table.refs.push({ column: name, table: r[2], refColumn: r[3], oneToOne: r[1] === '-' });
            }
        }
        table.columns.push(col);
    }
    return tables;
}

function load() {
    return parse(fs.readFileSync(DBML_PATH, 'utf8'));
}

module.exports = { parse, load, TYPE_MAP, DBML_PATH };
