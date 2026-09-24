// ---------------------------------------------------------------------------
// The way to ask for atomicity OUTSIDE an HTTP request.
//
// Inside a request, database/txContext.js already wraps the whole thing — controllers
// need nothing. This is for the code that runs on its own: the maintenance
// scripts and the cron jobs, which write several tables in a row and could
// otherwise be interrupted between two of them.
// ---------------------------------------------------------------------------
const { withTransaction } = require('./txContext');

/** Run `fn` in one transaction. */
async function atomically(fn) {
    return withTransaction(fn);
}

/**
 * Release the connection pool so a script's process can exit. An open pool is
 * an active libuv handle, so without this a finished script hangs instead of
 * returning to the shell.
 */
async function shutdown() {
    await require('./sequelize').close();
}

module.exports = { atomically, shutdown };
