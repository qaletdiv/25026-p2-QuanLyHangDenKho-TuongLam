'use strict';

// SMS shipping data — the vendor uploads one packing Excel per consignment:
//   • parse (shared ciParser) into carton rows
//   • write sms_packing_cartons (carton × SKU facts) — the shipped-per-SKU source
//   • generate CI + Packing-List documents (combined + per-PO) → sms_documents
// Re-upload replaces this shipment's cartons + documents.
//
// Derived, never stored: totalUsd (= pcs × unitPrice), shipped-per-SKU, the
// packing summary — all computed at read-time from the cartons.

const M = require('../lib/SmsModels');
const svc = require('../services/smsService');
const documentService = require('../services/smsDocumentService');
const { parseShippingFile, persistShippingData } = require('../services/smsShippingDataService');
const { resolveVendorSupplierId } = require('../utils/vendorScope');
const { assertShipmentVisible } = require('../lib/smsVendorAccess');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };

// Vendor scoping lives in utils/vendorScope (one copy, was four).
const _vendorSupplierId = (user) => resolveVendorSupplierId(user);

async function uploadShippingData(req, res) {
  if (!req.file) err('No file uploaded. Send Excel as multipart field "file".', 400);
  const vendorSupplierId = await _vendorSupplierId(req.user);

  const [shipments, shipmentPos, pos] = await Promise.all([
    M.shipments.read(), M.shipmentPos.read(), M.pos.read(),
  ]);
  const shipment = shipments.find((s) => s.id === req.params.id);
  if (!shipment) err('SMS shipment not found', 404);
  await assertShipmentVisible(req, shipment.id);   // forwarder: own carrier only (404)

  const myJunctions = shipmentPos.filter((j) => j.shipmentId === shipment.id);
  const poByNumber = new Map(pos.map((p) => [p.poNumber, p]));

  // vendor may only touch consignments carrying exclusively their POs
  if (vendorSupplierId && !myJunctions.every((j) => (poByNumber.get(j.poNumber) || {}).supplierId === vendorSupplierId)) {
    err("This shipment carries another supplier's POs", 403);
  }

  const rows = parseShippingFile(req.file.buffer, myJunctions.map((j) => j.poNumber));
  res.status(201).json(await persistShippingData(shipment, rows));
}


// GET /sms/shipments/:id/documents — generated CI/PL files, scope-labelled
async function getDocuments(req, res) {
  await assertShipmentVisible(req, req.params.id);
  const docs = (await M.documents.read().catch(() => [])).filter((d) => d.shipmentId === req.params.id);
  res.json(docs.map((d) => ({ ...d, scope: d.poNumber || 'Combined (all POs)' })));
}

// GET /sms/documents/:docId/file — the CI / Packing List itself, REBUILT from
// current data rather than streamed off disk. Same reasoning as mainline's
// downloadDocument: the letterhead (supplier address, consignee address, port of
// discharge, notify party) is master data edited after the upload, so a stored
// file freezes whatever was blank when it was written.
async function downloadDocument(req, res) {
  const doc = (await M.documents.read().catch(() => [])).find((d) => d.id === req.params.docId);
  if (!doc) err('Document not found', 404);
  await assertShipmentVisible(req, doc.shipmentId);

  const [shipments, pos, skus, suppliers, facilities, modes, notifyParty, allCartons, cartonFacts] = await Promise.all([
    M.shipments.read(), M.pos.read(), M.skus.read(), M.suppliers.read().catch(() => []),
    M.facilities.read(), M.modes.read().catch(() => []), M.notifyParty.read().catch(() => []),
    M.packingCartons.read().catch(() => []), M.cartons.read().catch(() => []),
  ]);
  const shipment = shipments.find((s) => s.id === doc.shipmentId);
  if (!shipment) err('SMS shipment not found', 404);

  // withCartonFacts puts the physical box facts back on EVERY SKU row of the
  // carton, which is what the generators expect (see the sms_cartons split).
  const cartons = svc.withCartonFacts(allCartons.filter((c) => c.shipmentId === shipment.id), cartonFacts);
  if (!cartons.length) err('No shipping data on this consignment — re-upload it to regenerate the document.', 409);

  const rows = documentService.rowsFromCartons(cartons, new Map(skus.map((s) => [s.skuCode, s])));
  const buf = await documentService.rebuild(doc, shipment, rows, { pos, suppliers, facilities, modes, notifyParty });
  if (!buf) err('This document no longer matches the consignment\'s POs — re-upload the shipping data.', 409);

  const filename = (doc.fileUrl || '').split('/').pop() || `${doc.docType}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buf));
}

module.exports = { uploadShippingData, getDocuments, downloadDocument };
