'use strict';

// nri_class_rules — the CHANNEL RULES the team maintains on All Invoices → Rules.
//
// A rule says "lines that look like THIS are channel X" — e.g. Order Type ECOM →
// CA - Online. They replace the hand-typing the workbook needed (32,344 manual
// overrides in 2026) and apply ONLY to files not marked Booked; a manual override
// on a line always beats every rule. First matching rule (lowest `seq`) wins.
//
// `conditions` is a JSON array, ALL of which must match:
//   [{ field: 'orderType' | 'service' | 'clientRef1' | 'clientRef2' | 'customer',
//      op: 'is' | 'startsWith' | 'contains',
//      values: ['ECOM', …] }]          — any ONE value satisfies the condition
// Matching is trim + case-insensitive. Shape is validated in the controller
// (nriBillingController.normalizeRule), not trusted from the client.
//
// `kind` is how the Rules page presents a rule, and it FIXES the evaluation order
// (the server assigns `seq` by kind, then by position):
//   orderType      step 1, BY ORDER TYPE — two columns (one rule per channel):
//                  ECOM → Ecomm, PREBOOK/WHOLESALE/… → Wholesale. Only lines whose
//                  order is in the order data have a type; the rest fall through
//   custom         the Advanced rules (e.g. GoBolt: Client Ref 1 contains gobolt)
//   serviceColumn  the two drag-and-drop columns — one rule per column, holding
//                  every service dropped there (condition: service is [...])
// An order-type decision outranks the columns because a service like Order
// Processing is split between channels BY THE ORDER, not by the service.
//
// Replaced per entity as one list (PUT /nri-billing/rules).
// No `_seq` — see nri_contract_rates.

module.exports = (sequelize, DataTypes) => sequelize.define('nri_class_rules', {
    id:         { type: DataTypes.TEXT, primaryKey: true },   // ncr_<entity>_<n>
    entity:     { type: DataTypes.TEXT, allowNull: false },   // US | CA
    seq:        { type: DataTypes.INTEGER, allowNull: false },// evaluation order
    kind:       { type: DataTypes.TEXT, allowNull: false, defaultValue: 'custom' }, // orderType | custom | serviceColumn
    // serviceColumn rules only: the invoice PERIOD-END month (YYYY-MM) they apply
    // from — a month uses the latest saved month at or before it, else the rules
    // with month NULL (the base columns). Order-type and exception rules are NULL:
    // they apply to every month. Added by scripts/add-nri-class-rule-month.js.
    month:      { type: DataTypes.TEXT },
    name:       { type: DataTypes.TEXT, allowNull: false },
    enabled:    { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    conditions: { type: DataTypes.JSON, allowNull: false },
    setClass:   { type: DataTypes.TEXT, allowNull: false },
    updatedAt:  { type: DataTypes.TEXT },
    updatedBy:  { type: DataTypes.TEXT },
}, {
    tableName: 'nri_class_rules',
    indexes: [{ fields: ['entity', 'seq'] }],
});
