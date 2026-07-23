'use strict';

// SMS module migration (phase 2 of SMS_MODULE_PLAN.md) — STANDALONE + ADDITIVE.
//
// SEPARATION (decision 2026-07-02): SMS has its OWN dataset — sms_pos +
// sms_po_lines — and shares NO transactional tables with mainline. This script:
//   • CLEANS UP the earlier shared-hierarchy variant (removes the SMS rows a
//     previous run inserted into po_masters / po_orders / po_order_lines and
//     strips the ship_via/hod fields) — one-time, no-op afterwards;
//   • INSERTS missing reference/master data (seasons, suppliers,
//     warehouse_facilities, statuses, product_skus, courier_status_map) —
//     the ONLY shared tables; existing rows are never modified;
//   • CREATES the SMS dataset files: sms_pos, sms_po_lines, sms_shipments,
//     sms_shipment_pos, sms_tracking_events, sms_item_receipts,
//     sms_item_receipt_lines — from the legacy rows (purchase-orders.json /
//     shipments.json, type='sms').
// It never writes any mainline_* file. Idempotent: re-running is a no-op.
//
// Usage: node backend/scripts/migrate-sms.js [--dry]

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(DATA, 'migrated');
const DRY = process.argv.includes('--dry');

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; } };
const legacy = (f) => readJson(path.join(DATA, f));
const migrated = (f) => readJson(path.join(OUT, f));
const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase().replace(/\s+/g, ' '));

// ---------------------------------------------------------------------------
//  Load
// ---------------------------------------------------------------------------
const legacyPos = legacy('purchase-orders.json').filter((p) => norm(p.type) === 'sms');
const legacyShipments = legacy('shipments.json').filter((s) => norm(s.type) === 'sms');
const suppliers = legacy('suppliers.json');
const couriers = legacy('couriers.json');

const seasons = migrated('seasons.json');
const facilities = migrated('warehouse_facilities.json');
const statuses = migrated('statuses.json');

const added = {};
const bump = (k, n = 1) => (added[k] = (added[k] || 0) + n);

// ---------------------------------------------------------------------------
//  CLEANUP — undo the earlier shared-hierarchy variant (one-time)
// ---------------------------------------------------------------------------
const smsPoNumbers = new Set(legacyPos.map((p) => p.po_number));
const smsTrns = new Set(legacyPos.map((p) => p.trn_number).filter(Boolean));
const cleaned = {};

let masters = migrated('po_masters.json');
let before = masters.length;
masters = masters.filter((m) => !smsTrns.has(m.trn_number));
if (masters.length !== before) cleaned.po_masters = before - masters.length;

let orders = migrated('po_orders.json');
before = orders.length;
orders = orders.filter((o) => !smsPoNumbers.has(o.po_number));
if (orders.length !== before) cleaned.po_orders = before - orders.length;
orders = orders.map((o) => {   // strip the abandoned discriminator fields
  if ('ship_via' in o || 'hod' in o) {
    cleaned.ship_via_fields = (cleaned.ship_via_fields || 0) + 1;
    const { ship_via, hod, ...rest } = o;
    return rest;
  }
  return o;
});

let orderLines = migrated('po_order_lines.json');
before = orderLines.length;
orderLines = orderLines.filter((l) => !smsPoNumbers.has(l.po_number));
if (orderLines.length !== before) cleaned.po_order_lines = before - orderLines.length;

// ---------------------------------------------------------------------------
//  Shared reference/master data (INSERT-only — the ONLY shared tables)
// ---------------------------------------------------------------------------
function seasonId(code) {
  if (!code) return null;
  const existing = seasons.find((s) => norm(s.code) === norm(code));
  if (existing) return existing.id;
  const row = { id: `season_${norm(code).replace(/[^a-z0-9]+/g, '_')}`, code: String(code).trim() };
  seasons.push(row); bump('seasons');
  return row.id;
}

function supplierId(name) {
  if (!name) return null;
  const existing = suppliers.find((s) => norm(s.name) === norm(name));
  if (existing) return existing.id;
  const nextId = String(suppliers.reduce((mx, s) => Math.max(mx, Number(s.id) || 0), 0) + 1);
  suppliers.push({ id: nextId, name: String(name).trim() }); bump('suppliers');
  return nextId;
}

// facility from the legacy SMS warehouse strings (explicit map — the generic
// splitter only strips a trailing "Reserved|First").
function facilityIdOf(warehouseName) {
  const map = {
    'nri us first inventory': 'NRI US',
    'direct shipment : ten tree': 'Direct tentree',
  };
  const facName = map[norm(warehouseName)];
  if (!facName) return null;
  let fac = facilities.find((f) => norm(f.name) === norm(facName));
  if (!fac) {
    fac = { id: 'fac_' + norm(facName).replace(/[^a-z0-9]+/g, '_'), name: facName, country: null, city: null, port_of_discharge: '', address: '' };
    facilities.push(fac); bump('warehouse_facilities');
  }
  return fac.id;
}

// SMS shipment status vocabulary (module='sms')
const SMS_STATUSES = [
  { id: 'sms_label_created',    name: 'Label Created',    color: '#9CA3AF', sort_order: 1 },
  { id: 'sms_picked_up',        name: 'Picked Up',        color: '#3B82F6', sort_order: 2 },
  { id: 'sms_in_transit',       name: 'In Transit',       color: '#8B5CF6', sort_order: 3 },
  { id: 'sms_out_for_delivery', name: 'Out for Delivery', color: '#06B6D4', sort_order: 4 },
  { id: 'sms_delivered',        name: 'Delivered',        color: '#10B981', sort_order: 5 },
  { id: 'sms_exception',        name: 'Exception',        color: '#EF4444', sort_order: 6 },
];
SMS_STATUSES.forEach((s) => {
  if (!statuses.some((x) => x.id === s.id)) {
    statuses.push({ ...s, module: 'sms', category: 'shipment' }); bump('statuses');
  }
});

// carrier scan code → portal status (data, not code)
const courierIdByName = new Map(couriers.map((c) => [norm(c.name), c.id]));
const CODE_SEED = [
  ['FedEx', 'OC', 'sms_label_created'], ['FedEx', 'PU', 'sms_picked_up'],
  ['FedEx', 'IT', 'sms_in_transit'],    ['FedEx', 'DP', 'sms_in_transit'],
  ['FedEx', 'AR', 'sms_in_transit'],    ['FedEx', 'OD', 'sms_out_for_delivery'],
  ['FedEx', 'DL', 'sms_delivered'],     ['FedEx', 'DE', 'sms_exception'],
  ['FedEx', 'SE', 'sms_exception'],     ['FedEx', 'CA', 'sms_exception'],
  ['FedEx', 'RS', 'sms_exception'],     ['FedEx', 'IN', 'sms_label_created'],
  ['FedEx', 'HL', 'sms_delivered'],     ['FedEx', 'RT', 'sms_exception'],
  ['FedEx', 'HP', 'sms_delivered'],     ['FedEx', 'HA', 'sms_in_transit'],
  ['FedEx', 'AO', 'sms_in_transit'],    ['FedEx', 'RR', 'sms_in_transit'],
  ['DHL', 'pre-transit', 'sms_label_created'], ['DHL', 'transit', 'sms_in_transit'],
  ['DHL', 'delivered', 'sms_delivered'],       ['DHL', 'failure', 'sms_exception'],
];
const courierStatusMap = migrated('courier_status_map.json');
CODE_SEED.forEach(([courier, code, statusId]) => {
  const courier_id = courierIdByName.get(norm(courier));
  if (!courier_id) return;
  if (courierStatusMap.some((r) => r.courier_id === courier_id && r.courier_code === code)) return;
  courierStatusMap.push({ id: `csm_${courier_id}_${code.replace(/[^a-zA-Z0-9]+/g, '_')}`, courier_id, courier_code: code, status_id: statusId });
  bump('courier_status_map');
});

// shared SKU catalogue (insert-only)
const skus = migrated('product_skus.json');
const styleColorOf = (sku) => String(sku).split('-').slice(0, -1).join('-') || null;
const sizeOf = (sku) => { const parts = String(sku).split('-'); return parts.length > 2 ? parts[parts.length - 1] : null; };

// ---------------------------------------------------------------------------
//  SMS dataset: sms_pos + sms_po_lines (OWN tables — nothing shared)
// ---------------------------------------------------------------------------
const smsPos = migrated('sms_pos.json');
const smsPoLines = migrated('sms_po_lines.json');
let lineSeq = smsPoLines.reduce((mx, l) => Math.max(mx, +String(l.id).replace(/\D/g, '') || 0), 0);

for (const po of legacyPos) {
  if (smsPos.some((p) => p.po_number === po.po_number)) continue;
  smsPos.push({
    po_number:       po.po_number,                    // tranid
    trn_number:      po.trn_number || null,           // custbody_tentree_po
    supplier_id:     supplierId(po.supplier),         // entity
    season_id:       seasonId(po.season),             // custbody7
    hod:             po.crd || null,                  // custbody8 fills at NS sync
    ship_method:     po.mode || null,                 // custbody16 fills at NS sync
    approval_status: null,                            // approvalstatus fills at NS sync
    facility_id:     facilityIdOf(po.receiving_warehouse),  // location → facility
    allocation_channel_id: null,                      // legacy strings lack a clean channel; NS sync sets it
    netsuite_id:     po.netsuite_id || null,
  });
  bump('sms_pos');

  for (const li of po.line_items || []) {
    if (!li.sku_code) continue;
    if (!smsPoLines.some((l) => l.po_number === po.po_number && l.sku_code === li.sku_code)) {
      smsPoLines.push({
        id: `spol_${++lineSeq}`,
        po_number: po.po_number,
        sku_code: li.sku_code,
        ordered_qty: Number(li.expected_qty) || 0,
        unit_price: li.unit_price ?? null,
      });
      bump('sms_po_lines');
    }
    if (!skus.some((s) => s.sku_code === li.sku_code)) {
      skus.push({
        sku_code: li.sku_code,
        style_color: styleColorOf(li.sku_code),
        item_name: li.description && li.description !== li.sku_code ? li.description : null,
        description: li.description || null,
        colorway: null,
        size: li.size || sizeOf(li.sku_code),
        hts_code: null,
        unit_price: li.unit_price ?? null,
      });
      bump('product_skus');
    }
  }
}

// ---------------------------------------------------------------------------
//  Legacy SMS shipments → sms_shipments + sms_shipment_pos
// ---------------------------------------------------------------------------
const smsShipments = migrated('sms_shipments.json');
const smsShipmentPos = migrated('sms_shipment_pos.json');

const LEGACY_STATUS = new Map([
  ['ready to ship', 'sms_label_created'], ['in transit', 'sms_in_transit'],
  ['delivered', 'sms_delivered'], ['received', 'sms_delivered'], ['cancelled', 'sms_exception'],
]);

for (const s of legacyShipments) {
  if (smsShipments.some((x) => x.legacy_id === s.id)) continue;
  const id = String(smsShipments.reduce((mx, x) => Math.max(mx, Number(x.id) || 0), 0) + 1);
  smsShipments.push({
    id,
    legacy_id: s.id,                        // provenance; drop at Postgres migration
    courier_id: courierIdByName.get(norm(s.courier)) || null,
    tracking_number: s.tracking_number || null,
    ship_date: s.etd || s.cargo_ready_date || null,
    facility_id: facilityIdOf(s.receiving_warehouse || s.destination_warehouse),
    manual_status_id: LEGACY_STATUS.get(norm(s.status)) || 'sms_label_created',
    created_by: null,
    created_at: s.submitted_at || null,
  });
  bump('sms_shipments');

  const lot = Number(s.lot_number) || 1;
  if (!smsShipmentPos.some((j) => j.po_number === s.po_number && j.lot_number === lot)) {
    smsShipmentPos.push({
      id: `spo_${id}_${s.po_number}`,
      shipment_id: id,
      po_number: s.po_number,
      lot_number: lot,
      units: Number(s.expected_quantity) || Number(s.expected_qty) || 0,
      cartons: Number(s.number_of_cartons) || null,
    });
    bump('sms_shipment_pos');
  }
}

// ---------------------------------------------------------------------------
//  Write
// ---------------------------------------------------------------------------
const writes = {
  // shared hierarchy — cleanup only (SMS rows removed, fields stripped)
  [path.join(OUT, 'po_masters.json')]: masters,
  [path.join(OUT, 'po_orders.json')]: orders,
  [path.join(OUT, 'po_order_lines.json')]: orderLines,
  // shared reference/master data — insert-only
  [path.join(OUT, 'seasons.json')]: seasons,
  [path.join(DATA, 'suppliers.json')]: suppliers,
  [path.join(OUT, 'warehouse_facilities.json')]: facilities,
  [path.join(OUT, 'statuses.json')]: statuses,
  [path.join(OUT, 'product_skus.json')]: skus,
  [path.join(OUT, 'courier_status_map.json')]: courierStatusMap,
  // the SMS dataset — its own tables
  [path.join(OUT, 'sms_pos.json')]: smsPos,
  [path.join(OUT, 'sms_po_lines.json')]: smsPoLines,
  [path.join(OUT, 'sms_shipments.json')]: smsShipments,
  [path.join(OUT, 'sms_shipment_pos.json')]: smsShipmentPos,
  [path.join(OUT, 'sms_tracking_events.json')]: migrated('sms_tracking_events.json'),
  [path.join(OUT, 'sms_item_receipts.json')]: migrated('sms_item_receipts.json'),
  [path.join(OUT, 'sms_item_receipt_lines.json')]: migrated('sms_item_receipt_lines.json'),
};
if (!DRY) for (const [p, rows] of Object.entries(writes)) fs.writeFileSync(p, JSON.stringify(rows, null, 2));

console.log(`\n=== SMS migration (separate dataset) ${DRY ? '(dry run)' : ''} ===`);
console.log('Legacy input:      ', legacyPos.length, 'SMS POs,', legacyShipments.length, 'SMS shipments');
console.log('Shared-tables cleanup:', Object.keys(cleaned).length ? cleaned : '(nothing to clean)');
console.log('Rows added:        ', Object.keys(added).length ? added : '(none — already migrated)');
console.log('Never touched: mainline_* files.');
