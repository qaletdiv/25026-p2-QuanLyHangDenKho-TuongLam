'use strict';

// po_masters — the TRN-grain master PO header (NetSuite-owned, shared upstream).
// Reads from the normalized migrated dataset. At cutover (Phase 6) the migrated
// files become the live data dir and this path simplifies to 'po_masters.json'.
const BaseModel = require('../../models/BaseModel');

module.exports = new BaseModel('migrated/po_masters.json');
