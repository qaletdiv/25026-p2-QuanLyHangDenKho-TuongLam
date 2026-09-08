'use strict';

// Shared PO hierarchy — READ path (Phase 1).
//   po_masters (TRN) → po_orders (po_number) → po_order_lines
//                                            → mainline_po_legs → leg_lines
// Lifecycle state and totals are DERIVED live (never stored), per the schema rule.

const PoMasterModel = require('./PoMasterModel');
const PoOrderModel  = require('./PoOrderModel');
const LegReadModel  = require('./LegReadModel');
const BaseModel     = require('../../models/BaseModel');
const { resolveVendorSupplierId } = require('../../utils/vendorScope');
// pure date helper only — reused so the "expected ATA = E-DEL + 5" rule has ONE
// definition shared with /reports/mainline rather than a second copy here.
const { addDays } = require('../mainline/reports/transitTimeService');

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
// supplier_id lives only on po_masters, and every read here already joins through
// it, so filtering the five source tables once here scopes every handler at once:
// the list endpoints return only the vendor's rows, and getOne/getLeg fall through
// to their existing notFound() — a 404 rather than a 403, which is deliberate. A 403
// would confirm that a TRN or leg id exists, letting a vendor enumerate other
// suppliers' PO numbers; 404 is indistinguishable from "no such record".
//
// Pass null (staff) to disable scoping. Masters with a null supplier_id are excluded
// for vendors, which is correct — an unattributed master is not theirs.
async function loadAll(vendorSupplierId) {
  const [allMasters, allOrders, allOrderLines, allLegs, allLegLines] = await Promise.all([
    PoMasterModel.read(),
    PoOrderModel.readOrders(),
    PoOrderModel.readOrderLines(),
    LegReadModel.readLegs(),
    LegReadModel.readLegLines(),
  ]);

  let masters = allMasters, orders = allOrders, orderLines = allOrderLines,
      legs = allLegs, legLines = allLegLines;

  if (vendorSupplierId != null) {
    const mine = String(vendorSupplierId);
    masters = allMasters.filter((m) => m.supplier_id != null && String(m.supplier_id) === mine);
    const trns = new Set(masters.map((m) => m.trn_number));
    orders = allOrders.filter((o) => trns.has(o.trn_number));
    const poNumbers = new Set(orders.map((o) => o.po_number));
    orderLines = allOrderLines.filter((l) => poNumbers.has(l.po_number));
    legs = allLegs.filter((l) => poNumbers.has(l.po_number));
    const legIds = new Set(legs.map((l) => l.id));
    legLines = allLegLines.filter((ll) => legIds.has(ll.leg_id));
  }

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
    loadAll(await scopeOf(req)),
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
  const d = await loadAll(await scopeOf(req));
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
    loadAll(await scopeOf(req)),
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
//
// Dates come from TWO grains and are kept in SEPARATE columns, never merged:
//   PLANNED — crd / e_del / etd_pol_planned, from the WIP-owned leg.
//   ACTUAL  — etd_pol / eta_pod / e_del_actual / cargo_received_date / ata, from
//             the shipment(s) the leg was loaded onto (mainline_shipment_legs).
// Overwriting the planned value with the actual would erase the very slip the
// report exists to show, so both are emitted side by side.
//
// GRAIN IS PRESERVED: one row per (leg, SKU), as before. A leg may span several
// shipments (live: 2 of 86), and fanning out would repeat allocated_qty — which is
// per (leg, SKU) — on every fanned row, silently inflating any sum of that column.
// So the leg's shipments are AGGREGATED into one date window instead:
//   departure = EARLIEST etd_pol (the first box left)
//   arrival   = LATEST eta_pod / cargo_received_date / ata / e_del (the leg is not
//               fully delivered until the last box lands)
// shipment_count + shipment_numbers keep that aggregation visible rather than
// hiding it. ISO date strings compare lexicographically, so min/max need no parsing.
async function getAllLegLines(req, res) {
  const [d, modes, facilities, channels, suppliers, seasons, skus, shipments, shipLegs] = await Promise.all([
    loadAll(await scopeOf(req)),
    new BaseModel('modes.json').read(),
    new BaseModel('migrated/warehouse_facilities.json').read(),
    new BaseModel('migrated/allocation_channels.json').read(),
    new BaseModel('suppliers.json').read(),
    new BaseModel('migrated/seasons.json').read(),
    new BaseModel('migrated/product_skus.json').read(),
    new BaseModel('migrated/mainline_shipments.json').read(),
    new BaseModel('migrated/mainline_shipment_legs.json').read(),
  ]);
  const modeName = nameMap(modes), facName = nameMap(facilities), chanName = nameMap(channels);
  const supName = nameMap(suppliers), seasonName = nameMap(seasons, 'code');
  const orderByPo = new Map(d.orders.map((o) => [o.po_number, o]));
  const masterByTrn = new Map(d.masters.map((m) => [m.trn_number, m]));
  const legById = new Map(d.legs.map((l) => [l.id, l]));
  const skuByCode = new Map(skus.map((s) => [s.sku_code, s]));

  // leg_id → aggregated shipment dates. Built over ALL shipments deliberately: the
  // ROW LIST (d.legLines) is already vendor-scoped by loadAll, and this is lookup
  // context — pruning it would blank dates rather than hide rows.
  const shipById = new Map((Array.isArray(shipments) ? shipments : []).map((s) => [s.id, s]));
  const shipDatesByLeg = new Map();
  for (const j of (Array.isArray(shipLegs) ? shipLegs : [])) {
    const s = shipById.get(j.shipment_id);
    if (!s) continue;
    const agg = shipDatesByLeg.get(j.leg_id) || { numbers: [], count: 0 };
    agg.count += 1;
    if (s.shipment_number) agg.numbers.push(s.shipment_number);
    // earliest departure, latest everything downstream
    if (s.etd_pol && (!agg.etd_pol || s.etd_pol < agg.etd_pol)) agg.etd_pol = s.etd_pol;
    for (const k of ['eta_pod', 'e_del', 'cargo_received_date', 'ata']) {
      if (s[k] && (!agg[k] || s[k] > agg[k])) agg[k] = s[k];
    }
    shipDatesByLeg.set(j.leg_id, agg);
  }

  const rows = d.legLines.map((ll) => {
    const leg = legById.get(ll.leg_id) || {};
    const order = orderByPo.get(leg.po_number) || {};
    const master = masterByTrn.get(order.trn_number) || {};
    const sku = skuByCode.get(ll.sku_code) || {};
    const ship = shipDatesByLeg.get(ll.leg_id) || null;
    // Expected ATA = best-known E-DEL + 5, derived never stored — the actual E-DEL
    // once shipped, else the leg's plan. Same basis rule as /reports/mainline.
    const bestEDel = (ship && ship.e_del) || leg.e_del || null;
    return {
      po_number:           leg.po_number || null,
      trn_number:          order.trn_number || null,
      supplier:            supName.get(master.supplier_id) || null,
      season:              seasonName.get(master.season_id) || null,
      mode:                modeName.get(leg.mode_id) || null,
      receiving_warehouse: facName.get(order.facility_id) || null,
      allocation_channel:  chanName.get(order.allocation_channel_id) || null,
      // planned (leg / WIP)
      crd:                 leg.crd || null,
      e_del:               leg.e_del || null,
      etd_pol_planned:     leg.etd_pol || null,
      // actual (shipment)
      shipment_numbers:    ship && ship.numbers.length ? ship.numbers.join(', ') : null,
      shipment_count:      ship ? ship.count : 0,
      etd_pol:             (ship && ship.etd_pol) || null,
      eta_pod:             (ship && ship.eta_pod) || null,
      e_del_actual:        (ship && ship.e_del) || null,
      cargo_received_date: (ship && ship.cargo_received_date) || null,
      expected_ata:        addDays(bestEDel, 5),
      ata:                 (ship && ship.ata) || null,
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
    loadAll(await scopeOf(req)),
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
    netsuite_id:          order.netsuite_id || null,   // component-PO NS internal id
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
