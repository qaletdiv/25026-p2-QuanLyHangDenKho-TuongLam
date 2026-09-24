// ---------------------------------------------------------------------------
// The one Sequelize instance. Every model in models/ is defined on it, and
// every query the portal makes goes through it.
//
// WHY THE `define` BLOCK MATTERS MORE THAN IT LOOKS:
//
//   timestamps: false      Sequelize adds createdAt/updatedAt to every model by
//                          default and then SELECTs them. These tables do not
//                          have those columns; the portal's own audit fields are
//                          named things like `approvedAt` and `generatedAt`.
//                          Leaving this on would break every read.
//
//   freezeTableName: true  Sequelize pluralises model names into table names by
//                          default. The table names here are fixed by the data
//                          (`po_masters`, `sms_pos`, `notify_party`) and several
//                          do not pluralise the way its inflector expects —
//                          `sms_pos` would become `sms_pos` but `notify_party`
//                          would become `notify_parties`, which does not exist.
//
//   underscored: false     Column names are already snake_case in the data and
//                          are used verbatim by 193 call sites. No mapping.
//
// CONNECTION POOL. Sequelize owns its own pool, which is the reason
// database/txContext.js had to move onto Sequelize transactions at the same time: a
// raw pg client checked out of a SECOND pool would not be inside the request's
// transaction, so writes would self-commit and the atomicity the migration
// bought would be silently gone.
// ---------------------------------------------------------------------------
const { Sequelize } = require('sequelize');
const { applyTypeParsers, connectionString } = require('./types');

// Must happen before the first connection is made.
applyTypeParsers();

const sequelize = new Sequelize(connectionString(), {
    dialect: 'postgres',
    logging: process.env.SEQUELIZE_LOG === '1' ? console.log : false,
    pool: {
        max: Number(process.env.PGPOOL_MAX || 10),
        min: 0,
        idle: 30_000,
        acquire: 10_000,
    },
    define: {
        timestamps: false,
        freezeTableName: true,
        underscored: false,
    },
    // Keep bigints as JS numbers, matching the OID_INT8 parser in database/types.js.
    // Every count and quantity here is well inside double range.
    dialectOptions: {},
});

/** Confirm the database is reachable. Returns { db, version }. */
async function ping() {
    const [row] = await sequelize.query(
        'SELECT current_database() AS db, version() AS version',
        { type: Sequelize.QueryTypes.SELECT },
    );
    return row;
}

/** Close the pool so a script's process can exit. */
async function close() {
    await sequelize.close().catch(() => { /* already closed */ });
}

module.exports = { sequelize, Sequelize, ping, close, connectionString };
