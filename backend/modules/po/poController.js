'use strict';

// Shared PO hierarchy — READ path (Phase 1).
//   po_masters (TRN) → po_orders (poNumber) → po_order_lines
//                                            → mainline_po_legs → leg_lines
// Lifecycle state and totals are DERIVED live (never stored), per the schema rule.

const { models } = require('../../models');
const { resolveVendorSupplierId } = require('../../utils/vendorScope');
// pure date helper only — reused so the "expected ATA = E-DEL + 5" rule has ONE
// definition shared with /reports/mainline rather than a second copy here.
const { addDays } = require('../mainline/reports/transitTimeService');
// shipped/received per (leg, SKU) for the item-lines export — the SAME derivation
// the PO leg page reconciles with, so the spreadsheet and the screen agree
const { legActuals } = require('../mainline/fulfillment/fulfillmentService');
const { deriveAllCiLines } = require('../mainline/ci/ciLines');
// ATA is derived from the NetSuite Item Receipts, never the raw column — one
// precedence rule, shared with the report endpoints
const { loadAtaByShipment, effectiveAta } = require('../mainline/receipts/ataLoader');

const notFound = (msg) => { const e = new Error(msg); e.statusCode = 404; throw e; };

// Vendor row scoping for every read in this file. Reads use onUnlinked:'deny', so a
// vendor account that resolves to no supplier sees an empty order book rather than
// a 403 on a page load.
const scopeOf = (req) => resolveVendorSupplierId(req.user, { onUnlinked: 'deny' });

// id → name lookup from a master-data file
const nameMap = (rows, key = 'name') => new Map((Array.isArray(rows) ? rows : []).map((r) => [r.id, r[key]]));

// group an array into { key -> [rows] }
const groupBy = (rows, key) => rows.reduce((m, r) => {
  (m[r[key]] = m[r[key]] || []).push(r);
  return m;
}, {});

// forecast (no legs) | split (every order split) | partial (some orders split)
const lifecycleOf = (legCount, splitOrders, orderCount) =>
  legCount === 0 ? 'forecast'
  : splitOrders === orderCount ? 'split'
  : 'partial';

// loadAll(vendorSupplierId) — the SINGLE scoping point for the whole PO read path.
//
// supplierId lives only on po_masters, and every read here already joins through
// it, so filtering the five source tables once here scopes every handler at once:
// the list endpoints return only the vendor's rows, and getOne/getLeg fall through
// to their existing notFound() — a 404 rather than a 403, which is deliberate. A 403
// would confirm that a TRN or leg id exists, letting a vendor enumerate other
// suppliers' PO numbers; 404 is indistinguishable from "no such record".
//
// Pass null (staff) to disable scoping. Masters with a null supplierId are excluded
// for vendors, which is correct — an unattributed master is not theirs.
async function loadAll(vendorSupplierId) {
  const [allMasters, allOrders, allOrderLines, allLegs, allLegLines] = await Promise.all([
    models.po_masters.read(),
    models.po_orders.read(),
    models.po_order_lines.read(),
    models.mainline_po_legs.read(),
    models.mainline_po_leg_lines.read(),
  ]);

  let masters = allMasters, orders = allOrders, orderLines = allOrderLines,
      legs = allLegs, legLines = allLegLines;

  if (vendorSupplierId != null) {
    const mine = String(vendorSupplierId);
    masters = allMasters.filter((m) => m.supplierId != null && String(m.supplierId) === mine);
    const trns = new Set(masters.map((m) => m.trnNumber));
    orders = allOrders.filter((o) => trns.has(o.trnNumber));
    const poNumbers = new Set(orders.map((o) => o.poNumber));
    orderLines = allOrderLines.filter((l) => poNumbers.has(l.poNumber));
    legs = allLegs.filter((l) => poNumbers.has(l.poNumber));
    const legIds = new Set(legs.map((l) => l.id));
    legLines = allLegLines.filter((ll) => legIds.has(ll.legId));
  }

  return {
    masters, orders, orderLines, legs, legLines,
    ordersByTrn:   groupBy(orders, 'trnNumber'),
    linesByPo:     groupBy(orderLines, 'poNumber'),
    legsByPo:      groupBy(legs, 'poNumber'),
    legLinesByLeg: groupBy(legLines, 'legId'),
  };
}

// GET /po/legs — FLAT PO-order-book list. One row per LEG (air/sea split) once a
// PO is split by WIP; plus one FORECAST row per order that has NO legs yet, so a
// vendor sees a master PO the moment it syncs from NetSuite — before the air/sea
// split exists. Forecast rows carry order-level facts (qty from order_lines,
// facility/channel/COO) but no mode/CRD/dates (those are leg attributes) and are
// not bookable. `lifecycle` = 'split' | 'forecast'.
async function getLegs(req, res) {
  const [d, modes, incoterms, facilities, channels, suppliers, seasons] = await Promise.all([
    loadAll(await scopeOf(req)),
    models.modes.read(),
    models.incoterms.read(),
    models.warehouse_facilities.read(),
    models.allocation_channels.read(),
    models.suppliers.read(),
    models.seasons.read(),
  ]);
  const modeName = nameMap(modes), incoName = nameMap(incoterms), facName = nameMap(facilities);
  const chanName = nameMap(channels);
  const supName = nameMap(suppliers), seasonName = nameMap(seasons, 'code');
  const orderByPo = new Map(d.orders.map((o) => [o.poNumber, o]));
  const masterByTrn = new Map(d.masters.map((m) => [m.trnNumber, m]));

  const legRows = d.legs.map((leg) => {
    const order = orderByPo.get(leg.poNumber) || {};
    const master = masterByTrn.get(order.trnNumber) || {};
    const expectedQty = (d.legLinesByLeg[leg.id] || []).reduce((s, l) => s + (l.allocatedQty || 0), 0);
    return {
      id:                  leg.id,
      poNumber:           leg.poNumber,
      trnNumber:          order.trnNumber || null,
      supplier:            supName.get(master.supplierId) || null,
      season:              seasonName.get(master.seasonId) || null,
      mainShoulder:       master.mainShoulder || null,
      mode:                modeName.get(leg.modeId) || null,
      incoterm:            incoName.get(leg.incotermId) || null,
      receivingWarehouse: facName.get(order.facilityId) || null,   // physical facility (NRI US, …)
      allocationChannel:  chanName.get(order.allocationChannelId) || null,  // Reserved/First
      coo:                 order.cooCountry || null,
      crd:                 leg.crd || null,
      etdPol:             leg.etdPol || null,
      eDel:               leg.eDel || null,
      expectedQty,
      skuCount:           (d.legLinesByLeg[leg.id] || []).length,
      lifecycle:           'split',
      // NetSuite's sign-off state for the PO this leg belongs to ('Pending
      // Approval' | 'Approved' | null). Stored on the order by the NS sync; carried
      // here so the list can badge a PO no supervisor has approved yet — until now
      // an unapproved PO was indistinguishable from an approved one.
      approvalStatus:     order.approvalStatus || null,
      bookable:            true,   // a leg is always bookable (it exists = PO is split)
    };
  });

  // Forecast rows: orders with no legs yet (synced from NetSuite / WIP-bootstrapped
  // but not split into air/sea). One row per such order.
  const splitPoNumbers = new Set(d.legs.map((l) => l.poNumber));
  const forecastRows = d.orders.filter((o) => !splitPoNumbers.has(o.poNumber)).map((order) => {
    const master = masterByTrn.get(order.trnNumber) || {};
    const lines = d.linesByPo[order.poNumber] || [];
    return {
      id:                  `forecast_${order.poNumber}`,   // synthetic key (no real leg)
      poNumber:           order.poNumber,
      trnNumber:          order.trnNumber || null,
      supplier:            supName.get(master.supplierId) || null,
      season:              seasonName.get(master.seasonId) || null,
      mainShoulder:       master.mainShoulder || null,
      mode:                null,                              // no split yet
      incoterm:            null,
      receivingWarehouse: facName.get(order.facilityId) || null,
      allocationChannel:  chanName.get(order.allocationChannelId) || null,
      coo:                 order.cooCountry || null,
      crd:                 null,
      etdPol:             null,
      eDel:               null,
      expectedQty:        lines.reduce((s, l) => s + (l.orderedQty || 0), 0),
      skuCount:           lines.length,
      lifecycle:           'forecast',
      approvalStatus:     order.approvalStatus || null,
      bookable:            false,   // can't book until split into legs
    };
  });

  const rows = [...legRows, ...forecastRows].sort(
    (a, b) => (a.poNumber || '').localeCompare(b.poNumber || '') || (a.mode || '~').localeCompare(b.mode || '~'),
  );
  res.json(rows);
}

// GET /po — list every master with derived rollups + lifecycle state.
async function getAll(req, res) {
  const d = await loadAll(await scopeOf(req));
  const result = d.masters.map((m) => {
    const myOrders = d.ordersByTrn[m.trnNumber] || [];
    let legCount = 0, ordered = 0, splitOrders = 0;
    myOrders.forEach((o) => {
      const legs = d.legsByPo[o.poNumber] || [];
      legCount += legs.length;
      if (legs.length) splitOrders += 1;
      (d.linesByPo[o.poNumber] || []).forEach((l) => { ordered += l.orderedQty || 0; });
    });
    const lifecycleState = lifecycleOf(legCount, splitOrders, myOrders.length);
    return {
      ...m,
      orderCount:       myOrders.length,
      legCount:         legCount,
      totalOrderedQty: ordered,
      lifecycleState,
      bookable:          legCount > 0,   // leg-only booking rule
    };
  });
  res.json(result);
}

// GET /po/:trn — full master detail: orders → order_lines + legs → leg_lines.
async function getOne(req, res) {
  const { trn } = req.params;
  const [d, facilities, channels, modes, suppliers, seasons] = await Promise.all([
    loadAll(await scopeOf(req)),
    models.warehouse_facilities.read(),
    models.allocation_channels.read(),
    models.modes.read(),
    models.suppliers.read(),
    models.seasons.read(),
  ]);
  const facName = nameMap(facilities), chanName = nameMap(channels), modeName = nameMap(modes);
  const supName = nameMap(suppliers), seasonName = nameMap(seasons, 'code');
  const master = d.masters.find((m) => m.trnNumber === trn);
  if (!master) notFound(`PO master not found: ${trn}`);

  const myOrders = d.ordersByTrn[trn] || [];
  let totalLegs = 0, splitOrders = 0, totalOrdered = 0;

  const orders = myOrders.map((o) => {
    const legs = (d.legsByPo[o.poNumber] || []).map((leg) => ({
      ...leg,
      mode: modeName.get(leg.modeId) || null,
      leg_lines: d.legLinesByLeg[leg.id] || [],
      expectedQty: (d.legLinesByLeg[leg.id] || []).reduce((s, l) => s + (l.allocatedQty || 0), 0),
    }));
    totalLegs += legs.length;
    if (legs.length) splitOrders += 1;
    const order_lines = d.linesByPo[o.poNumber] || [];
    order_lines.forEach((l) => { totalOrdered += l.orderedQty || 0; });
    return {
      ...o,
      destinationFacility: facName.get(o.facilityId) || null,   // physical destination name
      allocationChannel:   chanName.get(o.allocationChannelId) || null,  // Reserved/First
      order_lines,
      legs,
      lifecycleState: legs.length ? 'split' : 'forecast',
    };
  });

  res.json({
    ...master,
    supplier:          supName.get(master.supplierId) || null,   // resolved name (display)
    season:            seasonName.get(master.seasonId) || null,
    // same rollups as getAll() so detail and list share one shape (PoMasterSummary)
    orderCount:       myOrders.length,
    legCount:         totalLegs,
    totalOrderedQty: totalOrdered,
    lifecycleState:   lifecycleOf(totalLegs, splitOrders, myOrders.length),
    bookable:          totalLegs > 0,
    orders,
  });
}

// GET /po/leg-lines — EVERY SKU allocation across all legs, enriched with PO/leg
// context + SKU descriptions. Feeds the "item lines" download on the PO list.
//
// Dates come from TWO grains and are kept in SEPARATE columns, never merged:
//   PLANNED — crd / eDel / etdPolPlanned, from the WIP-owned leg.
//   ACTUAL  — etdPol / etaPod / eDelActual / cargoReceivedDate / ata, from
//             the shipment(s) the leg was loaded onto (mainline_shipment_legs).
// Overwriting the planned value with the actual would erase the very slip the
// report exists to show, so both are emitted side by side.
//
// GRAIN IS PRESERVED: one row per (leg, SKU), as before. A leg may span several
// shipments (live: 2 of 86), and fanning out would repeat allocatedQty — which is
// per (leg, SKU) — on every fanned row, silently inflating any sum of that column.
// So the leg's shipments are AGGREGATED into one date window instead:
//   departure = EARLIEST etdPol (the first box left)
//   arrival   = LATEST etaPod / cargoReceivedDate / ata / eDel (the leg is not
//               fully delivered until the last box lands)
// shipmentCount + shipmentNumbers keep that aggregation visible rather than
// hiding it. ISO date strings compare lexicographically, so min/max need no parsing.
async function getAllLegLines(req, res) {
  const [d, modes, facilities, channels, suppliers, seasons, skus, shipments, shipLegs,
    invoices, cartons, receipts, receiptLines] = await Promise.all([
    loadAll(await scopeOf(req)),
    models.modes.read(),
    models.warehouse_facilities.read(),
    models.allocation_channels.read(),
    models.suppliers.read(),
    models.seasons.read(),
    models.product_skus.read(),
    models.mainline_shipments.read(),
    models.mainline_shipment_legs.read(),
    // Shipped + received per (leg, SKU) — the same derivation the PO leg page
    // reconciles with, via the shared `legActuals`. CI lines are derived from the
    // packing cartons, not stored.
    models.mainline_commercial_invoices.read().catch(() => []),
    models.mainline_packing_cartons.read().catch(() => []),
    models.mainline_item_receipts.read().catch(() => []),
    models.mainline_item_receipt_lines.read().catch(() => []),
  ]);
  // Built over ALL legs, not the vendor-scoped subset: the receipt split walks a
  // PO's legs in shipping-method order and capping it to a partial view would
  // credit the wrong leg. The ROW LIST below is still scoped by loadAll.
  const { shippedByLegSku, recvByLegSku } = legActuals({
    legs: d.legs, legLines: d.legLines, invoices,
    ciLines: deriveAllCiLines(cartons), receipts, receiptLines, modes,
  });
  const modeName = nameMap(modes), facName = nameMap(facilities), chanName = nameMap(channels);
  const supName = nameMap(suppliers), seasonName = nameMap(seasons, 'code');
  const orderByPo = new Map(d.orders.map((o) => [o.poNumber, o]));
  const masterByTrn = new Map(d.masters.map((m) => [m.trnNumber, m]));
  const legById = new Map(d.legs.map((l) => [l.id, l]));
  const skuByCode = new Map(skus.map((s) => [s.skuCode, s]));

  // legId → aggregated shipment dates. Built over ALL shipments deliberately: the
  // ROW LIST (d.legLines) is already vendor-scoped by loadAll, and this is lookup
  // context — pruning it would blank dates rather than hide rows.
  const shipById = new Map((Array.isArray(shipments) ? shipments : []).map((s) => [s.id, s]));
  // ⚠️ ATA is DERIVED from the NetSuite Item Receipts; the `ata` COLUMN is only a
  // manual stopgap and is set on 1 of 9 live shipments (SHP-2). Reading the column
  // here left the export blank for every other consignment even though the receipts
  // say it landed — the same defect the three report endpoints carried until
  // 2026-09-02, and the reason this export showed an ATA only for SHP-2's two POs.
  // `effectiveAta` holds the one precedence rule: attributed receipt date wins, the
  // typed column is the fallback.
  const ataMatch = await loadAtaByShipment({ shipments, shipLegs, legs: d.legs });
  const shipDatesByLeg = new Map();
  for (const j of (Array.isArray(shipLegs) ? shipLegs : [])) {
    const s = shipById.get(j.shipmentId);
    if (!s) continue;
    const agg = shipDatesByLeg.get(j.legId) || { numbers: [], count: 0 };
    agg.count += 1;
    if (s.shipmentNumber) agg.numbers.push(s.shipmentNumber);
    // earliest departure, latest everything downstream
    if (s.etdPol && (!agg.etdPol || s.etdPol < agg.etdPol)) agg.etdPol = s.etdPol;
    for (const k of ['etaPod', 'eDel', 'cargoReceivedDate']) {
      if (s[k] && (!agg[k] || s[k] > agg[k])) agg[k] = s[k];
    }
    const { ata, ataSource } = effectiveAta(ataMatch, s);
    if (ata && (!agg.ata || ata > agg.ata)) { agg.ata = ata; agg.ataSource = ataSource; }
    shipDatesByLeg.set(j.legId, agg);
  }

  const rows = d.legLines.map((ll) => {
    const leg = legById.get(ll.legId) || {};
    const order = orderByPo.get(leg.poNumber) || {};
    const master = masterByTrn.get(order.trnNumber) || {};
    const sku = skuByCode.get(ll.skuCode) || {};
    const ship = shipDatesByLeg.get(ll.legId) || null;
    // Expected ATA = best-known E-DEL + 5, derived never stored — the actual E-DEL
    // once shipped, else the leg's plan. Same basis rule as /reports/mainline.
    const bestEDel = (ship && ship.eDel) || leg.eDel || null;
    return {
      poNumber:           leg.poNumber || null,
      trnNumber:          order.trnNumber || null,
      supplier:            supName.get(master.supplierId) || null,
      season:              seasonName.get(master.seasonId) || null,
      mode:                modeName.get(leg.modeId) || null,
      receivingWarehouse: facName.get(order.facilityId) || null,
      allocationChannel:  chanName.get(order.allocationChannelId) || null,
      // planned (leg / WIP)
      crd:                 leg.crd || null,
      eDel:               leg.eDel || null,
      etdPolPlanned:     leg.etdPol || null,
      // actual (shipment)
      shipmentNumbers:    ship && ship.numbers.length ? ship.numbers.join(', ') : null,
      shipmentCount:      ship ? ship.count : 0,
      etdPol:             (ship && ship.etdPol) || null,
      etaPod:             (ship && ship.etaPod) || null,
      eDelActual:        (ship && ship.eDel) || null,
      cargoReceivedDate: (ship && ship.cargoReceivedDate) || null,
      expectedAta:        addDays(bestEDel, 5),
      ata:                 (ship && ship.ata) || null,
      // which rule produced it: 'netsuite' = attributed Item Receipt, 'manual' =
      // the typed column. Worth a column in a spreadsheet people reconcile against
      // NetSuite — a date and no provenance invites re-checking every row.
      ataSource:          (ship && ship.ataSource) || null,
      legId:              ll.legId,
      skuCode:            ll.skuCode,
      itemName:           sku.itemName || null,
      styleColor:         sku.styleColor || null,
      size:                sku.size || null,
      allocatedQty:       ll.allocatedQty || 0,
      // 0, not null: at this grain a SKU with no CI line or no receipt has shipped
      // / received nothing, and a blank cell in a spreadsheet column people sum
      // would be read as missing data rather than as zero.
      shippedQty:         shippedByLegSku.get(`${ll.legId}|${ll.skuCode}`) || 0,
      receivedQty:        recvByLegSku.get(`${ll.legId}|${ll.skuCode}`) || 0,
      unitPrice:          sku.unitPrice ?? null,
    };
  }).sort((a, b) => (a.poNumber || '').localeCompare(b.poNumber || '') || (a.skuCode || '').localeCompare(b.skuCode || ''));
  res.json(rows);
}

// GET /po/legs/:id — ONE PO leg with its SKU line items (what the vendor must
// produce for this air/sea split). Joins leg → order (facility/channel) → master
// (TRN/supplier/season) and each leg line → product_skus for descriptions.
async function getLeg(req, res) {
  const { id } = req.params;
  const [d, modes, incoterms, facilities, channels, suppliers, seasons, skus] = await Promise.all([
    loadAll(await scopeOf(req)),
    models.modes.read(),
    models.incoterms.read(),
    models.warehouse_facilities.read(),
    models.allocation_channels.read(),
    models.suppliers.read(),
    models.seasons.read(),
    models.product_skus.read(),
  ]);
  const leg = d.legs.find((l) => String(l.id) === String(id));
  if (!leg) notFound(`PO leg not found: ${id}`);

  const modeName = nameMap(modes), incoName = nameMap(incoterms), facName = nameMap(facilities);
  const chanName = nameMap(channels), supName = nameMap(suppliers), seasonName = nameMap(seasons, 'code');
  const order = (d.orders.find((o) => o.poNumber === leg.poNumber)) || {};
  const master = (d.masters.find((m) => m.trnNumber === order.trnNumber)) || {};
  const skuByCode = new Map(skus.map((s) => [s.skuCode, s]));

  const line_items = (d.legLinesByLeg[leg.id] || []).map((ll) => {
    const sku = skuByCode.get(ll.skuCode) || {};
    return {
      skuCode:      ll.skuCode,
      allocatedQty: ll.allocatedQty || 0,
      itemName:     sku.itemName || null,
      styleColor:   sku.styleColor || null,
      colorway:      sku.colorway || null,
      size:          sku.size || null,
      description:   sku.description || null,
      unitPrice:    sku.unitPrice ?? null,
    };
  }).sort((a, b) => (a.skuCode || '').localeCompare(b.skuCode || ''));

  res.json({
    id:                   leg.id,
    poNumber:            leg.poNumber,
    netsuiteId:          order.netsuiteId || null,   // component-PO NS internal id
    trnNumber:           order.trnNumber || null,
    supplierId:          master.supplierId || null,
    supplier:             supName.get(master.supplierId) || null,
    season:               seasonName.get(master.seasonId) || null,
    mainShoulder:        master.mainShoulder || null,
    modeId:              leg.modeId || null,
    mode:                 modeName.get(leg.modeId) || null,
    incoterm:             incoName.get(leg.incotermId) || null,
    destinationFacility: facName.get(order.facilityId) || null,
    facilityId:          order.facilityId || null,
    allocationChannel:   chanName.get(order.allocationChannelId) || null,
    coo:                  order.cooCountry || null,
    approvalStatus:      order.approvalStatus || null,   // NS sign-off state (badge)
    crd:                  leg.crd || null,
    etdPol:              leg.etdPol || null,
    eDel:                leg.eDel || null,
    expectedQty:         line_items.reduce((s, l) => s + l.allocatedQty, 0),
    skuCount:            line_items.length,
    line_items,
  });
}

module.exports = { getAll, getOne, getLegs, getLeg, getAllLegLines };
