'use strict';

// nri_contract_terms — the rest of a rate-card workbook: its "Contract Info"
// sheet (`kind: 'info'` — vendor, currency, effective/end date, terms …) and its
// "Validation Rules" sheet (`kind: 'rule'` — R01 late fee, R02 GRI …). Text, not
// numbers: these are read by a person reviewing an invoice, and the card states
// several of them as prose ("Not stated as %", "NOT SIGNED in this copy").
//
// Replaced per entity together with nri_contract_rates. No `_seq` — see that model.

module.exports = (sequelize, DataTypes) => sequelize.define('nri_contract_terms', {
    id:            { type: DataTypes.TEXT, primaryKey: true },  // nct_<entity>_<kind>_<n>
    entity:        { type: DataTypes.TEXT, allowNull: false },
    kind:          { type: DataTypes.TEXT, allowNull: false },  // info | rule
    code:          { type: DataTypes.TEXT },                    // rule code (R01) — null for info rows
    label:         { type: DataTypes.TEXT },                    // info: Field · rule: Topic
    value:         { type: DataTypes.TEXT },
    detail:        { type: DataTypes.TEXT },                    // info: Note · rule: Rule / Threshold
    validationUse: { type: DataTypes.TEXT },                    // rule only
    source:        { type: DataTypes.TEXT },
    seq:           { type: DataTypes.INTEGER, allowNull: false },
}, {
    tableName: 'nri_contract_terms',
    indexes: [{ fields: ['entity', 'kind'] }],
});
