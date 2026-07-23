'use strict';

// mainline_item_receipts (+ lines) — NetSuite Item Receipts for MAINLINE POs,
// synced read-only alongside the PO sync. Attach to the component po_number (the
// NetSuite PO transaction the receipt was created from). Received qty is DERIVED
// at read from the lines — nothing per-PO is stored elsewhere. Separate from the
// SMS receipt tables (no shared transactional tables between the two modules).
const BaseModel = require('../../../models/BaseModel');

const receipts     = new BaseModel('migrated/mainline_item_receipts.json');
const receiptLines = new BaseModel('migrated/mainline_item_receipt_lines.json');

module.exports = {
  readReceipts:      () => receipts.read(),
  writeReceipts:     (d) => receipts.write(d),
  readReceiptLines:  () => receiptLines.read(),
  writeReceiptLines: (d) => receiptLines.write(d),
};
