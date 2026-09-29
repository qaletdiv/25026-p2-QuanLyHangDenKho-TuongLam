'use strict';

const { MAINLINE_SHIPMENT_STATUSES } = require('../lib/mainlineStatuses');
const {
  isoDate, nullableString, nullableNumber, optionalBoolean, enumOf, requiredArray,
} = require('./rules');

// ISO calendar date — a malformed date would corrupt transit-time calculations.
// The shape check catches the format; the Date check catches impossible dates
// like 2026-13-45. Ordering across fields is the controller's checkChronology.
const date = () => isoDate('Dates must be YYYY-MM-DD');

// Mainline shipment update — status vocabulary + header-field types. The
// controller whitelists which fields are written; this validates their shape.
const update = {
  // ⚠️ NOT nullable and NOT blankable — unlike the BOOKING status, which is.
  // Joi wrote `.valid(...)` here and `.valid(...).allow('', null)` there.
  status: enumOf(MAINLINE_SHIPMENT_STATUSES,
    `'status' must be one of: ${MAINLINE_SHIPMENT_STATUSES.join(', ')}`),
  // cargoReadyDate = the REVISED cargo ready date (the forwarder's). Distinct from
  // cargoReceivedDate: ready is the earlier event, and checkChronology orders them.
  cargoReadyDate: date(),
  etdPol: date(), etaPod: date(), eDel: date(), cargoReceivedDate: date(), ata: date(),
  // Operational note. Capped so one paste cannot make every shipment payload huge —
  // this rides on the list endpoint too.
  notes: nullableString({ max: 4000 }),
  // "Needs attention". Accepted here, but the CONTROLLER gates it on
  // `shipment_flag_priority`; validation is shape, not authority.
  priority: optionalBoolean,
  blNo: nullableString(),
  courierId: nullableString(),          // actual carrier; drives the landed-cost basis
  // Was `ceva_shipment_number` — the carrier is data now, so the column no longer
  // names one. NOT `shipmentNumber`: that is the portal's own SHP-N sequence.
  carrierReference: nullableString(),
  customsEntryNumber: nullableString(),
  containerTypeId: nullableString(),
  polPortId: nullableString(),
  podPortId: nullableString(),
  netsuiteId: nullableString(),
  invoiceValue: nullableNumber({ min: 0 }),
  duty: nullableNumber({ min: 0 }),
  freight: nullableNumber({ min: 0 }),
};

const bulkStatus = {
  ids: requiredArray({ min: 1, errorMessage: "'ids' must contain at least one shipment" }),
  'ids.*': { isString: { errorMessage: 'each id must be a string' } },
  status: {
    exists: { options: { values: 'undefined' }, errorMessage: "'status' is required" },
    isIn: {
      options: [MAINLINE_SHIPMENT_STATUSES],
      errorMessage: `'status' must be one of: ${MAINLINE_SHIPMENT_STATUSES.join(', ')}`,
    },
  },
};

module.exports = { update, bulkStatus };
