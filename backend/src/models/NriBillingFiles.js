'use strict';

// nri_billing_files — one row per NRI "Invoice Details Report" uploaded (NRI CA
// and NRI US each send two a month). This is the portal's replacement for the
// folder the team saved the CSVs into: the year's files stay here, so any month
// can be re-read and re-summarised later.
//
// The file's LINES live in nri_billing_lines; totals here are a snapshot taken at
// upload for the list view only — the result page always re-sums the lines, so an
// override can never leave the two disagreeing about a GL.
//
// `locked` = already booked in NetSuite. Locked files are coded EXACTLY as the
// workbook did (legend default + manual overrides) — the auto class rules never
// recode them, so a booked month cannot move under finance's feet.
//
// Written with the ORM directly (create / update / destroy), not `.write()`:
// replacing a year of invoice files on every upload is not an option.

module.exports = (sequelize, DataTypes) => sequelize.define('nri_billing_files', {
    id:          { type: DataTypes.TEXT, primaryKey: true },    // nbf_<entity>_<invoiceNo | file slug>
    entity:      { type: DataTypes.TEXT, allowNull: false },    // US | CA
    fileName:    { type: DataTypes.TEXT, allowNull: false },    // = the workbook's Source.Name
    invoiceNo:   { type: DataTypes.TEXT },                      // from the report banner; null on rebuilt history
    periodEnd:   { type: DataTypes.DATEONLY },                  // "Ending 9/15/2026" — else derived from the lines
    reportDate:  { type: DataTypes.DATEONLY },                  // date NRI printed the report
    lineCount:   { type: DataTypes.INTEGER, allowNull: false },
    charges:     { type: DataTypes.DECIMAL(14, 2) },
    taxes:       { type: DataTypes.DECIMAL(14, 2) },
    invAmt:      { type: DataTypes.DECIMAL(14, 2) },
    locked:      { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    uploadedAt:  { type: DataTypes.TEXT, allowNull: false },
    uploadedBy:  { type: DataTypes.TEXT },
    storedPath:  { type: DataTypes.TEXT },                      // the original file, kept under storage/reference/nri-billing
    // the upload's REVIEW: services → channel + GL confirmed for its month (the
    // dialog after upload). null = not reviewed yet; a re-upload starts unreviewed.
    // Added by scripts/add-nri-file-confirmed.js.
    confirmedAt: { type: DataTypes.TEXT },
    confirmedBy: { type: DataTypes.TEXT },
}, {
    tableName: 'nri_billing_files',
    indexes: [
        { fields: ['entity'] },
        { unique: true, fields: ['entity', 'fileName'] },
    ],
});
