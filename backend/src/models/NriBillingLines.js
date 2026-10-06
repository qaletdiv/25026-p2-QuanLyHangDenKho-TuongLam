'use strict';

// nri_billing_lines — every charge line of every uploaded NRI invoice report,
// exactly as NRI sent it, plus the two HUMAN decisions the workbook kept in its
// "Manual Class Override" / "Manual GL Code Override" columns.
//
// Everything else the workbook's Summary_Coded table held — Netsuite GL, GL
// Description, Class, Revised Class/GL/Desc, MMM-YYYY, Order Type — is DERIVED per
// read (services/nriBillingService.js) and deliberately not stored: they move when
// the coding legend or the order data moves, the same way a workbook refresh did.
//
// Overrides sit ON the line, not in a side table: (file, orderId, service) is
// unique on all 52,705 lines of the 2026 workbook, so a line is the natural grain
// and re-uploading a file carries them across by that key.
//
// Money is DECIMAL — Sequelize returns it as a STRING; nriBillingService.toLine()
// is the one place that turns it back into a number.

const { Deferrable } = require('sequelize');

module.exports = (sequelize, DataTypes) => sequelize.define('nri_billing_lines', {
    id:            { type: DataTypes.TEXT, primaryKey: true },  // <fileId>_<seq>
    fileId:        {
        type: DataTypes.TEXT,
        allowNull: false,
        references: { model: 'nri_billing_files', key: 'id', deferrable: Deferrable.INITIALLY_DEFERRED },
    },
    seq:           { type: DataTypes.INTEGER, allowNull: false }, // row order in the file (the workbook's Index)
    orderId:       { type: DataTypes.TEXT },
    clientRef1:    { type: DataTypes.TEXT },
    clientRef2:    { type: DataTypes.TEXT },
    customer:      { type: DataTypes.TEXT },
    poNumber:      { type: DataTypes.TEXT },
    docDate:       { type: DataTypes.DATEONLY },
    completed:     { type: DataTypes.DATEONLY },
    units:         { type: DataTypes.DECIMAL(14, 2) },
    value:         { type: DataTypes.DECIMAL(14, 2) },
    service:       { type: DataTypes.TEXT },
    charges:       { type: DataTypes.DECIMAL(14, 2) },
    taxes:         { type: DataTypes.DECIMAL(14, 2) },
    invAmt:        { type: DataTypes.DECIMAL(14, 2) },
    classOverride: { type: DataTypes.TEXT },                    // "Manual Class Override"
    glOverride:    { type: DataTypes.INTEGER },                 // "Manual GL Code Override"
}, {
    tableName: 'nri_billing_lines',
    indexes: [
        { fields: ['fileId'] },
        { unique: true, fields: ['fileId', 'seq'] },
    ],
});
