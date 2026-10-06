'use strict';

// nri_contract_rates — the 3PL RATE CARD, one row per contracted charge, per
// warehouse entity (US | CA). Loaded from the warehouse's rate-card workbook
// (`NRI_USA_Rate_Card.xlsx` / `NRI_Canada_Rate_Card.xlsx`, sheet "Rate Card");
// uploading a card REPLACES that entity's rows — the card is one document.
//
// `rate` is the number when the card states one; `rateText` keeps what the card
// literally said when it does not ("Market Rates", "NRI Discounted", "Hourly",
// "N/A"). Both are kept because the second is the reason the first is null, and a
// reviewer needs to see "Market Rates", not a blank.
//
// NOT on the whole-table `.read()/.write()` contract (no `_seq`): it is replaced
// per ENTITY, so it is written with destroy({ where: { entity } }) + bulkCreate.
// Same precedent as email_notifications.

module.exports = (sequelize, DataTypes) => sequelize.define('nri_contract_rates', {
    id:           { type: DataTypes.TEXT, primaryKey: true },   // the card's Rate Code, e.g. CA-FUL-02
    entity:       { type: DataTypes.TEXT, allowNull: false },   // US | CA
    section:      { type: DataTypes.TEXT },
    service:      { type: DataTypes.TEXT },                     // "Service / Charge" on the card
    productGroup: { type: DataTypes.TEXT },
    uom:          { type: DataTypes.TEXT },
    rate:         { type: DataTypes.DECIMAL(14, 4) },           // null when the card states no number
    rateText:     { type: DataTypes.TEXT },                     // the card's literal value
    currency:     { type: DataTypes.TEXT },
    rateType:     { type: DataTypes.TEXT },                     // Fixed | Hourly | Tiered | Market | …
    conditions:   { type: DataTypes.TEXT },
    source:       { type: DataTypes.TEXT },                     // page reference on the agreement
    seq:          { type: DataTypes.INTEGER, allowNull: false },// row order on the card
}, {
    tableName: 'nri_contract_rates',
    indexes: [{ fields: ['entity'] }],
});
