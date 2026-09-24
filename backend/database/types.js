// ---------------------------------------------------------------------------
// The node-pg type parsers this codebase cannot run without.
//
// These used to live in db/pool.js. They are extracted here because they are now
// needed by TWO consumers — the Sequelize instance and anything still holding a
// raw pg client — and a second copy of them is exactly the kind of thing that
// drifts and then silently changes a number in a report.
//
// node-pg's defaults are wrong for this codebase in three specific ways, and all
// three are SILENT. Nothing throws; the values just quietly change:
//
//   date (OID 1082)   default: a JS Date at LOCAL midnight. On this machine
//                     (UTC-7) the stored "2026-05-06" comes back as
//                     2026-05-06T07:00:00.000Z, so anything slicing the first 10
//                     chars of an ISO string gets the right day only west of
//                     Greenwich. Every crd / eDel / hod / receiptDate in the
//                     portal is a plain calendar date with no zone, so the parser
//                     is pinned to identity: the string in is the string out.
//
//   numeric (OID 1700) default: a STRING, because arbitrary precision does not
//                     fit a JS double. But this app is built on
//                     `(m.get(k) || 0) + (l.allocatedQty || 0)` — with strings
//                     that is CONCATENATION, so 28 + 5 becomes "285" and a
//                     forecast quietly gains 250,000 units. Every numeric column
//                     here is a price or a quantity well inside double range.
//
//   timestamptz (1184) default: a JS Date, which .toISOString()s back to exactly
//                     the stored string. That one is correct as-is, and is why
//                     timestamps can be a real type rather than text.
//
// ⚠️ Sequelize does its own parsing for some types on top of pg's. Do not assume
// these pins are sufficient on their own — database/modelStore.js decodes a second time
// against each model's declared attribute types, and database/verify.js proves the
// result matches the raw pg path value for value.
// ---------------------------------------------------------------------------
const { types } = require('pg');

// OIDs — pg exports these only as numbers, so they are named here.
const OID_INT8 = 20;
const OID_FLOAT4 = 700;
const OID_FLOAT8 = 701;
const OID_NUMERIC = 1700;
const OID_DATE = 1082;
const OID_TIMESTAMP = 1114;
const OID_TIMESTAMPTZ = 1184;

const identity = (v) => v;
const toNumber = (v) => (v === null ? null : Number(v));

let applied = false;

/** Pin the parsers. Idempotent — pg keeps one global registry. */
function applyTypeParsers() {
    if (applied) return;
    types.setTypeParser(OID_DATE, identity);
    types.setTypeParser(OID_TIMESTAMP, identity);
    types.setTypeParser(OID_NUMERIC, toNumber);
    types.setTypeParser(OID_FLOAT4, toNumber);
    types.setTypeParser(OID_FLOAT8, toNumber);
    types.setTypeParser(OID_INT8, toNumber);
    // timestamptz keeps pg's default Date parser; the store calls .toISOString().
    applied = true;
}

/** Connection string, from DATABASE_URL or the PG* parts. */
function connectionString() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    const host = process.env.PGHOST || 'localhost';
    const port = process.env.PGPORT || 5432;
    const user = process.env.PGUSER || 'postgres';
    const pass = process.env.PGPASSWORD || 'postgres';
    const db = process.env.PGDATABASE || 'tentree_portal';
    return `postgres://${user}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
}

module.exports = {
    applyTypeParsers,
    connectionString,
    OID_DATE,
    OID_NUMERIC,
    OID_TIMESTAMPTZ,
};
