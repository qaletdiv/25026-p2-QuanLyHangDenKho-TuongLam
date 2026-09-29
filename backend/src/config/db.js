'use strict';
// Database connection entry point.
//
// ⚠️ This is a FACADE, on purpose. The connection itself lives in
// `backend/database/sequelize.js`, and `database/` sits OUTSIDE `src/` because
// it carries `seed-data/` (~85k rows) — data, not source. Moving the connection
// in here would make the data layer (`database/modelStore`, `database/txContext`,
// `database/verify`) depend on `src/`, which is backwards: src/ consumes the data
// layer, never the other way round.
//
// So `config/db.js` is where application code ASKS for the connection, and
// `database/` is where the connection, the pool, the type parsers and the
// per-request transactions are implemented. Read `database/README.md` before
// changing anything behind this line.
//
// ⚠️ `database/types.js` is load-bearing: node-pg returns `date` as a JS Date at
// LOCAL midnight (shifting every CRD/E-DEL by a day) and `numeric` as a STRING
// (so `28 + 5` becomes `"285"`). Both are pinned there. Do not remove them.
require('./env');

const { sequelize, Sequelize, ping, close, connectionString } = require('../../database/sequelize');

module.exports = { sequelize, Sequelize, ping, close, connectionString };
