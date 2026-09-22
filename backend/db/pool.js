// ---------------------------------------------------------------------------
// The Postgres connection pool, plus the type parsers that keep values looking
// exactly like they did coming out of JSON.parse().
//
// node-pg's defaults are wrong for this codebase in three specific ways, and all
// three are silent — nothing throws, the numbers just quietly change:
//
//   date (OID 1082)   default: returns a JS Date at LOCAL midnight. On this
//                     machine (UTC-7) the stored "2026-05-06" comes back as
//                     2026-05-06T07:00:00.000Z, and anything that slices the
//                     first 10 chars of an ISO string gets the right day only
//                     west of Greenwich. Every crd / e_del / hod / receipt_date
//                     in the portal is a plain calendar date with no time zone,
//                     so the parser is pinned to identity: the string in is the
//                     string out.
//
//   numeric (OID 1700) default: returns a STRING, because arbitrary precision
//                     does not fit a JS double. But the whole app does
//                     `(m.get(k) || 0) + (l.allocated_qty || 0)` — with strings
//                     that is concatenation, so 28 + 5 becomes "285" and a
//                     forecast quietly gains 250,000 units. Every numeric column
//                     here is a price or a quantity well inside double range, and
//                     they were doubles in the JSON, so: parseFloat.
//
//   timestamptz (1184) default: returns a JS Date, which .toISOString()s back to
//                     the exact stored string. That one is correct as-is and is
//                     the reason timestamps can be a real type rather than text.
// ---------------------------------------------------------------------------
const { Pool, types } = require('pg');

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

types.setTypeParser(OID_DATE, identity);
types.setTypeParser(OID_TIMESTAMP, identity);
types.setTypeParser(OID_NUMERIC, toNumber);
types.setTypeParser(OID_FLOAT4, toNumber);
types.setTypeParser(OID_FLOAT8, toNumber);
types.setTypeParser(OID_INT8, toNumber);
// timestamptz keeps pg's default Date parser; db/pgStore.js calls .toISOString().

function connectionString() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    const host = process.env.PGHOST || 'localhost';
    const port = process.env.PGPORT || 5432;
    const user = process.env.PGUSER || 'postgres';
    const pass = process.env.PGPASSWORD || 'postgres';
    const db = process.env.PGDATABASE || 'tentree_portal';
    return `postgres://${user}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
}

const pool = new Pool({
    connectionString: connectionString(),
    max: Number(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
});

// An idle client dying (server restart, docker stop) must not take the process
// with it — the pool discards it and the next checkout reconnects.
pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
});

async function ping() {
    const { rows } = await pool.query('SELECT current_database() AS db, version() AS version');
    return rows[0];
}

module.exports = { pool, ping, connectionString };
