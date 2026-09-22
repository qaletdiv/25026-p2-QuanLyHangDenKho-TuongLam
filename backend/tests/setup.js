// Close the Postgres pool when a test file finishes.
//
// tests/api.test.js requires server.js, which opens the connection pool at load
// (driveStorage → db/pgStore → db/pool). An open pool is an active libuv handle,
// so without this Jest reports "did not exit one second after the test run" and
// hangs until it is killed. Nothing here runs when DATA_BACKEND=json, which
// never requires the pool in the first place.
afterAll(async () => {
    if ((process.env.DATA_BACKEND || 'postgres').toLowerCase() !== 'postgres') return;
    const { pool } = require('../db/pool');
    await pool.end().catch(() => { /* already closed */ });
});
