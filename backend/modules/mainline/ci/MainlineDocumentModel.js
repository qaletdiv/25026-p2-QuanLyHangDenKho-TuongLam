'use strict';

// mainline_documents — generated CI/PL artifacts. 1:N per booking; leg_id NULL = a
// combined (all-PO) document, leg_id set = a per-PO document. 3NF: every column
// describes the document; po_number is derived via leg_id, never stored.
const BaseModel = require('../../../models/BaseModel');

module.exports = new BaseModel('migrated/mainline_documents.json');
