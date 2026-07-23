'use strict';

// mainline_shipments — tracking records (no courier/tracking; that's SMS-only).
const BaseModel = require('../../../models/BaseModel');

module.exports = new BaseModel('migrated/mainline_shipments.json');
