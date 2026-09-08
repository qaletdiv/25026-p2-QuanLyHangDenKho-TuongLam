'use strict';

// SMS purchase orders — read endpoints over the module's OWN sms_pos dataset.
//   GET /sms/pos                 → list, enriched + rollups (lots/shipped/received)
//   GET /sms/pos/:poNumber       → detail: lines, consignments, reconciliation
// Writes come from the SMS NetSuite sync (phase 4) — POs are not hand-edited.

const M = require('./SmsModels');
const { poRollups, reconcilePo, deriveStatus, priceByPoSku } = require('./smsService');
const { receivedByShipment } = require('./receiptMatch');
const { resolveVendorSupplierId } = require('../../utils/vendorScope');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };

// _ctx(vendorSupplierId) — the single scoping point for the SMS PO read path.
//
// sms_pos.supplier_id is direct, so `pos` is a straight filter. `poLines` MUST be
// filtered too: getAllLines maps over every line and joins the PO, so an unfiltered
// line whose PO isn't the vendor's would still emit its po_number, sku_code and
// ordered qty (with the joined names blank) — a real leak of another supplier's SKUs.
//
// The remaining tables (shipments, junction, receipts, cartons) stay WHOLE on
// purpose: they are lookup context keyed by po_number, read only for the PO
// currently being enriched, so scoping `pos` already bounds what can be returned —
// and pruning them would break the ordered/shipped/received rollups.
async function _ctx(vendorSupplierId) {
  const [allPos, allPoLines, shipments, shipmentPos, trackingEvents, receipts, receiptLines, packingCartons,
         codeRows, statuses, suppliers, seasons, facilities, channels, skus, rejections] = await Promise.all([
    M.pos.read(), M.poLines.read(), M.shipments.read(), M.shipmentPos.read(),
    M.trackingEvents.read().catch(() => []), M.receipts.read().catch(() => []), M.receiptLines.read().catch(() => []),
    M.packingCartons.read().catch(() => []),
    M.courierStatusMap.read().catch(() => []), M.statuses.read(),
    M.suppliers.read().catch(() => []), M.seasons.read(), M.facilities.read(), M.allocationChannels.read().catch(() => []), M.skus.read(),
    M.receiptRejections.read().catch(() => []),
  ]);
  let pos = allPos, poLines = allPoLines;
  if (vendorSupplierId != null) {
    const mine = String(vendorSupplierId);
    pos = allPos.filter((p) => String(p.supplier_id) === mine);
    const poNumbers = new Set(pos.map((p) => p.po_number));
    poLines = allPoLines.filter((l) => poNumbers.has(l.po_number));
  }

  return {
    pos, poLines, shipments, shipmentPos, trackingEvents, receipts, receiptLines, packingCartons,
    // per-lot NetSuite Item Receipt attribution → the derived 'Received' status
    // (built over the WHOLE junction — see the note above on unscoped context)
    received: receivedByShipment({ junctions: shipmentPos, cartons: packingCartons, receipts, receiptLines, shipments, rejections }),
    codeMap: new Map(codeRows.map((r) => [`${r.courier_id}|${r.courier_code}`, r.status_id])),
    statusNameById: new Map(statuses.map((s) => [s.id, s.name])),
    supName: new Map(suppliers.map((s) => [s.id, s.name])),
    seasonCode: new Map(seasons.map((s) => [s.id, s.code])),
    facName: new Map(facilities.map((f) => [f.id, f.name])),
    chanName: new Map(channels.map((ch) => [ch.id, ch.name])),
    skuByCode: new Map(skus.map((s) => [s.sku_code, s])),
    eventsByShipment: trackingEvents.reduce((m, e) => ((m[e.shipment_id] = m[e.shipment_id] || []).push(e), m), {}),
  };
}

function enrichPo(po, c, rollups) {
  const ordered = rollups.ordered.get(po.po_number) || 0;
  const shipped = rollups.shipped.get(po.po_number) || 0;
  const received = rollups.received.get(po.po_number) || 0;
  return {
    ...po,
    supplier: c.supName.get(po.supplier_id) || null,
    season: c.seasonCode.get(po.season_id) || null,
    facility: c.facName.get(po.facility_id) || null,
    allocation_channel: c.chanName.get(po.allocation_channel_id) || null,
    ordered_qty: ordered,
    shipped_qty: shipped,
    received_qty: received,
    remaining_qty: ordered - shipped,
    lot_count: rollups.lots.get(po.po_number) || 0,
    // derived fulfillment state ("2 of 3 lots shipped" is UI copy; state is data)
    fulfillment: received >= ordered && ordered > 0 ? 'received'
      : shipped >= ordered && ordered > 0 ? 'fully_shipped'
      : shipped > 0 ? 'partially_shipped' : 'not_shipped',
  };
}

async function getAll(req, res) {
  const c = await _ctx(await resolveVendorSupplierId(req.user, { onUnlinked: 'deny' }));
  const rollups = poRollups(c);
  res.json(c.pos.map((po) => enrichPo(po, c, rollups)));
}

async function getOne(req, res) {
  const c = await _ctx(await resolveVendorSupplierId(req.user, { onUnlinked: 'deny' }));
  const po = c.pos.find((p) => p.po_number === req.params.poNumber);
  if (!po) err('SMS PO not found', 404);
  const rollups = poRollups(c);

  const lines = c.poLines.filter((l) => l.po_number === po.po_number).map((l) => ({
    ...l,
    item_name: (c.skuByCode.get(l.sku_code) || {}).item_name || null,
    size: (c.skuByCode.get(l.sku_code) || {}).size || null,
  }));

  const shipById = new Map(c.shipments.map((s) => [s.id, s]));
  // cartons the vendor declared, else the actual distinct cartons from the
  // uploaded shipping data for this PO within that consignment (fallback for when
  // the count was left blank at entry) — scoped per (shipment, PO)
  const actualCartons = (shipmentId) =>
    new Set(c.packingCartons
      .filter((k) => k.po_number === po.po_number && k.shipment_id === shipmentId && k.ctn_number != null)
      .map((k) => k.ctn_number)).size || null;
  const consignments = c.shipmentPos.filter((j) => j.po_number === po.po_number)
    .sort((a, b) => (a.lot_number || 0) - (b.lot_number || 0))
    .map((j) => {
      const s = shipById.get(j.shipment_id) || {};
      return {
        shipment_id: j.shipment_id,
        lot_number: j.lot_number,
        units: j.units,
        cartons: j.cartons != null ? j.cartons : actualCartons(j.shipment_id),
        tracking_number: s.tracking_number || null,
        courier_id: s.courier_id || null,
        ship_date: s.ship_date || null,
        ...deriveStatus(s, c.eventsByShipment, c.codeMap, c.statusNameById, c.received),
        received_date: (c.received.get(j.shipment_id) || {}).receipt_date ?? null,
      };
    });

  // Enrich reconciliation SKU rows with item name + unit price. A SKU can appear
  // here from shipping data WITHOUT being an ordered PO line (vendor packed a SKU
  // not on the PO) — such rows have no order line, so item name falls back to the
  // SKU master and price to the shipped carton's unit price (then the master list).
  const reconciliation = reconcilePo(po.po_number, c);
  // Same deterministic pick as the packing upload (smsService.priceByPoSku) — a SKU
  // can appear on several NS PO lines at different prices, so last-row-wins would
  // show a different price here than the CI used.
  const myPrices = priceByPoSku(c.poLines.filter((l) => l.po_number === po.po_number));
  const priceByLine = new Map([...myPrices].map(([k, v]) => [k.split('|')[1], v]));
  const priceByCarton = new Map();
  c.packingCartons.filter((k) => k.po_number === po.po_number)
    .forEach((k) => { if (k.unit_price != null && !priceByCarton.has(k.sku_code)) priceByCarton.set(k.sku_code, k.unit_price); });
  reconciliation.by_sku = reconciliation.by_sku.map((s) => {
    const sku = c.skuByCode.get(s.sku_code) || {};
    const unit_price = priceByLine.get(s.sku_code) ?? priceByCarton.get(s.sku_code) ?? sku.unit_price ?? null;
    return { ...s, item_name: sku.item_name || null, unit_price };
  });

  res.json({
    ...enrichPo(po, c, rollups),
    lines,
    consignments,
    reconciliation,
  });
}

// GET /sms/po-lines — EVERY SKU order line across all SMS POs, enriched with PO
// context + SKU descriptions. Feeds the "item lines" download on the PO list.
async function getAllLines(req, res) {
  const c = await _ctx(await resolveVendorSupplierId(req.user, { onUnlinked: 'deny' }));
  const poByNumber = new Map(c.pos.map((p) => [p.po_number, p]));
  const rows = c.poLines.map((l) => {
    const po = poByNumber.get(l.po_number) || {};
    const sku = c.skuByCode.get(l.sku_code) || {};
    return {
      po_number:              l.po_number,
      trn_number:             po.trn_number || null,
      supplier:               c.supName.get(po.supplier_id) || null,
      season:                 c.seasonCode.get(po.season_id) || null,
      facility:               c.facName.get(po.facility_id) || null,
      allocation_channel:     c.chanName.get(po.allocation_channel_id) || null,
      hod:                    po.hod || null,
      expected_received_date: po.expected_received_date || null,
      sku_code:               l.sku_code,
      item_name:              sku.item_name || null,
      size:                   sku.size || null,
      ordered_qty:            l.ordered_qty || 0,
      unit_price:             l.unit_price ?? null,
    };
  }).sort((a, b) => (a.po_number || '').localeCompare(b.po_number || '') || (a.sku_code || '').localeCompare(b.sku_code || ''));
  res.json(rows);
}

module.exports = { getAll, getOne, getAllLines };
