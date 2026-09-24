'use strict';

// Single-source ingestion: upload one shipment-data Excel per booking →
//   • parse (shared ciParser) into carton rows
//   • write mainline_packing_cartons (carton-level facts, matched to leg by poNumber)
//   • derive mainline_ci_line_items (per SKU, matched to leg) — CONFIRMED
//   • enrich product_skus (SKU descriptive attrs)
//   • generate CI + Packing-List documents at BOTH grains (combined + per-PO) via
//     documentService → mainline_documents
//
// Re-upload replaces this booking's CI lines / cartons / documents.

const { parseShipmentData } = require('../../../services/ciParser');
const { models } = require('../../../models');
const SupplierModel = models.suppliers;
const ModeModel = models.modes;
// Destination master data (consignee block) + the singleton notify party — both
// read at DOWNLOAD time as well as upload time, see documentService.rebuild.
const FacilityModel = models.warehouse_facilities;
const NotifyPartyModel = models.notify_party;
const SkuModel = models.product_skus;
const documentService = require('./documentService');
const { linesForBooking } = require('./ciLines');
const { assertBookingVisible } = require('../vendorAccess');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };
const num = (v) => { const n = Number(v); return isFinite(n) && v !== '' && v !== null ? n : null; };

async function uploadShipmentData(req, res) {
  if (!req.file) err('No file uploaded. Send Excel as multipart field "file".', 400);
  const bookingId = req.params.id;

  const [bookings, bookingLegs, legs, orders, suppliers, facilities, modes, notifyParty, skus, allCartons, allInvoices, allDocs] = await Promise.all([
    models.mainline_bookings.read(), models.mainline_booking_po_legs.read(), models.mainline_po_legs.read(),
    models.po_orders.read(), SupplierModel.read().catch(() => []), FacilityModel.read(),
    ModeModel.read().catch(() => []), NotifyPartyModel.read().catch(() => []),
    SkuModel.read(), models.mainline_packing_cartons.read(),
    models.mainline_commercial_invoices.read(), models.mainline_documents.read(),
  ]);
  const booking = bookings.find((b) => b.id === bookingId);
  if (!booking) err('Booking not found', 404);

  const parsed = parseShipmentData(req.file.buffer);
  const rows = parsed.rows || [];
  if (!rows.length) err('No rows found in the shipment-data file.', 422);

  const myLegIds = new Set(bookingLegs.filter((bl) => bl.bookingId === bookingId).map((bl) => bl.legId));
  const bookingLegList = legs.filter((l) => myLegIds.has(l.id));
  const legPoToId = new Map(bookingLegList.map((l) => [l.poNumber, l.id]));
  const legIdToPo = new Map(bookingLegList.map((l) => [String(l.id), l.poNumber]));

  // resolve every row to a booking leg (unmatched PO → null)
  const annotated = rows.map((r) => ({ ...r, _legId: legPoToId.get(r.poNumber) || null }));
  const filePos = [...new Set(rows.map((r) => r.poNumber).filter(Boolean))];
  if (!annotated.some((r) => r._legId)) {
    err(`None of the PO(s) in this file (${filePos.join(', ') || 'none'}) belong to booking ${booking.bookingNumber || bookingId}.`, 422);
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
      id: `pk_${bookingId}_${r._legId || 'unm'}_${seq}`, bookingId: bookingId, ctnNumber: num(r.ctnNumber),
      legId: r._legId, skuCode: r.sku,
      pcsPerCtn: num(r.pcsPerCtn), unitPrice: num(r.unitPrice), totalUsd: num(r.totalUsd),
      netWeightKgs: num(r.netWeightKgs), grossWeightKgs: num(r.grossWeightKgs), measureCm: r.measureCm || null,
    };
  });

  // MERGE: keep every carton except this booking's rows for the leg(s) being replaced.
  const mergedCartons = allCartons.filter((c) => c.bookingId !== bookingId || !scopeKeys.has(String(c.legId)));
  mergedCartons.push(...newCartons);
  const bookingCartons = mergedCartons.filter((c) => c.bookingId === bookingId);

  // --- enrich SKU master with the FULL descriptive attr set (sheet-first) so the
  //     documents can be regenerated from stored data for every PO in the booking ---
  const skuByCode = new Map(skus.map((s) => [s.skuCode, s]));
  rows.forEach((r) => {
    if (!r.sku) return;
    const cur = skuByCode.get(r.sku) || { skuCode: r.sku };
    skuByCode.set(r.sku, {
      ...cur,
      itemName: r.style_description || cur.itemName || null,
      description: r.style_description || cur.description || null,
      colorway: r.color_description || cur.colorway || null,
      upc: r.upc || cur.upc || null,
      knitWoven: r.knitWoven || cur.knitWoven || null,
      category: r.category || cur.category || null,
      gender: r.gender || cur.gender || null,
      composition: r.composition || cur.composition || null,
      htsCode: r.htsCode || cur.htsCode || null,
      unitPrice: num(r.unitPrice) ?? cur.unitPrice ?? null,
    });
  });

  // --- reconstruct the FULL row set for the booking (all POs) from the merged cartons
  //     + enriched SKUs, then regenerate every document (combined + per-PO). Shared
  //     with the download rebuild so both produce identical rows. ---
  const fullRows = documentService.rowsFromCartons(bookingCartons, legIdToPo, skuByCode);

  // --- generate documents (combined + per-PO) from the full booking row set ---
  const docs = await documentService.generateAll(booking, fullRows, { legPoToId, suppliers, facilities, orders, legs, modes, notifyParty });

  // --- CI record (upsert; keep the existing one when re-uploading/adding a PO) ---
  const existingCi = allInvoices.find((i) => i.bookingId === bookingId);
  const ci = existingCi
    ? { ...existingCi, source: 'shipment_data', status: 'confirmed', confirmedAt: new Date().toISOString() }
    : {
        id: `ci_${bookingId}`, bookingId: bookingId,
        invoiceNumber: `INV-${(booking.bookingNumber || bookingId).replace(/[^0-9]/g, '') || bookingId}`,
        invoiceDate: new Date().toISOString().slice(0, 10), source: 'shipment_data', status: 'confirmed', confirmedAt: new Date().toISOString(),
      };

  // --- persist (cartons MERGED; this booking's docs + CI replaced; skus enriched) ---
  await Promise.all([
    models.mainline_packing_cartons.write(mergedCartons),
    models.mainline_commercial_invoices.write([...allInvoices.filter((i) => i.bookingId !== bookingId), ci]),
    models.mainline_documents.write([...allDocs.filter((d) => d.bookingId !== bookingId), ...docs]),
    models.product_skus.write([...skuByCode.values()]),
  ]);

  // response tallies for THIS file (matched/unmatched are derived, never stored)
  const fileLines = linesForBooking(newCartons, bookingId);
  const matchedQty = fileLines.filter((l) => l.match_status === 'matched').reduce((s, l) => s + l.qty, 0);
  const unmatchedQty = fileLines.filter((l) => l.match_status === 'unmatched').reduce((s, l) => s + l.qty, 0);
  const bookingPos = [...new Set(bookingCartons.map((c) => legIdToPo.get(String(c.legId))).filter(Boolean))];

  res.status(201).json({
    bookingId: bookingId, poNumbers: filePos, cartons: newCartons.length, ci_line_items: fileLines.length,
    matched_qty: matchedQty, unmatched_qty: unmatchedQty, documents: docs.length,
    per_po: bookingPos.length > 1, booking_po_count: bookingPos.length, summary: parsed.summary,
  });
}

// GET /mainline/bookings/:id/documents — list generated docs, enriched with po scope.
async function getDocuments(req, res) {
  await assertBookingVisible(req, req.params.id);
  const [docs, legs] = await Promise.all([models.mainline_documents.read(), models.mainline_po_legs.read()]);
  const legPo = new Map(legs.map((l) => [l.id, l.poNumber]));
  const mine = docs.filter((d) => d.bookingId === req.params.id).map((d) => ({
    ...d,
    poNumber: d.legId ? (legPo.get(d.legId) || null) : null,
    scope: d.legId ? (legPo.get(d.legId) || 'PO') : 'Combined (all POs)',
  }));
  res.json(mine);
}

// GET /mainline/documents/:docId/file — the CI / Packing List itself, REBUILT from
// current data rather than streamed off disk.
//
// The stored xlsx is a snapshot of the letterhead as it was at upload: supplier
// address, consignee address, port of discharge and notify party all come from
// master data that is edited later, and a file written in August cannot know what
// was typed in September. That is why the downloaded CI kept showing a blank
// consignee block after the details had been entered. Rebuilding keeps the stored
// invoiceNumber (the document's identity) and the stored cartons, and re-reads
// only the master data. Falls back to the stored file if the cartons are gone.
async function downloadDocument(req, res) {
  const docs = await models.mainline_documents.read();
  const doc = docs.find((d) => d.id === req.params.docId);
  if (!doc) err('Document not found', 404);
  await assertBookingVisible(req, doc.bookingId);

  const [bookings, bookingLegs, legs, orders, suppliers, facilities, modes, notifyParty, skus, allCartons] =
    await Promise.all([
      models.mainline_bookings.read(), models.mainline_booking_po_legs.read(), models.mainline_po_legs.read(),
      models.po_orders.read(), SupplierModel.read().catch(() => []), FacilityModel.read(),
      ModeModel.read().catch(() => []), NotifyPartyModel.read().catch(() => []),
      SkuModel.read(), models.mainline_packing_cartons.read(),
    ]);
  const booking = bookings.find((b) => b.id === doc.bookingId);
  if (!booking) err('Booking not found', 404);

  const myLegIds = new Set(bookingLegs.filter((bl) => bl.bookingId === booking.id).map((bl) => bl.legId));
  const bookingLegList = legs.filter((l) => myLegIds.has(l.id));
  const legPoToId = new Map(bookingLegList.map((l) => [l.poNumber, l.id]));
  const legIdToPo = new Map(bookingLegList.map((l) => [String(l.id), l.poNumber]));
  const bookingCartons = allCartons.filter((c) => c.bookingId === booking.id);
  if (!bookingCartons.length) err('No shipping data on this booking — re-upload it to regenerate the document.', 409);

  const rows = documentService.rowsFromCartons(bookingCartons, legIdToPo, new Map(skus.map((s) => [s.skuCode, s])));
  const buf = await documentService.rebuild(doc, booking, rows, {
    legPoToId, suppliers, facilities, orders, legs, modes, notifyParty,
  });
  if (!buf) err('This document no longer matches the booking\'s POs — re-upload the shipping data.', 409);

  const filename = (doc.fileUrl || '').split('/').pop() || `${doc.docType}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buf));
}

module.exports = { uploadShipmentData, getDocuments, downloadDocument };
