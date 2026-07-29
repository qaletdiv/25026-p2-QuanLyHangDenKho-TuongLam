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
  const bookingLegList = legs.filter((l) => myLegIds.has(l.id));
  const legPoToId = new Map(bookingLegList.map((l) => [l.po_number, l.id]));
  const legIdToPo = new Map(bookingLegList.map((l) => [String(l.id), l.po_number]));

  // resolve every row to a booking leg (unmatched PO → null)
  const annotated = rows.map((r) => ({ ...r, _legId: legPoToId.get(r.po_number) || null }));
  const filePos = [...new Set(rows.map((r) => r.po_number).filter(Boolean))];
  if (!annotated.some((r) => r._legId)) {
    err(`None of the PO(s) in this file (${filePos.join(', ') || 'none'}) belong to booking ${booking.booking_number || bookingId}.`, 422);
  }

  // This upload REPLACES only the leg(s) present in the file (per-PO insert/merge):
  // a booking that spans >1 PO can be built up one file at a time, and re-uploading a
  // PO refreshes just that PO. Cartons for the booking's OTHER POs are preserved.
  const scopeKeys = new Set(annotated.map((r) => String(r._legId)));

  // --- packing cartons for this file (ids unique per leg so they never collide
  //     with the preserved other-PO cartons) ---
  const perLegSeq = new Map();
  const newCartons = annotated.map((r) => {
    const legKey = String(r._legId);
    const seq = (perLegSeq.get(legKey) || 0) + 1; perLegSeq.set(legKey, seq);
    return {
      id: `pk_${bookingId}_${r._legId || 'unm'}_${seq}`, booking_id: bookingId, ctn_number: num(r.ctn_number),
      leg_id: r._legId, sku_code: r.sku,
      pcs_per_ctn: num(r.pcs_per_ctn), unit_price: num(r.unit_price), total_usd: num(r.total_usd),
      net_weight_kgs: num(r.net_weight_kgs), gross_weight_kgs: num(r.gross_weight_kgs), measure_cm: r.measure_cm || null,
    };
  });

  // MERGE: keep every carton except this booking's rows for the leg(s) being replaced.
  const mergedCartons = allCartons.filter((c) => c.booking_id !== bookingId || !scopeKeys.has(String(c.leg_id)));
  mergedCartons.push(...newCartons);
  const bookingCartons = mergedCartons.filter((c) => c.booking_id === bookingId);

  // --- enrich SKU master with the FULL descriptive attr set (sheet-first) so the
  //     documents can be regenerated from stored data for every PO in the booking ---
  const skuByCode = new Map(skus.map((s) => [s.sku_code, s]));
  rows.forEach((r) => {
    if (!r.sku) return;
    const cur = skuByCode.get(r.sku) || { sku_code: r.sku };
    skuByCode.set(r.sku, {
      ...cur,
      item_name: r.style_description || cur.item_name || null,
      description: r.style_description || cur.description || null,
      colorway: r.color_description || cur.colorway || null,
      upc: r.upc || cur.upc || null,
      knit_woven: r.knit_woven || cur.knit_woven || null,
      category: r.category || cur.category || null,
      gender: r.gender || cur.gender || null,
      composition: r.composition || cur.composition || null,
      hts_code: r.hts_code || cur.hts_code || null,
      unit_price: num(r.unit_price) ?? cur.unit_price ?? null,
    });
  });

  // --- reconstruct the FULL row set for the booking (all POs) from the merged cartons
  //     + enriched SKUs, then regenerate every document (combined + per-PO). `_group_key`
  //     keeps carton grouping unique across POs (both files may start at carton #1). ---
  const rowFromCarton = (c) => {
    const s = skuByCode.get(c.sku_code) || {};
    const po = legIdToPo.get(String(c.leg_id)) || null;
    return {
      _group_key: `${po || 'unm'}#${c.ctn_number}`,
      ctn_number: c.ctn_number, po_number: po, sku: c.sku_code,
      upc: s.upc || '', knit_woven: s.knit_woven || '',
      style_description: s.item_name || s.description || '', color_description: s.colorway || '',
      category: s.category || '', gender: s.gender || '', composition: s.composition || '', hts_code: s.hts_code || '',
      unit_price: c.unit_price || 0, total_usd: c.total_usd || 0, pcs_per_ctn: c.pcs_per_ctn || 0,
      net_weight_kgs: c.net_weight_kgs || 0, gross_weight_kgs: c.gross_weight_kgs || 0, measure_cm: c.measure_cm || '',
    };
  };
  const fullRows = bookingCartons
    .map(rowFromCarton)
    .sort((a, b) => (a.po_number || '').localeCompare(b.po_number || '') || (a.ctn_number - b.ctn_number));

  // --- generate documents (combined + per-PO) from the full booking row set ---
  const docs = await documentService.generateAll(booking, fullRows, { legPoToId, suppliers, facilities, orders, legs });

  // --- CI record (upsert; keep the existing one when re-uploading/adding a PO) ---
  const existingCi = allInvoices.find((i) => i.booking_id === bookingId);
  const ci = existingCi
    ? { ...existingCi, source: 'shipment_data', status: 'confirmed', confirmed_at: new Date().toISOString() }
    : {
        id: `ci_${bookingId}`, booking_id: bookingId,
        invoice_number: `INV-${(booking.booking_number || bookingId).replace(/[^0-9]/g, '') || bookingId}`,
        invoice_date: new Date().toISOString().slice(0, 10), source: 'shipment_data', status: 'confirmed', confirmed_at: new Date().toISOString(),
      };

  // --- persist (cartons MERGED; this booking's docs + CI replaced; skus enriched) ---
  await Promise.all([
    MainlinePackingModel.write(mergedCartons),
    MainlineCiModel.writeInvoices([...allInvoices.filter((i) => i.booking_id !== bookingId), ci]),
    MainlineDocumentModel.write([...allDocs.filter((d) => d.booking_id !== bookingId), ...docs]),
    new BaseModel('migrated/product_skus.json').write([...skuByCode.values()]),
  ]);

  // response tallies for THIS file (matched/unmatched are derived, never stored)
  const fileLines = linesForBooking(newCartons, bookingId);
  const matchedQty = fileLines.filter((l) => l.match_status === 'matched').reduce((s, l) => s + l.qty, 0);
  const unmatchedQty = fileLines.filter((l) => l.match_status === 'unmatched').reduce((s, l) => s + l.qty, 0);
  const bookingPos = [...new Set(bookingCartons.map((c) => legIdToPo.get(String(c.leg_id))).filter(Boolean))];

  res.status(201).json({
    booking_id: bookingId, po_numbers: filePos, cartons: newCartons.length, ci_line_items: fileLines.length,
    matched_qty: matchedQty, unmatched_qty: unmatchedQty, documents: docs.length,
    per_po: bookingPos.length > 1, booking_po_count: bookingPos.length, summary: parsed.summary,
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
