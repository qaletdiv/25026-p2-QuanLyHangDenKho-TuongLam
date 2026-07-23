'use strict';

// Single-source ingestion: upload one shipment-data Excel per booking →
//   • parse (shared ciParser) into carton rows
//   • write mainline_packing_cartons (carton-level facts, matched to leg by po_number)
//   • derive mainline_ci_line_items (per SKU, matched to leg) — CONFIRMED
//   • enrich product_skus (SKU descriptive attrs)
//   • generate CI + Packing-List documents at BOTH grains (combined + per-PO) via
//     documentService → mainline_documents
//
// Re-upload replaces this booking's CI lines / cartons / documents.

const { parseShipmentData } = require('../../../services/ciParser');
const MainlineBookingModel = require('../bookings/MainlineBookingModel');
const MainlineLegModel = require('../legs/MainlineLegModel');
const MainlineCiModel = require('./MainlineCiModel');
const MainlinePackingModel = require('../packing/MainlinePackingModel');
const MainlineDocumentModel = require('./MainlineDocumentModel');
const PoOrderModel = require('../../po/PoOrderModel');
const { suppliers: SupplierModel } = require('../../../models/MasterDataModel');
const BaseModel = require('../../../models/BaseModel');
const documentService = require('./documentService');
const { linesForBooking } = require('./ciLines');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };
const num = (v) => { const n = Number(v); return isFinite(n) && v !== '' && v !== null ? n : null; };

async function uploadShipmentData(req, res) {
  if (!req.file) err('No file uploaded. Send Excel as multipart field "file".', 400);
  const bookingId = req.params.id;

  const [bookings, bookingLegs, legs, orders, suppliers, facilities, skus, allCartons, allInvoices, allDocs] = await Promise.all([
    MainlineBookingModel.readBookings(), MainlineBookingModel.readBookingLegs(), MainlineLegModel.readLegs(),
    PoOrderModel.readOrders(), SupplierModel.read().catch(() => []), new BaseModel('migrated/warehouse_facilities.json').read(),
    new BaseModel('migrated/product_skus.json').read(), MainlinePackingModel.read(),
    MainlineCiModel.readInvoices(), MainlineDocumentModel.read(),
  ]);
  const booking = bookings.find((b) => b.id === bookingId);
  if (!booking) err('Booking not found', 404);

  const parsed = parseShipmentData(req.file.buffer);
  const rows = parsed.rows || [];
  if (!rows.length) err('No rows found in the shipment-data file.', 422);

  const myLegIds = new Set(bookingLegs.filter((bl) => bl.booking_id === bookingId).map((bl) => bl.leg_id));
  const legPoToId = new Map(legs.filter((l) => myLegIds.has(l.id)).map((l) => [l.po_number, l.id]));

  // --- packing cartons (carton-level facts) ---
  const cartons = rows.map((r, i) => ({
    id: `pk_${bookingId}_${i + 1}`, booking_id: bookingId, ctn_number: num(r.ctn_number),
    leg_id: legPoToId.get(r.po_number) || null, sku_code: r.sku,
    pcs_per_ctn: num(r.pcs_per_ctn), unit_price: num(r.unit_price), total_usd: num(r.total_usd),
    net_weight_kgs: num(r.net_weight_kgs), gross_weight_kgs: num(r.gross_weight_kgs), measure_cm: r.measure_cm || null,
  }));

  // --- CI line items: DERIVED from the cartons we just built (never stored). Used
  // only for the response tallies here; readers derive the same way (ciLines.js). ---
  const invId = `ci_${bookingId}`;
  const ciLines = linesForBooking(cartons, bookingId);

  // --- enrich SKU master ---
  const skuByCode = new Map(skus.map((s) => [s.sku_code, s]));
  rows.forEach((r) => {
    if (!r.sku) return;
    const cur = skuByCode.get(r.sku) || { sku_code: r.sku };
    skuByCode.set(r.sku, {
      ...cur, item_name: cur.item_name || r.style_description || null, description: cur.description || r.style_description || null,
      colorway: cur.colorway || r.color_description || null, hts_code: cur.hts_code || r.hts_code || null, unit_price: cur.unit_price ?? num(r.unit_price),
    });
  });

  // --- generate documents (combined + per-PO) ---
  const docs = await documentService.generateAll(booking, rows, { legPoToId, suppliers, facilities, orders, legs });

  // --- CI record (data; confirmed) ---
  // matched/unmatched tallies are DERIVED from ci_line_items at read-time — never stored
  const matchedQty = ciLines.filter((l) => l.match_status === 'matched').reduce((s, l) => s + l.qty, 0);
  const unmatchedQty = ciLines.filter((l) => l.match_status === 'unmatched').reduce((s, l) => s + l.qty, 0);
  const ci = {
    id: invId, booking_id: bookingId, invoice_number: `INV-${(booking.booking_number || bookingId).replace(/[^0-9]/g, '') || bookingId}`,
    invoice_date: new Date().toISOString().slice(0, 10), source: 'shipment_data', status: 'confirmed', confirmed_at: new Date().toISOString(),
  };

  // --- persist (replace this booking's rows/docs) ---
  await Promise.all([
    MainlinePackingModel.write([...allCartons.filter((c) => c.booking_id !== bookingId), ...cartons]),
    MainlineCiModel.writeInvoices([...allInvoices.filter((i) => i.booking_id !== bookingId), ci]),
    MainlineDocumentModel.write([...allDocs.filter((d) => d.booking_id !== bookingId), ...docs]),
    new BaseModel('migrated/product_skus.json').write([...skuByCode.values()]),
  ]);

  res.status(201).json({
    booking_id: bookingId, cartons: cartons.length, ci_line_items: ciLines.length,
    matched_qty: matchedQty, unmatched_qty: unmatchedQty,
    documents: docs.length, per_po: docs.some((d) => d.leg_id), summary: parsed.summary,
  });
}

// GET /mainline/bookings/:id/documents — list generated docs, enriched with po scope.
async function getDocuments(req, res) {
  const [docs, legs] = await Promise.all([MainlineDocumentModel.read(), MainlineLegModel.readLegs()]);
  const legPo = new Map(legs.map((l) => [l.id, l.po_number]));
  const mine = docs.filter((d) => d.booking_id === req.params.id).map((d) => ({
    ...d,
    po_number: d.leg_id ? (legPo.get(d.leg_id) || null) : null,
    scope: d.leg_id ? (legPo.get(d.leg_id) || 'PO') : 'Combined (all POs)',
  }));
  res.json(mine);
}

module.exports = { uploadShipmentData, getDocuments };
