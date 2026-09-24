'use strict';

// SMS shipping data — the vendor uploads one packing Excel per consignment:
//   • parse (shared ciParser) into carton rows
//   • write sms_packing_cartons (carton × SKU facts) — the shipped-per-SKU source
//   • generate CI + Packing-List documents (combined + per-PO) → sms_documents
// Re-upload replaces this shipment's cartons + documents.
//
// Derived, never stored: totalUsd (= pcs × unitPrice), shipped-per-SKU, the
// packing summary — all computed at read-time from the cartons.

const { parseShipmentData } = require('../../services/ciParser');
const M = require('./SmsModels');
const svc = require('./smsService');
const documentService = require('./smsDocumentService');
const { resolveVendorSupplierId } = require('../../utils/vendorScope');
const { assertShipmentVisible } = require('./vendorAccess');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };
const num = (v) => { const n = Number(v); return isFinite(n) && v !== '' && v !== null ? n : null; };

// Vendor scoping lives in utils/vendorScope (one copy, was four).
const _vendorSupplierId = (user) => resolveVendorSupplierId(user);

async function uploadShippingData(req, res) {
  if (!req.file) err('No file uploaded. Send Excel as multipart field "file".', 400);
  const vendorSupplierId = await _vendorSupplierId(req.user);

  const [shipments, shipmentPos, pos, poLines, skus, suppliers, facilities, modes, notifyParty, allCartons, allDocs] = await Promise.all([
    M.shipments.read(), M.shipmentPos.read(), M.pos.read(), M.poLines.read(),
    M.skus.read(), M.suppliers.read().catch(() => []), M.facilities.read(),
    M.modes.read().catch(() => []), M.notifyParty.read().catch(() => []),
    M.packingCartons.read().catch(() => []), M.documents.read().catch(() => []),
  ]);
  const shipment = shipments.find((s) => s.id === req.params.id);
  if (!shipment) err('SMS shipment not found', 404);

  const myJunctions = shipmentPos.filter((j) => j.shipmentId === shipment.id);
  const shipmentPoNumbers = new Set(myJunctions.map((j) => j.poNumber));
  const poByNumber = new Map(pos.map((p) => [p.poNumber, p]));

  // vendor may only touch consignments carrying exclusively their POs
  if (vendorSupplierId && !myJunctions.every((j) => (poByNumber.get(j.poNumber) || {}).supplierId === vendorSupplierId)) {
    err("This shipment carries another supplier's POs", 403);
  }

  const parsed = parseShipmentData(req.file.buffer);
  const rows = parsed.rows || [];
  if (!rows.length) err('No rows found in the shipping-data file.', 422);

  // every row's PO must be one this consignment carries
  const stray = [...new Set(rows.map((r) => r.poNumber).filter(Boolean))].filter((po) => !shipmentPoNumbers.has(po));
  if (stray.length) err(`The file has POs not on this shipment: ${stray.join(', ')}. This consignment carries: ${[...shipmentPoNumbers].join(', ')}.`, 400);

  // Default unit price from the NetSuite PO line when the sheet omits it. Built by
  // smsService.priceByPoSku, NOT `new Map(rows.map(...))`: one item can sit on
  // several NS lines at different prices, and last-row-wins made this value depend
  // on file/row order — which decides the CI value and therefore the landed cost.
  const priceByPoSku = svc.priceByPoSku(poLines);
  const skuByCode = new Map(skus.map((s) => [s.skuCode, s]));

  // Enrich the SKU master from the sheet — insert SKUs new to the catalogue and
  // backfill missing descriptive fields on existing ones (mirrors the mainline
  // shipment-data upload). Without this a SKU that's shipped but was never ordered
  // (so absent from sms_po_lines) resolves no item name on the PO detail's line
  // table. The sheet is authoritative for the descriptive attrs the master lacks.
  const ATTRS = ['upc', 'gender', 'category', 'composition', 'knitWoven'];
  let skusDirty = false;
  rows.forEach((r) => {
    if (!r.sku) return;
    const existing = skuByCode.get(r.sku);
    if (existing) {
      const before = JSON.stringify(existing);
      existing.itemName   = existing.itemName   || r.style_description || null;
      existing.description = existing.description || r.style_description || null;
      existing.colorway    = existing.colorway    || r.color_description || null;
      existing.htsCode    = existing.htsCode    || r.htsCode || null;
      ATTRS.forEach((a) => { if (r[a] && !existing[a]) existing[a] = r[a]; });
      if (JSON.stringify(existing) !== before) skusDirty = true;
    } else {
      const p = String(r.sku).split('-');
      const sku = {
        skuCode: r.sku,
        styleColor: p.slice(0, -1).join('-') || null,
        itemName: r.style_description || null,
        description: r.style_description || null,
        colorway: r.color_description || null,
        size: p.length > 2 ? p[p.length - 1] : null,
        htsCode: r.htsCode || null,
        unitPrice: num(r.unitPrice),
      };
      ATTRS.forEach((a) => { if (r[a]) sku[a] = r[a]; });
      skus.push(sku); skuByCode.set(sku.skuCode, sku); skusDirty = true;
    }
  });

  // Stored at (carton × SKU) grain — pieces and price only. totalUsd is NOT stored
  // (derived from pcs × unitPrice), and the WEIGHT/MEASURE are not stored here
  // either: they describe the physical box, so they go to sms_cartons once per
  // (shipment, ctnNumber) — see cartonFacts below and smsService.withCartonFacts.
  const cartons = rows.map((r, i) => {
    const unitPrice = num(r.unitPrice) ?? num(priceByPoSku.get(`${r.poNumber}|${r.sku}`));
    return {
      id: `spk_${shipment.id}_${i + 1}`,
      shipmentId: shipment.id,
      poNumber: r.poNumber,
      ctnNumber: num(r.ctnNumber),
      skuCode: r.sku,
      pcsPerCtn: num(r.pcsPerCtn),
      unitPrice,
    };
  });

  // One row per PHYSICAL carton. A packing sheet repeats the carton's weight on
  // every SKU line of that carton (and usually zeroes the repeats), so take the
  // first NON-EMPTY value seen for each field rather than the first row's value —
  // that is what makes the result independent of the sheet's row order.
  const cartonFacts = [];
  const cartonIdx = new Map();
  rows.forEach((r) => {
    const ctn = num(r.ctnNumber);
    const key = String(ctn);
    let k = cartonIdx.get(key);
    if (!k) {
      k = { id: `sctn_${shipment.id}_${ctn}`, shipmentId: shipment.id, ctnNumber: ctn,
            netWeightKgs: null, grossWeightKgs: null, measureCm: null };
      cartonIdx.set(key, k);
      cartonFacts.push(k);
    }
    const n = num(r.netWeightKgs), g = num(r.grossWeightKgs);
    if (k.netWeightKgs == null && n) k.netWeightKgs = n;
    if (k.grossWeightKgs == null && g) k.grossWeightKgs = g;
    if (k.measureCm == null && r.measureCm) k.measureCm = r.measureCm;
  });

  // rows for the generators — carton facts + computed totalUsd + descriptive attrs.
  // Descriptors come from the uploaded sheet (the only source for upc/knitWoven/
  // category/gender/composition — the SKU master doesn't carry them), falling back
  // to the SKU master where the sheet omits a value. cartons[i] ← rows[i] (1:1 by index).
  const generatorRows = cartons.map((c, i) => {
    const r = rows[i] || {};
    const sku = skuByCode.get(c.skuCode) || {};
    return {
      poNumber: c.poNumber, sku: c.skuCode, ctnNumber: c.ctnNumber,
      pcsPerCtn: c.pcsPerCtn || 0, unitPrice: c.unitPrice || 0,
      totalUsd: +(((c.pcsPerCtn || 0) * (c.unitPrice || 0)).toFixed(2)),
      // straight from the parsed sheet row (exactly what `cartons[i]` used to carry
      // before the carton facts moved to sms_cartons) so the generated CI / packing
      // list stay byte-identical to what this upload produced before the split
      netWeightKgs: num(r.netWeightKgs), grossWeightKgs: num(r.grossWeightKgs), measureCm: r.measureCm || null,
      upc: r.upc || sku.upc || '',
      knitWoven: r.knitWoven || sku.knitWoven || '',
      style_description: r.style_description || sku.description || sku.itemName || '',
      color_description: r.color_description || sku.colorway || '',
      category: r.category || sku.category || '',
      gender: r.gender || sku.gender || '',
      composition: r.composition || sku.composition || '',
      htsCode: r.htsCode || sku.htsCode || '', styleColor: sku.styleColor || '',
    };
  });

  const docs = await documentService.generateAll(shipment, generatorRows, { pos, suppliers, facilities, modes, notifyParty });

  // persist — replace this shipment's cartons + documents; write the SKU master
  // only when the sheet actually added/backfilled something
  await M.packingCartons.write([...allCartons.filter((c) => c.shipmentId !== shipment.id), ...cartons]);
  const allCartonFacts = await M.cartons.read().catch(() => []);
  await M.cartons.write([...allCartonFacts.filter((k) => k.shipmentId !== shipment.id), ...cartonFacts]);
  await M.documents.write([...allDocs.filter((d) => d.shipmentId !== shipment.id), ...docs]);
  if (skusDirty) await M.skus.write(skus);

  const { packingSummary } = require('./smsService');
  const summary = packingSummary(generatorRows);
  res.status(201).json({
    shipmentId: shipment.id,
    lines: cartons.length,            // carton×SKU rows parsed from the sheet
    cartons: summary.totalCartons,   // DISTINCT physical cartons (by ctnNumber)
    summary,
    documents: docs.length,
    per_po: docs.some((d) => d.poNumber),
  });
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
