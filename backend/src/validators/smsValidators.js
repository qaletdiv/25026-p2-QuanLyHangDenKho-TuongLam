'use strict';

const {
  isoDate, requiredString, optionalString, nullableString, nullableNumber, requiredNumber,
  optionalBoolean, requiredArray, optionalArray,
} = require('./rules');

// One PO in a consignment: the vendor-entered facts (PO totals — no SKU lines).
const shipmentPoFields = (prefix) => ({
  [`${prefix}.*.poNumber`]: requiredString("each pos entry needs a 'poNumber'"),
  [`${prefix}.*.units`]: requiredNumber({
    min: 1, integer: true,
    errorMessage: "'units' must be at least 1",
    missingMessage: "each pos entry needs 'units'",
  }),
  [`${prefix}.*.cartons`]: nullableNumber({ min: 0, integer: true }),
});

// One PO-lot on a booking. lotNumber is server-assigned on create (next free lot
// past anything shipped OR booked); callers may pin it when re-booking a known lot.
const bookingPoFields = (prefix) => ({
  ...shipmentPoFields(prefix),
  [`${prefix}.*.lotNumber`]: nullableNumber({ min: 1, integer: true }),
  [`${prefix}.*.weightKg`]: nullableNumber({ min: 0 }),
  [`${prefix}.*.cbm`]: nullableNumber({ min: 0 }),
});

// POST /sms/shipments — vendor enters: courier, tracking number, PO(s) + qty & cartons.
const shipmentCreate = {
  courierId: requiredString("'courierId' is required"),
  trackingNumber: nullableString({ trim: true }),
  shipDate: isoDate(),
  facilityId: nullableString(),
  // Optional and normally omitted — a vendor-entered consignment IS a courier
  // parcel, and a null mode falls back to COURIER on the NetSuite push. It exists
  // so a booked/staff-entered box can state Sea or Air.
  modeId: nullableString(),
  pos: requiredArray({
    min: 1,
    errorMessage: "'pos' must contain at least one PO",
    missingMessage: "'pos' is required",
  }),
  ...shipmentPoFields('pos'),
  force_overship: optionalBoolean,
};

// PUT /sms/shipments/:id — header fields + per-PO units/cartons corrections
// (existing junction rows only; adding/removing POs = delete + recreate).
// customsEntryNumber/freight/duty are the BOOKED-consignment financials: actuals
// off the broker bill (mainline behaviour). Only accepted on a booked shipment —
// the controller rejects them on a bookingless one, which has no formal entry.
const shipmentUpdate = {
  courierId: optionalString("'courierId' must not be empty"),
  // Correctable after the fact — the drafts created before bookings carried a
  // carrier/mode were all stamped FedEx/COURIER, and this is how they are fixed.
  modeId: nullableString(),
  trackingNumber: nullableString({ trim: true }),
  shipDate: isoDate(),
  facilityId: nullableString(),
  manual_status: nullableString(),   // status NAME (module='sms'); resolved to id
  customsEntryNumber: nullableString({ trim: true }),
  freight: nullableNumber({ min: 0 }),
  duty: nullableNumber({ min: 0 }),
  pos: optionalArray({ errorMessage: "'pos' must be an array" }),
  ...shipmentPoFields('pos'),
  force_overship: optionalBoolean,
};

// ── SMS bookings (optional authorization step, added 2026-08-07) ──────────────

const bookingCreate = {
  supplierId: requiredString("'supplierId' is required"),
  incotermId: nullableString(),
  // REQUIRED (2026-08-24). Both were absent and approve silently stamped FedEx +
  // COURIER on the draft, which is what reached NetSuite as the shipping method.
  // A booking is a deliberate plan, so the carrier and mode are stated, not guessed.
  // Independent fields: Ceva runs both sea and air.
  courierId: requiredString("'courierId' is required — pick the carrier"),
  modeId: requiredString("'modeId' is required — pick Sea, Air or Courier"),
  cargoReadyDate: isoDate(),
  pos: requiredArray({
    min: 1,
    errorMessage: "'pos' must contain at least one PO",
    missingMessage: "'pos' is required",
  }),
  ...bookingPoFields('pos'),
  force_overbook: optionalBoolean,
};

// PATCH — Pending bookings only (the controller enforces that).
const bookingUpdate = {
  incotermId: nullableString(),
  courierId: optionalString("'courierId' must not be empty"),
  modeId: optionalString("'modeId' must not be empty"),
  cargoReadyDate: isoDate(),
  pos: optionalArray({ min: 1, errorMessage: "'pos' must contain at least one PO" }),
  ...bookingPoFields('pos'),
  force_overbook: optionalBoolean,
};

// (receiptCreate / receiptConfirm removed with the receiving page 2026-07-03 —
//  receipts sync from NetSuite; there are no receipt WRITE endpoints for lines.)

// POST /sms/receipts/:id/match — confirm which shipment an Item Receipt received.
// Reactivates sms_item_receipts.matchedShipmentId (2026-07-22) to drive landed
// -cost IR targeting: which of a PO's IRs a given shipment's landed cost posts to.
const receiptMatch = {
  shipmentId: requiredString("'shipmentId' is required"),
};

// POST /sms/receipts/manual-match — type the IR document number when nothing auto-matched.
const receiptManualMatch = {
  shipmentId: requiredString("'shipmentId' is required"),
  poNumber: requiredString("'poNumber' is required"),
  ir_tranid: requiredString("'ir_tranid' (the IR number, e.g. IR65377) is required"),
};

module.exports = {
  shipmentCreate, shipmentUpdate, receiptMatch, receiptManualMatch,
  bookingCreate, bookingUpdate,
};
