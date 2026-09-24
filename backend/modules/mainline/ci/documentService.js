'use strict';

// Generates CI + Packing-List artifacts from parsed shipment-data rows, at two grains:
//   • COMBINED — all the booking's rows (legId = null)
//   • PER-PO   — one set per PO/leg (only when the booking spans >1 PO)
// Both are produced from the SAME full rows in one pass (no re-generation, no detail
// loss). Returns mainline_documents records; the caller persists them.

const { Readable } = require('stream');
const { generateCI } = require('../../../services/ciGenerator');
const { generatePL } = require('../../../services/plGenerator');
const fileStorage = require('../../../storage/fileStorage');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function summarize(rows) {
  const seen = new Set();
  let pcs = 0, val = 0, net = 0, gross = 0, cbm = 0;
  rows.forEach((r) => {
    pcs += +r.pcsPerCtn || 0; val += +r.totalUsd || 0;
    // `_group_key` (po#ctn) keeps cartons distinct across POs — two POs may both
    // start at carton #1; falls back to ctnNumber for single-PO / SMS callers.
    const ck = r._group_key ?? r.ctnNumber;
    if (!seen.has(ck)) {
      seen.add(ck);
      net += +r.netWeightKgs || 0; gross += +r.grossWeightKgs || 0;
      const d = String(r.measureCm || '').split(/[*×xX]/).map((p) => parseFloat(p.trim()));
      if (d.length === 3 && d.every((v) => !isNaN(v))) cbm += (d[0] * d[1] * d[2]) / 1e6;
    }
  });
  return { totalPcs: pcs, totalCartons: seen.size, totalValue: +val.toFixed(2), totalNetWeight: +net.toFixed(2), totalGrossWeight: +gross.toFixed(2), totalCbm: +cbm.toFixed(3) };
}

async function _save(name, buffer) {
  const s = new Readable(); s.push(Buffer.from(buffer)); s.push(null);
  return fileStorage.uploadFile(name, s, XLSX_MIME);
}

// The booking's full carton row set, in the shape the generators want. ONE
// definition, used by the upload (with its freshly-enriched SKU map) and by the
// download rebuild (with the stored product_skus) — so a regenerated workbook
// carries exactly the rows the stored one did. `_group_key` keeps carton grouping
// unique across POs, both of which may number their cartons from #1.
function rowsFromCartons(bookingCartons, legIdToPo, skuByCode) {
  return bookingCartons.map((c) => {
    const s = skuByCode.get(c.skuCode) || {};
    const po = legIdToPo.get(String(c.legId)) || null;
    return {
      _group_key: `${po || 'unm'}#${c.ctnNumber}`,
      ctnNumber: c.ctnNumber, poNumber: po, sku: c.skuCode,
      upc: s.upc || '', knitWoven: s.knitWoven || '',
      style_description: s.itemName || s.description || '', color_description: s.colorway || '',
      category: s.category || '', gender: s.gender || '', composition: s.composition || '', htsCode: s.htsCode || '',
      unitPrice: c.unitPrice || 0, totalUsd: c.totalUsd || 0, pcsPerCtn: c.pcsPerCtn || 0,
      netWeightKgs: c.netWeightKgs || 0, grossWeightKgs: c.grossWeightKgs || 0, measureCm: c.measureCm || '',
    };
  }).sort((a, b) => (a.poNumber || '').localeCompare(b.poNumber || '') || (a.ctnNumber - b.ctnNumber));
}

function _meta(booking, poNumbers, invoiceNumber, { supplier, warehouse, notify, shippingMode }) {
  return {
    vendor_name: supplier.name || '', vendor_address: supplier.address || '',
    // The factory, which may not be the company being invoiced. The generator
    // falls back to the vendor when these are blank.
    manufacturerName: supplier.manufacturerName || '',
    manufacturerAddress: supplier.manufacturerAddress || '',
    poNumber: poNumbers.join(', '), invoiceNumber: invoiceNumber,
    date: new Date().toISOString().slice(0, 10), shipmentNumber: booking.bookingNumber || '',
    country_of_origin: supplier.country || '', portOfLoading: supplier.portOfLoading || '',
    // The CONSIGNEE is the destination the PO names (NRI CA / NRI US / Direct) —
    // warehouse_facilities, joined through po_orders.facilityId.
    portOfDischarge: warehouse.portOfDischarge || '', consignee_name: warehouse.name || '',
    consignee_address: warehouse.address || '',
    // Notify party is the SINGLETON `notify_party` row — always tentree, whatever
    // the destination or module.
    notify_party_name: notify.name || '',
    notify_party_address: notify.address || '',
    // Derived from the leg, never stored on the document: `modes.name` for the
    // leg(s) this group covers. G3 holds a booking to ONE mode, so this is a
    // single value in practice; joined rather than picked if that ever changes,
    // because a silently-dropped mode on a customs document is worse than two.
    shipping_mode: shippingMode || '',
  };
}

// The two document grains, in one place so generateAll and rebuild() can never
// disagree about which rows belong to which document: COMBINED (legId null) plus
// one per PO when the booking spans more than one.
function _groups(rows, legPoToId) {
  const distinctPOs = [...new Set(rows.map((r) => r.poNumber).filter(Boolean))];
  const groups = [{ legId: null, scope: 'ALL', pos: distinctPOs, rows }];
  if (distinctPOs.length > 1) {
    distinctPOs.forEach((po) => groups.push({ legId: legPoToId.get(po) || null, scope: po, pos: [po], rows: rows.filter((r) => r.poNumber === po) }));
  }
  return groups;
}

// ctx: { legPoToId:Map<po,legId>, suppliers, facilities, orders, legs, modes, notifyParty }
function _resolvers(booking, ctx) {
  const { legPoToId, suppliers, facilities, orders, legs, modes = [], notifyParty = [] } = ctx;
  const supplier = suppliers.find((s) => s.id === booking.supplierId) || {};
  const notify = notifyParty[0] || {};
  const modeName = new Map(modes.map((m) => [m.id, m.name]));
  const legById = new Map(legs.map((l) => [l.id, l]));
  const whFor = (poNumber) => {
    const leg = legs.find((l) => l.poNumber === poNumber);
    const order = leg && orders.find((o) => o.poNumber === leg.poNumber);
    return (order && facilities.find((w) => w.id === order.facilityId)) || {};
  };
  // Resolve through legPoToId (THIS booking's legs), not `legs.find(po)` — a PO
  // split air + sea has two legs and the first one found may belong to another
  // booking, which would print the other consignment's mode.
  const modeFor = (poNumbers) => [...new Set(poNumbers
    .map((po) => legById.get(legPoToId.get(po)))
    .map((l) => l && modeName.get(l.modeId))
    .filter(Boolean))].join(' / ');
  return { supplier, notify, whFor, modeFor };
}

function _build(booking, group, invoiceNumber, r) {
  const meta = _meta(booking, group.pos, invoiceNumber, {
    supplier: r.supplier, warehouse: r.whFor(group.pos[0]), notify: r.notify, shippingMode: r.modeFor(group.pos),
  });
  return { rows: group.rows, summary: summarize(group.rows), meta };
}

async function generateAll(booking, rows, ctx) {
  const r = _resolvers(booking, ctx);
  const bkg = (booking.bookingNumber || booking.id).replace(/[^0-9]/g, '') || booking.id;
  const ds = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const ts = Date.now();

  const docs = [];
  for (const g of _groups(rows, ctx.legPoToId)) {
    const invoiceNumber = `INV-${bkg}-${g.scope}-${ds}`;
    const { meta, ...shipmentData } = _build(booking, g, invoiceNumber, r);
    const [ciBuf, plBuf] = await Promise.all([generateCI(shipmentData, meta), generatePL(shipmentData, meta)]);
    const slug = g.scope.replace(/[^a-zA-Z0-9-]/g, '_');
    const [ciDoc, plDoc] = await Promise.all([
      _save(`ci_${ts}_${bkg}_${slug}.xlsx`, ciBuf),
      _save(`pl_${ts}_${bkg}_${slug}.xlsx`, plBuf),
    ]);
    const now = new Date().toISOString();
    docs.push(
      { id: `doc_${booking.id}_${slug}_ci`, bookingId: booking.id, legId: g.legId, docType: 'commercial_invoice', fileUrl: ciDoc.url, invoiceNumber: invoiceNumber, generatedAt: now },
      { id: `doc_${booking.id}_${slug}_pl`, bookingId: booking.id, legId: g.legId, docType: 'packing_list', fileUrl: plDoc.url, invoiceNumber: invoiceNumber, generatedAt: now },
    );
  }
  return docs;
}

// Rebuild ONE stored document's workbook from CURRENT data, without saving.
//
// The letterhead (supplier address, consignee address, port of discharge, notify
// party) comes from master data that is edited long after the upload, so a stored
// xlsx freezes whatever was blank at generation time — which is exactly how every
// downloaded CI ended up with an empty consignee block. Downloads rebuild instead:
// same cartons, same `invoiceNumber` (the document's identity — a new one would
// be a different invoice), current master data.
async function rebuild(doc, booking, rows, ctx) {
  const r = _resolvers(booking, ctx);
  const group = _groups(rows, ctx.legPoToId).find((g) => (g.legId || null) === (doc.legId || null));
  if (!group) return null;
  const { meta, ...shipmentData } = _build(booking, group, doc.invoiceNumber, r);
  return doc.docType === 'packing_list'
    ? generatePL(shipmentData, meta)
    : generateCI(shipmentData, meta);
}

module.exports = { generateAll, rebuild, rowsFromCartons, summarize };
