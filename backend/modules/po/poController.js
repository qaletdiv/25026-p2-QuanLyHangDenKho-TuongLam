'use strict';

// Shared PO hierarchy — READ path (Phase 1).
//   po_masters (TRN) → po_orders (po_number) → po_order_lines
//                                            → mainline_po_legs → leg_lines
// Lifecycle state and totals are DERIVED live (never stored), per the schema rule.

const PoMasterModel = require('./PoMasterModel');
const PoOrderModel  = require('./PoOrderModel');
const LegReadModel  = require('./LegReadModel');
const BaseModel     = require('../../models/BaseModel');

const notFound = (msg) => { const e = new Error(msg); e.statusCode = 404; throw e; };

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

async function loadAll() {
  const [masters, orders, orderLines, legs, legLines] = await Promise.all([
    PoMasterModel.read(),
    PoOrderModel.readOrders(),
    PoOrderModel.readOrderLines(),
    LegReadModel.readLegs(),
    LegReadModel.readLegLines(),
  ]);
  return {
    masters, orders, orderLines, legs, legLines,
    ordersByTrn:   groupBy(orders, 'trn_number'),
    linesByPo:     groupBy(orderLines, 'po_number'),
    legsByPo:      groupBy(legs, 'po_number'),
    legLinesByLeg: groupBy(legLines, 'leg_id'),
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
    loadAll(),
    new BaseModel('modes.json').read(),
    new BaseModel('incoterms.json').read(),
    new BaseModel('migrated/warehouse_facilities.json').read(),
    new BaseModel('migrated/allocation_channels.json').read(),
    new BaseModel('suppliers.json').read(),
    new BaseModel('migrated/seasons.json').read(),
  ]);
  const modeName = nameMap(modes), incoName = nameMap(incoterms), facName = nameMap(facilities);
  const chanName = nameMap(channels);
  const supName = nameMap(suppliers), seasonName = nameMap(seasons, 'code');
  const orderByPo = new Map(d.orders.map((o) => [o.po_number, o]));
  const masterByTrn = new Map(d.masters.map((m) => [m.trn_number, m]));

  const legRows = d.legs.map((leg) => {
    const order = orderByPo.get(leg.po_number) || {};
    const master = masterByTrn.get(order.trn_number) || {};
    const expected_qty = (d.legLinesByLeg[leg.id] || []).reduce((s, l) => s + (l.allocated_qty || 0), 0);
    return {
      id:                  leg.id,
      po_number:           leg.po_number,
      trn_number:          order.trn_number || null,
      supplier:            supName.get(master.supplier_id) || null,
      season:              seasonName.get(master.season_id) || null,
      main_shoulder:       master.main_shoulder || null,
      mode:                modeName.get(leg.mode_id) || null,
      incoterm:            incoName.get(leg.incoterm_id) || null,
      receiving_warehouse: facName.get(order.facility_id) || null,   // physical facility (NRI US, …)
      allocation_channel:  chanName.get(order.allocation_channel_id) || null,  // Reserved/First
      coo:                 order.coo_country || null,
      crd:                 leg.crd || null,
      etd_pol:             leg.etd_pol || null,
      e_del:               leg.e_del || null,
      expected_qty,
      sku_count:           (d.legLinesByLeg[leg.id] || []).length,
      lifecycle:           'split',
      bookable:            true,   // a leg is always bookable (it exists = PO is split)
    };
  });

  // Forecast rows: orders with no legs yet (synced from NetSuite / WIP-bootstrapped
  // but not split into air/sea). One row per such order.
  const splitPoNumbers = new Set(d.legs.map((l) => l.po_number));
  const forecastRows = d.orders.filter((o) => !splitPoNumbers.has(o.po_number)).map((order) => {
    const master = masterByTrn.get(order.trn_number) || {};
    const lines = d.linesByPo[order.po_number] || [];
    return {
      id:                  `forecast_${order.po_number}`,   // synthetic key (no real leg)
      po_number:           order.po_number,
      trn_number:          order.trn_number || null,
      supplier:            supName.get(master.supplier_id) || null,
      season:              seasonName.get(master.season_id) || null,
      main_shoulder:       master.main_shoulder || null,
      mode:                null,                              // no split yet
      incoterm:            null,
      receiving_warehouse: facName.get(order.facility_id) || null,
      allocation_channel:  chanName.get(order.allocation_channel_id) || null,
      coo:                 order.coo_country || null,
      crd:                 null,
      etd_pol:             null,
      e_del:               null,
      expected_qty:        lines.reduce((s, l) => s + (l.ordered_qty || 0), 0),
      sku_count:           lines.length,
      lifecycle:           'forecast',
      bookable:            false,   // can't book until split into legs
    };
  });

  const rows = [...legRows, ...forecastRows].sort(
    (a, b) => (a.po_number || '').localeCompare(b.po_number || '') || (a.mode || '~').localeCompare(b.mode || '~'),
  );
  res.json(rows);
}

// GET /po — list every master with derived rollups + lifecycle state.
async function getAll(req, res) {
  const d = await loadAll();
  const result = d.masters.map((m) => {
    const myOrders = d.ordersByTrn[m.trn_number] || [];
    let legCount = 0, ordered = 0, splitOrders = 0;
    myOrders.forEach((o) => {
      const legs = d.legsByPo[o.po_number] || [];
      legCount += legs.length;
      if (legs.length) splitOrders += 1;
      (d.linesByPo[o.po_number] || []).forEach((l) => { ordered += l.ordered_qty || 0; });
    });
    const lifecycle_state = lifecycleOf(legCount, splitOrders, myOrders.length);
    return {
      ...m,
      order_count:       myOrders.length,
      leg_count:         legCount,
      total_ordered_qty: ordered,
      lifecycle_state,
      bookable:          legCount > 0,   // leg-only booking rule
    };
  });
  res.json(result);
}

// GET /po/:trn — full master detail: orders → order_lines + legs → leg_lines.
async function getOne(req, res) {
  const { trn } = req.params;
  const [d, facilities, channels, modes, suppliers, seasons] = await Promise.all([
    loadAll(),
    new BaseModel('migrated/warehouse_facilities.json').read(),
    new BaseModel('migrated/allocation_channels.json').read(),
    new BaseModel('modes.json').read(),
    new BaseModel('suppliers.json').read(),
    new BaseModel('migrated/seasons.json').read(),
  ]);
  const facName = nameMap(facilities), chanName = nameMap(channels), modeName = nameMap(modes);
  const supName = nameMap(suppliers), seasonName = nameMap(seasons, 'code');
  const master = d.masters.find((m) => m.trn_number === trn);
  if (!master) notFound(`PO master not found: ${trn}`);

  const myOrders = d.ordersByTrn[trn] || [];
  let totalLegs = 0, splitOrders = 0, totalOrdered = 0;

  const orders = myOrders.map((o) => {
    const legs = (d.legsByPo[o.po_number] || []).map((leg) => ({
      ...leg,
      mode: modeName.get(leg.mode_id) || null,
      leg_lines: d.legLinesByLeg[leg.id] || [],
      expected_qty: (d.legLinesByLeg[leg.id] || []).reduce((s, l) => s + (l.allocated_qty || 0), 0),
    }));
    totalLegs += legs.length;
    if (legs.length) splitOrders += 1;
    const order_lines = d.linesByPo[o.po_number] || [];
    order_lines.forEach((l) => { totalOrdered += l.ordered_qty || 0; });
    return {
      ...o,
      destination_facility: facName.get(o.facility_id) || null,   // physical destination name
      allocation_channel:   chanName.get(o.allocation_channel_id) || null,  // Reserved/First
      order_lines,
      legs,
      lifecycle_state: legs.length ? 'split' : 'forecast',
    };
  });

  res.json({
    ...master,
    supplier:          supName.get(master.supplier_id) || null,   // resolved name (display)
    season:            seasonName.get(master.season_id) || null,
    // same rollups as getAll() so detail and list share one shape (PoMasterSummary)
    order_count:       myOrders.length,
    leg_count:         totalLegs,
    total_ordered_qty: totalOrdered,
    lifecycle_state:   lifecycleOf(totalLegs, splitOrders, myOrders.length),
    bookable:          totalLegs > 0,
    orders,
  });
}

// GET /po/leg-lines — EVERY SKU allocation across all legs, enriched with PO/leg
// context + SKU descriptions. Feeds the "item lines" download on the PO list.
async function getAllLegLines(req, res) {
  const [d, modes, facilities, channels, suppliers, seasons, skus] = await Promise.all([
    loadAll(),
    new BaseModel('modes.json').read(),
    new BaseModel('migrated/warehouse_facilities.json').read(),
    new BaseModel('migrated/allocation_channels.json').read(),
    new BaseModel('suppliers.json').read(),
    new BaseModel('migrated/seasons.json').read(),
    new BaseModel('migrated/product_skus.json').read(),
  ]);
  const modeName = nameMap(modes), facName = nameMap(facilities), chanName = nameMap(channels);
  const supName = nameMap(suppliers), seasonName = nameMap(seasons, 'code');
  const orderByPo = new Map(d.orders.map((o) => [o.po_number, o]));
  const masterByTrn = new Map(d.masters.map((m) => [m.trn_number, m]));
  const legById = new Map(d.legs.map((l) => [l.id, l]));
  const skuByCode = new Map(skus.map((s) => [s.sku_code, s]));

  const rows = d.legLines.map((ll) => {
    const leg = legById.get(ll.leg_id) || {};
    const order = orderByPo.get(leg.po_number) || {};
    const master = masterByTrn.get(order.trn_number) || {};
    const sku = skuByCode.get(ll.sku_code) || {};
    return {
      po_number:           leg.po_number || null,
      trn_number:          order.trn_number || null,
      supplier:            supName.get(master.supplier_id) || null,
      season:              seasonName.get(master.season_id) || null,
      mode:                modeName.get(leg.mode_id) || null,
      receiving_warehouse: facName.get(order.facility_id) || null,
      allocation_channel:  chanName.get(order.allocation_channel_id) || null,
      crd:                 leg.crd || null,
      e_del:               leg.e_del || null,
      leg_id:              ll.leg_id,
      sku_code:            ll.sku_code,
      item_name:           sku.item_name || null,
      style_color:         sku.style_color || null,
      size:                sku.size || null,
      allocated_qty:       ll.allocated_qty || 0,
      unit_price:          sku.unit_price ?? null,
    };
  }).sort((a, b) => (a.po_number || '').localeCompare(b.po_number || '') || (a.sku_code || '').localeCompare(b.sku_code || ''));
  res.json(rows);
}

// GET /po/legs/:id — ONE PO leg with its SKU line items (what the vendor must
// produce for this air/sea split). Joins leg → order (facility/channel) → master
// (TRN/supplier/season) and each leg line → product_skus for descriptions.
async function getLeg(req, res) {
  const { id } = req.params;
  const [d, modes, incoterms, facilities, channels, suppliers, seasons, skus] = await Promise.all([
    loadAll(),
    new BaseModel('modes.json').read(),
    new BaseModel('incoterms.json').read(),
    new BaseModel('migrated/warehouse_facilities.json').read(),
    new BaseModel('migrated/allocation_channels.json').read(),
    new BaseModel('suppliers.json').read(),
    new BaseModel('migrated/seasons.json').read(),
    new BaseModel('migrated/product_skus.json').read(),
  ]);
  const leg = d.legs.find((l) => String(l.id) === String(id));
  if (!leg) notFound(`PO leg not found: ${id}`);

  const modeName = nameMap(modes), incoName = nameMap(incoterms), facName = nameMap(facilities);
  const chanName = nameMap(channels), supName = nameMap(suppliers), seasonName = nameMap(seasons, 'code');
  const order = (d.orders.find((o) => o.po_number === leg.po_number)) || {};
  const master = (d.masters.find((m) => m.trn_number === order.trn_number)) || {};
  const skuByCode = new Map(skus.map((s) => [s.sku_code, s]));

  const line_items = (d.legLinesByLeg[leg.id] || []).map((ll) => {
    const sku = skuByCode.get(ll.sku_code) || {};
    return {
      sku_code:      ll.sku_code,
      allocated_qty: ll.allocated_qty || 0,
      item_name:     sku.item_name || null,
      style_color:   sku.style_color || null,
      colorway:      sku.colorway || null,
      size:          sku.size || null,
      description:   sku.description || null,
      unit_price:    sku.unit_price ?? null,
    };
  }).sort((a, b) => (a.sku_code || '').localeCompare(b.sku_code || ''));

  res.json({
    id:                   leg.id,
    po_number:            leg.po_number,
    trn_number:           order.trn_number || null,
    supplier_id:          master.supplier_id || null,
    supplier:             supName.get(master.supplier_id) || null,
    season:               seasonName.get(master.season_id) || null,
    main_shoulder:        master.main_shoulder || null,
    mode_id:              leg.mode_id || null,
    mode:                 modeName.get(leg.mode_id) || null,
    incoterm:             incoName.get(leg.incoterm_id) || null,
    destination_facility: facName.get(order.facility_id) || null,
    facility_id:          order.facility_id || null,
    allocation_channel:   chanName.get(order.allocation_channel_id) || null,
    coo:                  order.coo_country || null,
    crd:                  leg.crd || null,
    etd_pol:              leg.etd_pol || null,
    e_del:                leg.e_del || null,
    expected_qty:         line_items.reduce((s, l) => s + l.allocated_qty, 0),
    sku_count:            line_items.length,
    line_items,
  });
}

module.exports = { getAll, getOne, getLegs, getLeg, getAllLegLines };
