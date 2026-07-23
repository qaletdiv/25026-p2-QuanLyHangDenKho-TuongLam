'use strict';

// mainline_shipment_legs — junction (shipment ↔ PO leg). A physical shipment (one
// row in mainline_shipments, grained on booking + facility) carries one or more PO
// legs; each junction row holds the per-leg facts (lot, allocated quantity). Shared
// logistics dates/status live on the shipment header, edited once. See database.dbml.
const BaseModel = require('../../../models/BaseModel');

module.exports = new BaseModel('migrated/mainline_shipment_legs.json');
