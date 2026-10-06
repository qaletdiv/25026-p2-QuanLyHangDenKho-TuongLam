'use strict';

// nri_gl_rules — "this NRI service posts to GL X", set on All Invoices → GL Codes.
//
// The coding legend (nri_charge_codes) is the base: it says which GL each service
// posts to, and it is what a BOOKED file is coded by — so it is never edited from
// this page, and a booked month can never be re-coded by a change here. A row in
// this table overrides the legend for files NOT marked Booked only (the same
// boundary as the channel rules), and a line someone coded by hand keeps its GL.
//
// EFFECTIVE BY MONTH (2026-10-01, per Lam — "the service could differ by month").
// A file belongs to its invoice's PERIOD-END month. Saving a month stores that
// month's COMPLETE service → GL list (one row per service, GL may equal the
// legend's); a month with no rows of its own uses the latest earlier month that
// has them, else the legend. So a change carries forward until changed again.
//
// No `_seq` — replaced per entity with destroy + bulkCreate, like nri_class_rules.

module.exports = (sequelize, DataTypes) => sequelize.define('nri_gl_rules', {
    id:        { type: DataTypes.TEXT, primaryKey: true },   // ngr_<entity>_<month>_<n>
    entity:    { type: DataTypes.TEXT, allowNull: false },   // US | CA
    month:     { type: DataTypes.TEXT, allowNull: false },   // YYYY-MM — applies from this period-end month
    service:   { type: DataTypes.TEXT, allowNull: false },   // the NRI service name
    gl:        { type: DataTypes.INTEGER, allowNull: false },
    // the GL on a WHOLESALE ORDER, where it differs from `gl` (2026-10-05) — e.g.
    // Warehouse / Data Entry Labour on a wholesale fulfillment is fulfilment (5211),
    // not an Extra Charge. NULL = same as `gl`.
    glWholesaleOrder: { type: DataTypes.INTEGER },
    updatedAt: { type: DataTypes.TEXT },
    updatedBy: { type: DataTypes.TEXT },
}, {
    tableName: 'nri_gl_rules',
    indexes: [{ unique: true, fields: ['entity', 'month', 'service'] }],
});
