'use strict';

const { MAINLINE_BOOKING_STATUSES } = require('../lib/mainlineStatuses');
const {
  isoDate, requiredString, nullableString, nullableNumber, enumOf, requiredArray, optionalArray,
} = require('./rules');

// Per-leg BOOKING ESTIMATES, shared by create and update. Booking is keyed on
// LEGS (legId), not poNumber — that enforces the leg-only rule at the shape
// level. The controller verifies every leg belongs to the supplier (G1).
const legRefFields = (prefix) => ({
  [`${prefix}.*.legId`]: requiredString("each poLegs entry needs a 'legId'"),
  [`${prefix}.*.units`]: nullableNumber({ min: 0 }),
  [`${prefix}.*.cartons`]: nullableNumber({ min: 0 }),
  [`${prefix}.*.weightKg`]: nullableNumber({ min: 0 }),
  [`${prefix}.*.cbm`]: nullableNumber({ min: 0 }),
});

// Nullable here — a booking may be submitted with no status stated. Unlike the
// SHIPMENT status, which is not nullable.
const bookingStatus = enumOf(MAINLINE_BOOKING_STATUSES,
  `'bookingStatus' must be one of: ${MAINLINE_BOOKING_STATUSES.join(', ')}`, { nullable: true });

const create = {
  supplierId: requiredString("'supplierId' is required"),
  // PLANNED carrier — optional (not always decided when the vendor submits) and
  // correctable on the shipment afterwards. The controller checks it against the
  // couriers master; that is the real guard, since unknown keys pass through.
  courierId: nullableString(),
  poLegs: requiredArray({
    min: 1,
    errorMessage: "'poLegs' must contain at least one leg",
    missingMessage: "'poLegs' is required",
  }),
  ...legRefFields('poLegs'),
  bookingStatus,
};

const update = {
  bookingStatus,
  cargoReadyDate: isoDate('Cargo Ready must be YYYY-MM-DD'),
  // The "Booked" date shown on the detail. Stored as a timestamp; accepted as a
  // plain calendar date because that is what the field displays and edits.
  submittedAt: isoDate('Cargo Ready must be YYYY-MM-DD'),
  courierId: nullableString(),
  // On update these revise the EXISTING junction rows only — the controller
  // refuses a legId that is not already on the booking. Adding or removing legs
  // is a create-time decision, because that is where G1/G2/G3 are enforced.
  poLegs: optionalArray({ errorMessage: "'poLegs' must be an array", nullable: true }),
  ...legRefFields('poLegs'),
};

module.exports = { create, update };
