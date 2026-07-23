'use strict';

// mainline_packing_cartons — one row per carton (extracted from the old nested
// shipment_data.rows[]). The summary is a VIEW computed over these rows, never stored.
const BaseModel = require('../../../models/BaseModel');

module.exports = new BaseModel('migrated/mainline_packing_cartons.json');
