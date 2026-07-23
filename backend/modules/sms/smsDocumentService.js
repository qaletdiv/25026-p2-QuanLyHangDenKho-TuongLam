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

function _meta(shipment, poNumbers, invoiceNumber, { supplier, facility }) {
  return {
    vendor_name: supplier.name || '', vendor_address: supplier.address || '',
    po_number: poNumbers.join(', '), invoice_number: invoiceNumber,
    date: new Date().toISOString().slice(0, 10),
    shipment_number: shipment.tracking_number || shipment.id,   // the courier tracking # identifies an SMS consignment
    country_of_origin: supplier.country || '', port_of_loading: supplier.port_of_loading || '',
    port_of_discharge: facility.port_of_discharge || '', consignee_name: facility.name || '',
    consignee_address: facility.address || '',
  };
}

// ctx: { pos:sms_pos[], suppliers, facilities }
async function generateAll(shipment, rows, ctx) {
  const { pos, suppliers, facilities } = ctx;
  const poByNumber = new Map(pos.map((p) => [p.po_number, p]));
  // vendor scope guarantees one supplier per consignment; take it from the first PO
  const firstPo = poByNumber.get(rows.find((r) => r.po_number)?.po_number) || {};
  const supplier = suppliers.find((s) => s.id === firstPo.supplier_id) || {};
  const facility = facilities.find((f) => f.id === shipment.facility_id) || {};

  const sid = String(shipment.tracking_number || shipment.id).replace(/[^a-zA-Z0-9]/g, '') || shipment.id;
  const ds = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const ts = Date.now();

  const distinctPOs = [...new Set(rows.map((r) => r.po_number).filter(Boolean))];
  const groups = [{ poNumber: null, scope: 'ALL', pos: distinctPOs, rows }];
  if (distinctPOs.length > 1) {
    distinctPOs.forEach((po) => groups.push({ poNumber: po, scope: po, pos: [po], rows: rows.filter((r) => r.po_number === po) }));
  }

  const docs = [];
  for (const g of groups) {
    const invoiceNumber = `INV-${sid}-${g.scope}-${ds}`;
    const meta = _meta(shipment, g.pos, invoiceNumber, { supplier, facility });
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

module.exports = { generateAll };
