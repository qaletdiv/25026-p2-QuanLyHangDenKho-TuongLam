'use strict';

const { isoDate, requiredString, requiredNumber, nullableNumber, nullableString, optionalArray } = require('./rules');

// POST /mainline/bookings/:id/ci — the CI header + SKU line items written to disk.
// qty must be a non-negative number (a negative or garbage qty corrupts the
// fulfillment three-way match); dates must be ISO calendar dates.
// Unknown keys pass through, as they did under Joi's .unknown(true).
const upsert = {
  invoiceNumber: nullableString(),
  invoiceDate: isoDate(),
  source: nullableString(),
  fileUrl: nullableString(),

  line_items: optionalArray({ errorMessage: "'line_items' must be an array" }),
  'line_items.*.skuCode': requiredString("each line item needs a 'skuCode'"),
  'line_items.*.qty': requiredNumber({
    min: 0,
    errorMessage: "'qty' cannot be negative",
    missingMessage: "each line item needs a 'qty'",
  }),
  'line_items.*.weightKg': nullableNumber({ min: 0 }),
  'line_items.*.cbm': nullableNumber({ min: 0 }),
  'line_items.*.matched_leg_id': nullableString(),
  'line_items.*.matched_po': nullableString(),
};

module.exports = { upsert };
