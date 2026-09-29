// Close the Sequelize connection pool when a test file finishes.
//
// tests/api.test.js requires src/app.js, which opens the pool at load
// (routes → models → database/modelStore → database/sequelize). An open pool is an
// active libuv handle, so without this Jest reports "did not exit one second
// after the test run" and hangs until it is killed.
afterAll(async () => {
    const { sequelize } = require('../database/sequelize');
    await sequelize.close().catch(() => { /* already closed */ });
});
