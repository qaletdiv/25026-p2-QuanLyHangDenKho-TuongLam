'use strict';

// SMS shipping data — the vendor uploads one packing Excel per consignment:
//   • parse (shared ciParser) into carton rows
//   • write sms_packing_cartons (carton × SKU facts) — the shipped-per-SKU source
//   • generate CI + Packing-List documents (combined + per-PO) → sms_documents
// Re-upload replaces this shipment's cartons + documents.
//
// Derived, never stored: total_usd (= pcs × unit_price), shipped-per-SKU, the
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

  const [shipments, shipmentPos, pos, poLines, skus, suppliers, facilities, allCartons, allDocs] = await Promise.all([
    M.shipments.read(), M.shipmentPos.read(), M.pos.read(), M.poLines.read(),
    M.skus.read(), M.suppliers.read().catch(() => []), M.facilities.read(),
    M.packingCartons.read().catch(() => []), M.documents.read().catch(() => []),
  ]);
  const shipment = shipments.find((s) => s.id === req.params.id);
  if (!shipment) err('SMS shipment not found', 404);

  const myJunctions = shipmentPos.filter((j) => j.shipment_id === shipment.id);
  const shipmentPoNumbers = new Set(myJunctions.map((j) => j.po_number));
  const poByNumber = new Map(pos.map((p) => [p.po_number, p]));

  // vendor may only touch consignments carrying exclusively their POs
  if (vendorSupplierId && !myJunctions.every((j) => (poByNumber.get(j.po_number) || {}).supplier_id === vendorSupplierId)) {
    err("This shipment carries another supplier's POs", 403);
  }

  const parsed = parseShipmentData(req.file.buffer);
  const rows = parsed.rows || [];
  if (!rows.length) err('No rows found in the shipping-data file.', 422);

  // every row's PO must be one this consignment carries
  const stray = [...new Set(rows.map((r) => r.po_number).filter(Boolean))].filter((po) => !shipmentPoNumbers.has(po));
  if (stray.length) err(`The file has POs not on this shipment: ${stray.join(', ')}. This consignment carries: ${[...shipmentPoNumbers].join(', ')}.`, 400);

  // Default unit price from the NetSuite PO line when the sheet omits it. Built by
  // smsService.priceByPoSku, NOT `new Map(rows.map(...))`: one item can sit on
  // several NS lines at different prices, and last-row-wins made this value depend
  // on file/row order — which decides the CI value and therefore the landed cost.
  const priceByPoSku = svc.priceByPoSku(poLines);
  const skuByCode = new Map(skus.map((s) => [s.sku_code, s]));

  // Enrich the SKU master from the sheet — insert SKUs new to the catalogue and
  // backfill missing descriptive fields on existing ones (mirrors the mainline
  // shipment-data upload). Without this a SKU that's shipped but was never ordered
  // (so absent from sms_po_lines) resolves no item name on the PO detail's line
  // table. The sheet is authoritative for the descriptive attrs the master lacks.
  const ATTRS = ['upc', 'gender', 'category', 'composition', 'knit_woven'];
  let skusDirty = false;
  rows.forEach((r) => {
    if (!r.sku) return;
    const existing = skuByCode.get(r.sku);
    if (existing) {
      const before = JSON.stringify(existing);
      existing.item_name   = existing.item_name   || r.style_description || null;
      existing.description = existing.description || r.style_description || null;
      existing.colorway    = existing.colorway    || r.color_description || null;
      existing.hts_code    = existing.hts_code    || r.hts_code || null;
      ATTRS.forEach((a) => { if (r[a] && !existing[a]) existing[a] = r[a]; });
      if (JSON.stringify(existing) !== before) skusDirty = true;
    } else {
      const p = String(r.sku).split('-');
      const sku = {
        sku_code: r.sku,
        style_color: p.slice(0, -1).join('-') || null,
        item_name: r.style_description || null,
        description: r.style_description || null,
        colorway: r.color_description || null,
        size: p.length > 2 ? p[p.length - 1] : null,
        hts_code: r.hts_code || null,
        unit_price: num(r.unit_price),
      };
      ATTRS.forEach((a) => { if (r[a]) sku[a] = r[a]; });
      skus.push(sku); skuByCode.set(sku.sku_code, sku); skusDirty = true;
    }
  });

  // Stored at (carton × SKU) grain — pieces and price only. total_usd is NOT stored
  // (derived from pcs × unit_price), and the WEIGHT/MEASURE are not stored here
  // either: they describe the physical box, so they go to sms_cartons once per
  // (shipment, ctn_number) — see cartonFacts below and smsService.withCartonFacts.
  const cartons = rows.map((r, i) => {
    const unit_price = num(r.unit_price) ?? num(priceByPoSku.get(`${r.po_number}|${r.sku}`));
    return {
      id: `spk_${shipment.id}_${i + 1}`,
      shipment_id: shipment.id,
      po_number: r.po_number,
      ctn_number: num(r.ctn_number),
      sku_code: r.sku,
      pcs_per_ctn: num(r.pcs_per_ctn),
      unit_price,
    };
  });

  // One row per PHYSICAL carton. A packing sheet repeats the carton's weight on
  // every SKU line of that carton (and usually zeroes the repeats), so take the
  // first NON-EMPTY value seen for each field rather than the first row's value —
  // that is what makes the result independent of the sheet's row order.
  const cartonFacts = [];
  const cartonIdx = new Map();
  rows.forEach((r) => {
    const ctn = num(r.ctn_number);
    const key = String(ctn);
    let k = cartonIdx.get(key);
    if (!k) {
      k = { id: `sctn_${shipment.id}_${ctn}`, shipment_id: shipment.id, ctn_number: ctn,
            net_weight_kgs: null, gross_weight_kgs: null, measure_cm: null };
      cartonIdx.set(key, k);
      cartonFacts.push(k);
    }
    const n = num(r.net_weight_kgs), g = num(r.gross_weight_kgs);
    if (k.net_weight_kgs == null && n) k.net_weight_kgs = n;
    if (k.gross_weight_kgs == null && g) k.gross_weight_kgs = g;
    if (k.measure_cm == null && r.measure_cm) k.measure_cm = r.measure_cm;
  });

  // rows for the generators — carton facts + computed total_usd + descriptive attrs.
  // Descriptors come from the uploaded sheet (the only source for upc/knit_woven/
  // category/gender/composition — the SKU master doesn't carry them), falling back
  // to the SKU master where the sheet omits a value. cartons[i] ← rows[i] (1:1 by index).
  const generatorRows = cartons.map((c, i) => {
    const r = rows[i] || {};
    const sku = skuByCode.get(c.sku_code) || {};
    return {
      po_number: c.po_number, sku: c.sku_code, ctn_number: c.ctn_number,
      pcs_per_ctn: c.pcs_per_ctn || 0, unit_price: c.unit_price || 0,
      total_usd: +(((c.pcs_per_ctn || 0) * (c.unit_price || 0)).toFixed(2)),
      // straight from the parsed sheet row (exactly what `cartons[i]` used to carry
      // before the carton facts moved to sms_cartons) so the generated CI / packing
      // list stay byte-identical to what this upload produced before the split
      net_weight_kgs: num(r.net_weight_kgs), gross_weight_kgs: num(r.gross_weight_kgs), measure_cm: r.measure_cm || null,
      upc: r.upc || sku.upc || '',
      knit_woven: r.knit_woven || sku.knit_woven || '',
      style_description: r.style_description || sku.description || sku.item_name || '',
      color_description: r.color_description || sku.colorway || '',
      category: r.category || sku.category || '',
      gender: r.gender || sku.gender || '',
      composition: r.composition || sku.composition || '',
      hts_code: r.hts_code || sku.hts_code || '', style_color: sku.style_color || '',
    };
  });

  const docs = await documentService.generateAll(shipment, generatorRows, { pos, suppliers, facilities });

  // persist — replace this shipment's cartons + documents; write the SKU master
  // only when the sheet actually added/backfilled something
  await M.packingCartons.write([...allCartons.filter((c) => c.shipment_id !== shipment.id), ...cartons]);
  const allCartonFacts = await M.cartons.read().catch(() => []);
  await M.cartons.write([...allCartonFacts.filter((k) => k.shipment_id !== shipment.id), ...cartonFacts]);
  await M.documents.write([...allDocs.filter((d) => d.shipment_id !== shipment.id), ...docs]);
  if (skusDirty) await M.skus.write(skus);

  const { packingSummary } = require('./smsService');
  const summary = packingSummary(generatorRows);
  res.status(201).json({
    shipment_id: shipment.id,
    lines: cartons.length,            // carton×SKU rows parsed from the sheet
    cartons: summary.total_cartons,   // DISTINCT physical cartons (by ctn_number)
    summary,
    documents: docs.length,
    per_po: docs.some((d) => d.po_number),
  });
}

// GET /sms/shipments/:id/documents — generated CI/PL files, scope-labelled
async function getDocuments(req, res) {
  await assertShipmentVisible(req, req.params.id);
  const docs = (await M.documents.read().catch(() => [])).filter((d) => d.shipment_id === req.params.id);
  res.json(docs.map((d) => ({ ...d, scope: d.po_number || 'Combined (all POs)' })));
}

module.exports = { uploadShippingData, getDocuments };
