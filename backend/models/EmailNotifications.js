'use strict';

// Audit log of notification email. APPEND-ONLY, and deliberately the one table
// in this schema that is NOT derived and NOT whole-table-replaced: it records
// what left the building, which is unknowable from current state.
//
// ⚠️ NO FOREIGN KEYS, ON PURPOSE. `entityId` and `actorId` are plain text. A log
// entry must outlive the thing it describes — the most interesting question this
// table answers is "what did we tell people about the booking that was later
// deleted?", and an FK would either block that delete or cascade the evidence
// away. Recipients are stored as the literal addresses mailed, not user ids, for
// the same reason: the record is of what happened, not of what the roster says
// today.
//
// Written with models.email_notifications.create() — NOT .write(), which
// replaces the whole table (see models/index.js).

module.exports = (sequelize, DataTypes) => sequelize.define('email_notifications', {
    id:         { type: DataTypes.TEXT, primaryKey: true },
    eventType:  { type: DataTypes.TEXT, allowNull: false },   // booking_status, shipment_updated, …
    module:     { type: DataTypes.TEXT, allowNull: false },   // mainline | sms
    entity:     { type: DataTypes.TEXT, allowNull: false },   // mainline_shipment, sms_booking, …
    entityId:   { type: DataTypes.TEXT, allowNull: false },
    subject:    { type: DataTypes.TEXT, allowNull: false },
    recipients: { type: DataTypes.TEXT, allowNull: false },   // comma-separated addresses AS MAILED
    // sent = SMTP accepted it · outbox = written to storage/outbox as .eml
    // skipped = nothing to do (no recipients / switched off) · failed = see detail
    status:     { type: DataTypes.TEXT, allowNull: false },
    detail:     { type: DataTypes.TEXT },                     // message id, outbox path, or the error
    actorId:    { type: DataTypes.TEXT },
    createdAt:  { type: DataTypes.TEXT, allowNull: false },
}, {
    tableName: 'email_notifications',
    indexes: [
        { fields: ['entity', 'entityId'] },
        { fields: ['createdAt'] },
    ],
});
