// Entry point — pings the database, starts the cron scheduler, binds the port.
//
// The express app itself is built in app.js and exported from there, so tests
// (and anything else that wants to drive the API in-process) can require the
// app without this file running and occupying port 5000.
require('./config/env');
const { PORT } = require('./config/env');
const app = require('./app');
const { initCronJobs } = require('./services/cronJobs');

// ⚠️ Every `node src/server.js` starts its OWN cron scheduler — two processes
// means two SMS tracking polls, two SMS NetSuite syncs and two mainline PO
// syncs, i.e. concurrent writers against one database each rebuilding tables
// the other is reading. Check for strays before starting a second one; see the
// verification-harness note in CLAUDE.md.

// A failed ping must NOT stop the server coming up. Postgres here runs in a
// container that can be down for reasons that have nothing to do with the app
// (the WSL distro idling out takes dockerd with it), and refusing to boot would
// turn a database blip into "the portal is gone until someone restarts node".
// Sequelize reconnects by itself, so the next request after Postgres returns
// simply works.
//
// `.catch` also matters on its own terms: an unhandled rejection here is FATAL
// in Node 24 and would take the process down before app.listen ran.
require('./config/db').ping().then((info) => {
    console.log(`Data backend: PostgreSQL (${info.db}) via Sequelize.`);
}).catch((e) => {
    const { connectionString } = require('./config/db');
    console.error('='.repeat(72));
    console.error(`Data backend: PostgreSQL — CANNOT CONNECT (${e.code || e.message}).`);
    console.error('The server is starting anyway and will reconnect on its own, but every');
    console.error('request that touches data will fail until the database is reachable.');
    console.error(`  connection: ${connectionString().replace(/:[^:@/]*@/, ':****@')}`);
    console.error('  if it runs in WSL:  wsl -e docker start some-postgres');
    console.error('='.repeat(72));
}).then(() => {
    initCronJobs();
    app.listen(PORT, () => {
        console.log(`Server is listening at http://localhost:${PORT}`);
    });
});

module.exports = app;
