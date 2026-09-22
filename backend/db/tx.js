// ---------------------------------------------------------------------------
// The backend-agnostic way to ask for atomicity outside an HTTP request.
//
// Inside a request, db/txContext.js already wraps the whole thing — controllers
// need nothing. This is for the code that runs on its own: the maintenance
// scripts and the cron jobs, which write several tables in a row and, on the
// JSON stack, could be interrupted between two of them.
//
// Degrades honestly: with DATA_BACKEND=json there are no transactions to be had,
// so `fn` simply runs and the writes are sequential exactly as they always were.
// Callers do not branch on the backend, and nothing requires db/pool.js (and so
// nothing opens a connection pool) unless Postgres is actually in use.
// ---------------------------------------------------------------------------
const onPostgres = () => (process.env.DATA_BACKEND || 'postgres').toLowerCase() === 'postgres';

/** Run `fn` in one transaction when the backend has them; otherwise just run it. */
async function atomically(fn) {
    if (!onPostgres()) return fn();
    return require('./txContext').withTransaction(fn);
}

/**
 * Release the connection pool so a script's process can exit. An open pool is an
 * active libuv handle, so without this a finished script hangs instead of
 * returning to the shell.
 */
async function shutdown() {
    if (!onPostgres()) return;
    await require('./pool').pool.end().catch(() => { /* already closed */ });
}

module.exports = { atomically, shutdown, onPostgres };
