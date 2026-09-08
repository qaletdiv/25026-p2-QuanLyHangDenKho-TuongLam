'use strict';

// Mainline commercial invoices (Phase 4). One CI (header) per booking; its SKU
// line items are DERIVED from mainline_packing_cartons at read-time (folded
// 2026-07-07 — see ciLines.js), never stored.
//   GET    /mainline/bookings/:id/ci          → CI + derived line items + tallies
//   POST   /mainline/bookings/:id/ci/confirm  → confirm + matched/unmatched tallies
//
// The CI is populated by the shipment-data upload (shipmentDataController), which
// writes the packing cartons the lines derive from.

const MainlineCiModel = require('./MainlineCiModel');
const MainlineBookingModel = require('../bookings/MainlineBookingModel');
const MainlinePackingModel = require('../packing/MainlinePackingModel');
const { linesForBooking } = require('./ciLines');
const { assertBookingVisible } = require('../vendorAccess');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };

// Matched/unmatched tallies are DERIVED from the line items at read-time — never
// stored (3NF: they depend on ci_line_items, not on the CI's key; storing them
// goes stale the moment a line changes). Every CI response carries them.
function tallies(myLines) {
  return {
    unmatched_sku_count: myLines.filter((l) => l.match_status === 'unmatched').length,
    total_matched_qty:   myLines.filter((l) => l.match_status === 'matched').reduce((s, l) => s + (l.qty || 0), 0),
    total_unmatched_qty: myLines.filter((l) => l.match_status === 'unmatched').reduce((s, l) => s + (l.qty || 0), 0),
  };
}

// Existence + vendor visibility in one gate, so a vendor probing another supplier's
// booking id gets the same 404 as a nonexistent one. Guards the CI read AND confirm.
async function _bookingOr404(req, id) {
  await assertBookingVisible(req, id);
  const bookings = await MainlineBookingModel.readBookings();
  const b = bookings.find((x) => x.id === id);
  if (!b) err('Booking not found', 404);
  return b;
}

async function getCi(req, res) {
  await _bookingOr404(req, req.params.id);
  const [invoices, cartons] = await Promise.all([MainlineCiModel.readInvoices(), MainlinePackingModel.read()]);
  const ci = invoices.find((i) => i.booking_id === req.params.id);
  if (!ci) err('No commercial invoice for this booking', 404);
  const myLines = linesForBooking(cartons, req.params.id);   // derived from packing cartons
  res.json({ ...ci, ...tallies(myLines), line_items: myLines });
}

async function confirmCi(req, res) {
  await _bookingOr404(req, req.params.id);
  const [invoices, cartons] = await Promise.all([MainlineCiModel.readInvoices(), MainlinePackingModel.read()]);
  const ci = invoices.find((i) => i.booking_id === req.params.id);
  if (!ci) err('No commercial invoice to confirm', 400);

  const myLines = linesForBooking(cartons, req.params.id);   // derived
  ci.status = 'confirmed';
  ci.confirmed_at = new Date().toISOString();   // event fact — stored; tallies/lines are derived

  await MainlineCiModel.writeInvoices(invoices);
  res.json({ ...ci, ...tallies(myLines), line_items: myLines });
}

module.exports = { getCi, confirmCi };
