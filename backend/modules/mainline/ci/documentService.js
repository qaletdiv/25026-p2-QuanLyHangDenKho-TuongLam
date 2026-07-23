'use strict';

// Generates CI + Packing-List artifacts from parsed shipment-data rows, at two grains:
//   • COMBINED — all the booking's rows (leg_id = null)
//   • PER-PO   — one set per PO/leg (only when the booking spans >1 PO)
// Both are produced from the SAME full rows in one pass (no re-generation, no detail
// loss). Returns mainline_documents records; the caller persists them.

const { Readable } = require('stream');
const { generateCI } = require('../../../services/ciGenerator');
const { generatePL } = require('../../../services/plGenerator');
const driveStorage = require('../../../driveStorage');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function summarize(rows) {
  const seen = new Set();
  let pcs = 0, val = 0, net = 0, gross = 0, cbm = 0;
  rows.forEach((r) => {
    pcs += +r.pcs_per_ctn || 0; val += +r.total_usd || 0;
    if (!seen.has(r.ctn_number)) {
      seen.add(r.ctn_number);
      net += +r.net_weight_kgs || 0; gross += +r.gross_weight_kgs || 0;
      const d = String(r.measure_cm || '').split(/[*×xX]/).map((p) => parseFloat(p.trim()));
      if (d.length === 3 && d.every((v) => !isNaN(v))) cbm += (d[0] * d[1] * d[2]) / 1e6;
    }
  });
  return { total_pcs: pcs, total_cartons: seen.size, total_value: +val.toFixed(2), total_net_weight: +net.toFixed(2), total_gross_weight: +gross.toFixed(2), total_cbm: +cbm.toFixed(3) };
}

async function _save(name, buffer) {
  const s = new Readable(); s.push(Buffer.from(buffer)); s.push(null);
  return driveStorage.uploadFile(name, s, XLSX_MIME);
}

function _meta(booking, poNumbers, invoiceNumber, { supplier, warehouse }) {
  return {
    vendor_name: supplier.name || '', vendor_address: supplier.address || '',
    po_number: poNumbers.join(', '), invoice_number: invoiceNumber,
    date: new Date().toISOString().slice(0, 10), shipment_number: booking.booking_number || '',
    country_of_origin: supplier.country || '', port_of_loading: supplier.port_of_loading || '',
    port_of_discharge: warehouse.port_of_discharge || '', consignee_name: warehouse.name || '',
    consignee_address: warehouse.address || '',
  };
}

// ctx: { legPoToId:Map<po,legId>, suppliers, facilities, orders, legs }
async function generateAll(booking, rows, ctx) {
  const { legPoToId, suppliers, facilities, orders, legs } = ctx;
  const supplier = suppliers.find((s) => s.id === booking.supplier_id) || {};
  const whFor = (poNumber) => {
    const leg = legs.find((l) => l.po_number === poNumber);
    const order = leg && orders.find((o) => o.po_number === leg.po_number);
    return (order && facilities.find((w) => w.id === order.facility_id)) || {};
  };
  const bkg = (booking.booking_number || booking.id).replace(/[^0-9]/g, '') || booking.id;
  const ds = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const ts = Date.now();

  const distinctPOs = [...new Set(rows.map((r) => r.po_number).filter(Boolean))];
  const groups = [{ legId: null, scope: 'ALL', pos: distinctPOs, rows }];
  if (distinctPOs.length > 1) {
    distinctPOs.forEach((po) => groups.push({ legId: legPoToId.get(po) || null, scope: po, pos: [po], rows: rows.filter((r) => r.po_number === po) }));
  }

  const docs = [];
  for (const g of groups) {
    const invoiceNumber = `INV-${bkg}-${g.scope}-${ds}`;
    const meta = _meta(booking, g.pos, invoiceNumber, { supplier, warehouse: whFor(g.pos[0]) });
    const shipmentData = { rows: g.rows, summary: summarize(g.rows) };
    const [ciBuf, plBuf] = await Promise.all([generateCI(shipmentData, meta), generatePL(shipmentData, meta)]);
    const slug = g.scope.replace(/[^a-zA-Z0-9-]/g, '_');
    const [ciDoc, plDoc] = await Promise.all([
      _save(`ci_${ts}_${bkg}_${slug}.xlsx`, ciBuf),
      _save(`pl_${ts}_${bkg}_${slug}.xlsx`, plBuf),
    ]);
    const now = new Date().toISOString();
    docs.push(
      { id: `doc_${booking.id}_${slug}_ci`, booking_id: booking.id, leg_id: g.legId, doc_type: 'commercial_invoice', file_url: ciDoc.url, invoice_number: invoiceNumber, generated_at: now },
      { id: `doc_${booking.id}_${slug}_pl`, booking_id: booking.id, leg_id: g.legId, doc_type: 'packing_list', file_url: plDoc.url, invoice_number: invoiceNumber, generated_at: now },
    );
  }
  return docs;
}

module.exports = { generateAll, summarize };
