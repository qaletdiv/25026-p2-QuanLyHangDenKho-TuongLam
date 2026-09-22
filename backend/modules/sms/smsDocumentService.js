'use strict';

// Generates CI + Packing-List artifacts for an SMS consignment from its parsed
// carton rows, at two grains (mirrors mainline documentService):
//   • COMBINED — all the shipment's rows (po_number = null on the doc record)
//   • PER-PO   — one set per PO (only when the consignment carries >1 PO)
// Reuses the shared ciGenerator/plGenerator. Returns sms_documents records; the
// caller persists them.

const { Readable } = require('stream');
const { generateCI } = require('../../services/ciGenerator');
const { generatePL } = require('../../services/plGenerator');
const driveStorage = require('../../driveStorage');
const { packingSummary } = require('./smsService');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function _save(name, buffer) {
  const s = new Readable(); s.push(Buffer.from(buffer)); s.push(null);
  return driveStorage.uploadFile(name, s, XLSX_MIME);
}

function _meta(shipment, poNumbers, invoiceNumber, { supplier, facility, notify, shippingMode }) {
  return {
    vendor_name: supplier.name || '', vendor_address: supplier.address || '',
    // The factory, which may not be the company being invoiced — same source and
    // same fallback as mainline's documentService.
    manufacturer_name: supplier.manufacturer_name || '',
    manufacturer_address: supplier.manufacturer_address || '',
    po_number: poNumbers.join(', '), invoice_number: invoiceNumber,
    date: new Date().toISOString().slice(0, 10),
    shipment_number: shipment.tracking_number || shipment.id,   // the courier tracking # identifies an SMS consignment
    country_of_origin: supplier.country || '', port_of_loading: supplier.port_of_loading || '',
    port_of_discharge: facility.port_of_discharge || '', consignee_name: facility.name || '',
    consignee_address: facility.address || '',
    // Notify party is the SINGLETON `notify_party` row — always tentree, whatever
    // the destination or module. Same source as mainline's documentService.
    notify_party_name: notify.name || '',
    notify_party_address: notify.address || '',
    shipping_mode: shippingMode || '',
  };
}

// `mode_id` is set at booking-approve and is NULL on every vendor-entered parcel,
// which is the normal SMS path — those went by courier. Same fallback the landed
// -cost push applies to custbody16 (netsuiteLandedCost), so the document and the
// NetSuite record state the same mode.
function _shippingMode(shipment, modes) {
  const m = modes.find((x) => x.id === shipment.mode_id);
  return (m && m.name) || 'Courier';
}

// The consignment's rows rebuilt from STORED data, for the download path: packing
// cartons (already joined to their sms_cartons physical facts by the caller) plus
// the SKU master. The upload builds the same shape sheet-first — but it also
// backfills every descriptor it used into product_skus, so the two agree. The one
// case they can differ is a descriptor the sheet overrode on a SKU that already
// held a DIFFERENT value; the master keeps its own there.
function rowsFromCartons(cartons, skuByCode) {
  return cartons.map((c) => {
    const sku = skuByCode.get(c.sku_code) || {};
    return {
      po_number: c.po_number, sku: c.sku_code, ctn_number: c.ctn_number,
      pcs_per_ctn: c.pcs_per_ctn || 0, unit_price: c.unit_price || 0,
      total_usd: +(((c.pcs_per_ctn || 0) * (c.unit_price || 0)).toFixed(2)),
      net_weight_kgs: c.net_weight_kgs ?? null, gross_weight_kgs: c.gross_weight_kgs ?? null,
      measure_cm: c.measure_cm || null,
      upc: sku.upc || '', knit_woven: sku.knit_woven || '',
      style_description: sku.description || sku.item_name || '', color_description: sku.colorway || '',
      category: sku.category || '', gender: sku.gender || '', composition: sku.composition || '',
      hts_code: sku.hts_code || '', style_color: sku.style_color || '',
    };
  });
}

// The two document grains, in one place so generateAll and rebuild() can never
// disagree about which rows belong to which document.
function _groups(rows) {
  const distinctPOs = [...new Set(rows.map((r) => r.po_number).filter(Boolean))];
  const groups = [{ poNumber: null, scope: 'ALL', pos: distinctPOs, rows }];
  if (distinctPOs.length > 1) {
    distinctPOs.forEach((po) => groups.push({ poNumber: po, scope: po, pos: [po], rows: rows.filter((r) => r.po_number === po) }));
  }
  return groups;
}

// ctx: { pos:sms_pos[], suppliers, facilities, modes, notifyParty }
function _resolvers(shipment, rows, ctx) {
  const { pos, suppliers, facilities, modes = [], notifyParty = [] } = ctx;
  const poByNumber = new Map(pos.map((p) => [p.po_number, p]));
  // vendor scope guarantees one supplier per consignment; take it from the first PO
  const firstPo = poByNumber.get(rows.find((r) => r.po_number)?.po_number) || {};
  return {
    supplier: suppliers.find((s) => s.id === firstPo.supplier_id) || {},
    facility: facilities.find((f) => f.id === shipment.facility_id) || {},
    notify: notifyParty[0] || {},
    shippingMode: _shippingMode(shipment, modes),
  };
}

async function generateAll(shipment, rows, ctx) {
  const r = _resolvers(shipment, rows, ctx);
  const sid = String(shipment.tracking_number || shipment.id).replace(/[^a-zA-Z0-9]/g, '') || shipment.id;
  const ds = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const ts = Date.now();

  const docs = [];
  for (const g of _groups(rows)) {
    const invoiceNumber = `INV-${sid}-${g.scope}-${ds}`;
    const meta = _meta(shipment, g.pos, invoiceNumber, r);
    const shipmentData = { rows: g.rows, summary: packingSummary(g.rows) };
    const [ciBuf, plBuf] = await Promise.all([generateCI(shipmentData, meta), generatePL(shipmentData, meta)]);
    const slug = g.scope.replace(/[^a-zA-Z0-9-]/g, '_');
    const [ciDoc, plDoc] = await Promise.all([
      _save(`sms_ci_${ts}_${sid}_${slug}.xlsx`, ciBuf),
      _save(`sms_pl_${ts}_${sid}_${slug}.xlsx`, plBuf),
    ]);
    const now = new Date().toISOString();
    docs.push(
      { id: `sdoc_${shipment.id}_${slug}_ci`, shipment_id: shipment.id, po_number: g.poNumber, doc_type: 'commercial_invoice', file_url: ciDoc.url, invoice_number: invoiceNumber, generated_at: now },
      { id: `sdoc_${shipment.id}_${slug}_pl`, shipment_id: shipment.id, po_number: g.poNumber, doc_type: 'packing_list', file_url: plDoc.url, invoice_number: invoiceNumber, generated_at: now },
    );
  }
  return docs;
}

// Rebuild ONE stored document's workbook from CURRENT data, without saving —
// mirrors mainline's documentService.rebuild, and exists for the same reason: the
// letterhead comes from master data edited after the upload, so a stored xlsx
// freezes whatever was blank at generation time. Keeps the stored invoice_number.
async function rebuild(doc, shipment, rows, ctx) {
  const r = _resolvers(shipment, rows, ctx);
  const group = _groups(rows).find((g) => (g.poNumber || null) === (doc.po_number || null));
  if (!group) return null;
  const meta = _meta(shipment, group.pos, doc.invoice_number, r);
  const shipmentData = { rows: group.rows, summary: packingSummary(group.rows) };
  return doc.doc_type === 'packing_list'
    ? generatePL(shipmentData, meta)
    : generateCI(shipmentData, meta);
}

module.exports = { generateAll, rebuild, rowsFromCartons };
