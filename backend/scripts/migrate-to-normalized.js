'use strict';

/**
 * migrate-to-normalized.js
 * -------------------------------------------------------------------------
 * Splits the flat JSON store into the normalized, MAINLINE-ONLY collections
 * defined in backend/database.dbml / backend/SCHEMA_REDESIGN.md.
 *
 *   po_masters (TRN) → po_orders (po_number) → mainline_po_legs (leg id)
 *   + po_order_lines / mainline_po_leg_lines / product_skus
 *   + mainline_bookings / _booking_po_legs / _commercial_invoices /
 *     _ci_line_items / _packing_cartons / _shipments / _asns
 *
 * SMS rows (type === 'sms') are SKIPPED — SMS is a separate later pass.
 *
 * Reads  backend/data/*.json
 * Writes backend/data/migrated/*.json   (new dir; never mutates source)
 * Prints a verification report: grain counts, R2 reconciliation, unresolved FKs.
 *
 * Usage:  node scripts/migrate-to-normalized.js [--dry]
 *   --dry  report only, do not write files.
 * -------------------------------------------------------------------------
 */

const fs   = require('fs');
const path = require('path');
const { deriveFromWarehouses, splitWarehouseName, channelIdByName } = require('../modules/po/warehouseFacility');

const DATA = path.join(__dirname, '..', 'data');
const OUT  = path.join(DATA, 'migrated');
const DRY  = process.argv.includes('--dry');

const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return []; } };
const isMainline = (r) => (r && (r.type || 'mainline').toLowerCase() !== 'sms');
const num  = (v) => (v === '' || v === null || v === undefined ? null : (Number.isFinite(+v) ? +v : null));
const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase().replace(/\s+/g, ' '));

const warnings = [];
const warn = (msg) => warnings.push(msg);

// ----- load source -----------------------------------------------------------
const pos              = read('purchase-orders.json');
const bookings         = read('bookings.json');
const historyBookings  = read('history-bookings.json');
const shipments        = read('shipments.json');
const asns             = read('asns.json');
const suppliers        = read('suppliers.json');
const warehouses       = read('warehouses.json');
const modes            = read('modes.json');
const incoterms        = read('incoterms.json');
const roles            = read('roles.json');

// Categorized status master (module + category + sort_order) — replaces the flat
// legacy statuses.json for the mainline module. Booking and shipment are two
// distinct categories; "In Transit" is one stored progress state (UI derives
// "On Air"/"On the Water" from mode); the timeliness axis (On Time/At Risk/Late)
// is derived in the reports module, never stored here.
const statuses = [
  { id: 'bk_no_booking', name: 'No Booking',       module: 'mainline', category: 'booking',  color: '#9CA3AF', sort_order: 1 },
  { id: 'bk_pending',    name: 'Booking Pending',  module: 'mainline', category: 'booking',  color: '#F59E0B', sort_order: 2 },
  { id: 'bk_approved',   name: 'Booking Approved', module: 'mainline', category: 'booking',  color: '#3B82F6', sort_order: 3 },
  { id: 'bk_rejected',   name: 'Rejected',         module: 'mainline', category: 'booking',  color: '#DC2626', sort_order: 4 },
  { id: 'sh_ready',      name: 'Ready to Ship',    module: 'mainline', category: 'shipment', color: '#3B82F6', sort_order: 1 },
  { id: 'sh_in_transit', name: 'In Transit',       module: 'mainline', category: 'shipment', color: '#8B5CF6', sort_order: 2 },
  { id: 'sh_at_port',    name: 'At Port',          module: 'mainline', category: 'shipment', color: '#06B6D4', sort_order: 3 },
  { id: 'sh_delivered',  name: 'Delivered',        module: 'mainline', category: 'shipment', color: '#10B981', sort_order: 4 },
  { id: 'sh_received',   name: 'Received',         module: 'mainline', category: 'shipment', color: '#059669', sort_order: 5 },
  { id: 'cancelled',     name: 'Cancelled',        module: 'mainline', category: 'both',     color: '#EF4444', sort_order: 9 },
];

// ----- master-data lookup maps (name → id) -----------------------------------
const lookup = (rows, keyField = 'name') => {
  const m = new Map();
  (Array.isArray(rows) ? rows : []).forEach((r) => { if (r && r[keyField] != null) m.set(norm(r[keyField]), r.id); });
  return m;
};
const supplierId = lookup(suppliers);
const warehouseId = lookup(warehouses);
const modeId = lookup(modes);
const incotermId = lookup(incoterms);
// Two category-scoped name→id maps (booking vs shipment). "Cancelled" (category
// 'both') is reachable from either.
const bookingStatusId  = lookup(statuses.filter((s) => s.category === 'booking'  || s.category === 'both'));
const shipmentStatusId = lookup(statuses.filter((s) => s.category === 'shipment' || s.category === 'both'));
// Legacy flat shipment-status names → new shipment vocab. An approved booking's
// shipment now starts at "Ready to Ship"; legacy "In-Transit" loses the hyphen.
const SHIPMENT_STATUS_REMAP = { 'No Booking': 'Ready to Ship', 'Booking Approved': 'Ready to Ship', 'In-Transit': 'In Transit' };
const resolveShipmentStatus = (val) => {
  const mapped = SHIPMENT_STATUS_REMAP[val] ?? val;
  return shipmentStatusId.get(norm(mapped)) ?? shipmentStatusId.get(norm('Ready to Ship'));
};

const resolve = (map, val, kind, ctx) => {
  if (val == null || val === '') return null;
  const id = map.get(norm(val));
  if (id == null) warn(`unresolved ${kind} "${val}"${ctx ? ' @ ' + ctx : ''}`);
  return id ?? null;
};

// ----- warehouse → (facility, allocation channel) ----------------------------
// Decompose the conflated "NRI US Reserved" warehouse into a physical facility
// (what the forwarder ships to) + an internal allocation channel. See
// backend/modules/po/warehouseFacility.js.
const { facilities: warehouse_facilities, channels: allocation_channels } = deriveFromWarehouses(warehouses);

// Container types (Sea) + a starter ports list. Small, stable lookups (no source
// feed yet) — seeded here so the shipment FKs resolve and the forwarder can pick.
const container_types = [
  { id: 'ct_fcl', name: 'FCL' },
  { id: 'ct_lcl', name: 'LCL' },
];
const containerTypeFromMode = (modeName) => {
  const n = (modeName || '').toLowerCase();
  if (n.includes('fcl')) return 'ct_fcl';
  if (n.includes('lcl')) return 'ct_lcl';
  return null;                                     // Air / Courier → no container type
};
const ports = [
  { id: 'port_cnsha', code: 'CNSHA', name: 'Shanghai',     country: 'China' },
  { id: 'port_inccu', code: 'INCCU', name: 'Kolkata',      country: 'India' },
  { id: 'port_innsa', code: 'INNSA', name: 'Nhava Sheva',  country: 'India' },
  { id: 'port_cntao', code: 'CNTAO', name: 'Qingdao',      country: 'China' },
  { id: 'port_vnsgn', code: 'VNSGN', name: 'Ho Chi Minh',  country: 'Vietnam' },
  { id: 'port_cnszx', code: 'CNSZX', name: 'Shenzhen',     country: 'China' },
  { id: 'port_idjkt', code: 'IDJKT', name: 'Jakarta',      country: 'Indonesia' },
  { id: 'port_vndad', code: 'VNDAD', name: 'Da Nang',      country: 'Vietnam' },
];
const facilityIdByName = new Map(warehouse_facilities.map((f) => [norm(f.name), f.id]));
const facilityChannelForName = (name, ctx) => {
  if (name == null || name === '') return { facility_id: null, allocation_channel_id: null };
  const { facilityName, channelName } = splitWarehouseName(name);
  const facility_id = facilityName ? facilityIdByName.get(norm(facilityName)) || null : null;
  if (!facility_id) warn(`unresolved facility "${name}"${ctx ? ' @ ' + ctx : ''}`);
  return { facility_id, allocation_channel_id: channelName ? channelIdByName.get(norm(channelName)) || null : null };
};

// ----- seasons (synthesized from distinct strings) ---------------------------
const seasonId = new Map();
const seasons = [];
const ensureSeason = (code) => {
  if (!code) return null;
  const k = norm(code);
  if (!seasonId.has(k)) { const id = `season_${seasonId.size + 1}`; seasonId.set(k, id); seasons.push({ id, code }); }
  return seasonId.get(k);
};

// Per-season production-schedule cutoffs (the On Time / At Risk / Late gates),
// keyed by season CODE and mapped onto synthesized season ids in the WRITE step.
// E-DEL ≤ ontime_by → On Time; ≤ atrisk_by → At Risk; later → Late. Seasons with
// no defined cutoffs get a null row so the table still spans every season.
const SCHEDULE_CUTOFFS = { fw26: { ontime_by: '2026-07-07', atrisk_by: '2026-07-15' } };

// ============================================================================
//  PURCHASE ORDER HIERARCHY  (mainline legs only)
// ============================================================================
const mainlinePos = pos.filter(isMainline);

const po_masters = new Map();        // trn → row
const po_orders  = new Map();        // po_number → row
const orderLineAgg = new Map();      // `${po_number}|${sku}` → {ordered_qty, unit_price}
const mainline_po_legs = [];
const mainline_po_leg_lines = [];
const product_skus = new Map();      // sku_code → row

const mergeSku = (li, extra = {}) => {
  if (!li || !li.sku_code) return;
  const cur = product_skus.get(li.sku_code) || { sku_code: li.sku_code };
  const next = {
    sku_code:    li.sku_code,
    style_color: li.style_color || cur.style_color || extra.style_color || null,
    item_name:   li.item_name   || cur.item_name   || extra.item_name   || null,
    description: li.description  || cur.description || extra.description || null,
    colorway:    li.colorway    || cur.colorway    || extra.colorway    || null,
    size:        li.size        || cur.size        || null,
    hts_code:    cur.hts_code   || extra.hts_code  || null,
    unit_price:  cur.unit_price ?? num(li.unit_price) ?? null,
  };
  product_skus.set(li.sku_code, next);
};

mainlinePos.forEach((po) => {
  const trn = po.trn_number;
  if (!trn) warn(`PO id ${po.id} (${po.po_number}) has blank trn_number`);

  // po_masters — keyed on TRN
  if (trn && !po_masters.has(trn)) {
    po_masters.set(trn, {
      trn_number:    trn,
      supplier_id:   resolve(supplierId, po.supplier, 'supplier', `TRN ${trn}`),
      season_id:     ensureSeason(po.season),
      main_shoulder: po.main_shoulder || null,
      netsuite_id:   po.netsuite_id || null,
    });
  } else if (trn) {
    const m = po_masters.get(trn);
    if (norm(m.supplier_id) && resolve(supplierId, po.supplier, 'supplier') !== m.supplier_id)
      warn(`TRN ${trn} has conflicting supplier across legs`);
  }

  // po_orders — keyed on po_number. The conflated warehouse is decomposed into a
  // physical facility_id + an internal allocation_channel_id (3NF: two facts, two cols).
  if (!po_orders.has(po.po_number)) {
    const fc = facilityChannelForName(po.receiving_warehouse, po.po_number);
    po_orders.set(po.po_number, {
      po_number:             po.po_number,
      trn_number:            trn || null,
      facility_id:           fc.facility_id,
      allocation_channel_id: fc.allocation_channel_id,
      coo_country:           po.coo || null,        // country of origin (the goods' grain)
    });
  }

  // mainline_po_legs — reuse the existing surrogate id as the leg id (keeps
  // booking.po_details[].po_id references valid). NK = (po_number, mode, crd).
  mainline_po_legs.push({
    id:           po.id,
    po_number:    po.po_number,
    mode_id:      resolve(modeId, po.mode, 'mode', `leg ${po.id}`),
    incoterm_id:  resolve(incotermId, po.incoterm, 'incoterm'),
    crd:          po.crd || null,
    etd_pol:      po.etd_pol || null,
    e_del:        po.e_del || null,
  });

  // leg lines + roll up to order lines + SKU master
  (po.line_items || []).forEach((li) => {
    const qty = num(li.expected_qty) || 0;
    mainline_po_leg_lines.push({
      id:            `mll_${po.id}_${li.sku_code}`,
      leg_id:        po.id,
      sku_code:      li.sku_code,
      allocated_qty: qty,
    });
    const k = `${po.po_number}|${li.sku_code}`;
    const agg = orderLineAgg.get(k) || { po_number: po.po_number, sku_code: li.sku_code, ordered_qty: 0, unit_price: num(li.unit_price) };
    agg.ordered_qty += qty;
    orderLineAgg.set(k, agg);
    mergeSku(li);
  });
});

// po_order_lines = leg allocations rolled up to the warehouse grain.
// NOTE: real NetSuite would supply these independently; for migrating EXISTING
// data we reconstruct ordered_qty := Σ allocated_qty, so R2 matches by construction.
const po_order_lines = [...orderLineAgg.values()].map((a, i) => ({
  id: `pol_${i + 1}`, po_number: a.po_number, sku_code: a.sku_code, ordered_qty: a.ordered_qty, unit_price: a.unit_price,
}));

// ============================================================================
//  BOOKINGS / CI / PACKING  (mainline only)
// ============================================================================
const legByNumberFor = (poDetails) => {       // po_number → leg_id within one booking
  const m = new Map();
  (poDetails || []).forEach((d) => { if (d.po_number && !m.has(d.po_number)) m.set(d.po_number, d.po_id); });
  return m;
};

const mainline_bookings = [];
const mainline_booking_po_legs = [];
const mainline_commercial_invoices = [];
const mainline_ci_line_items = [];
const mainline_packing_cartons = [];

bookings.filter(isMainline).forEach((b) => {
  mainline_bookings.push({
    id:                b.id,
    booking_number:    b.booking_number,
    supplier_id:       resolve(supplierId, b.supplier || b.vendor_name, 'supplier', `BKG ${b.booking_number}`),
    incoterm_id:       resolve(incotermId, b.incoterm, 'incoterm'),
    cargo_ready_date:  b.cargo_ready_date || null,
    booking_status_id: resolve(bookingStatusId, b.booking_status, 'status', `BKG ${b.booking_number}`),
    submitted_at:      b.submitted_at || null,
    approved_at:       b.approved_at || null,
  });

  (b.po_details || []).forEach((d) => {
    mainline_booking_po_legs.push({
      id:         `bpl_${b.id}_${d.po_id}`,
      booking_id: b.id,
      leg_id:     d.po_id,
      units:      num(d.units),
      cartons:    num(d.cartons),
      weight_kg:  num(d.weight),
      cbm:        num(d.cbm),
    });
    if (!d.po_id) warn(`BKG ${b.booking_number} po_detail (${d.po_number}) has no po_id → leg unresolved`);
  });

  const legMap = legByNumberFor(b.po_details);

  if (b.commercial_invoice) {
    const ci = b.commercial_invoice;
    const invId = `ci_${b.id}`;
    mainline_commercial_invoices.push({
      id:             invId,
      booking_id:     b.id,
      invoice_number: ci.invoice_number || null,
      invoice_date:   ci.invoice_date || null,
      source:         ci.source || null,
      status:         ci.status || null,
      file_url:       (b.shipment_data && b.shipment_data.file_url) || ci.file_url || null,
    });
    (ci.line_items || []).forEach((li, i) => {
      const legId = legMap.get(li.matched_po) ?? null;
      if (li.matched_po && legId == null) warn(`BKG ${b.booking_number} CI line ${li.sku_code} matched_po ${li.matched_po} → no leg`);
      mainline_ci_line_items.push({
        id:             `cil_${b.id}_${i + 1}`,
        invoice_id:     invId,
        sku_code:       li.sku_code,
        matched_leg_id: legId,
        qty:            num(li.qty),
        weight_kg:      num(li.weight_kg),
        cbm:            num(li.cbm),
        match_status:   li.match_status || null,
      });
      mergeSku({ sku_code: li.sku_code, description: li.description });
    });
  }

  const rows = b.shipment_data && b.shipment_data.rows;
  (rows || []).forEach((r, i) => {
    const legId = legMap.get(r.po_number) ?? null;
    mainline_packing_cartons.push({
      id:               `pk_${b.id}_${i + 1}`,
      booking_id:       b.id,
      ctn_number:       num(r.ctn_number),
      leg_id:           legId,
      sku_code:         r.sku,
      pcs_per_ctn:      num(r.pcs_per_ctn),
      unit_price:       num(r.unit_price),
      total_usd:        num(r.total_usd),
      net_weight_kgs:   num(r.net_weight_kgs),
      gross_weight_kgs: num(r.gross_weight_kgs),
      measure_cm:       r.measure_cm || null,
    });
    mergeSku({ sku_code: r.sku, item_name: r.style_description, description: r.style_description }, { hts_code: r.hts_code });
  });
});

// ============================================================================
//  SHIPMENTS + ASNs  (mainline only)
// ============================================================================
const bookingIdByNumber = new Map();
[...bookings, ...historyBookings].forEach((b) => { if (b.booking_number) bookingIdByNumber.set(b.booking_number, b.id); });

// A shipment is now ONE physical movement = one (booking, facility). Legacy per-leg
// rows that share a booking + physical destination collapse into a single header
// (forwarder updates dates once); the per-leg facts move to a junction table.
const legById     = new Map(mainline_po_legs.map((l) => [String(l.id), l]));
const orderFacility = new Map([...po_orders.values()].map((o) => [o.po_number, o.facility_id]));
const modeNameById = new Map((Array.isArray(modes) ? modes : []).map((m) => [m.id, m.name]));
const earliest = (a, b) => (!a ? b : !b ? a : (a < b ? a : b));
const latest   = (a, b) => (!a ? b : !b ? a : (a > b ? a : b));

const shipHeaders = new Map();              // `${booking_id}|${facility_id}|${mode_id}` → header
const mainline_shipment_legs = [];
let shipSeq = 0;

shipments.filter(isMainline).forEach((s) => {
  const booking_id = bookingIdByNumber.get(s.booking_number) ?? null;
  const leg_id     = s.po_id ?? null;
  const leg        = leg_id != null ? legById.get(String(leg_id)) : null;
  const po         = leg ? leg.po_number : null;
  const mode_id    = leg ? leg.mode_id : null;
  let facility_id  = po ? (orderFacility.get(po) ?? null) : null;
  if (!facility_id) facility_id = facilityChannelForName(s.destination_warehouse || s.receiving_warehouse, `SHP ${s.id}`).facility_id;

  const key = `${booking_id}|${facility_id}|${mode_id}`;
  let h = shipHeaders.get(key);
  if (!h) {
    shipSeq += 1;
    h = {
      id:                   String(shipSeq),
      shipment_number:      `SHP-${shipSeq}`,
      booking_id,
      facility_id,
      mode_id,
      status_id:            resolveShipmentStatus(s.status || s.booking_status),
      container_type_id:    containerTypeFromMode(modeNameById.get(mode_id)),
      pol_port_id:          null,
      pod_port_id:          null,
      bl_no:                null,
      etd_pol:              s.etd_pol || null,
      eta_pod:              s.eta_pod || null,
      e_del:                s.e_del || null,
      cargo_received_date:  s.cargo_received_date || null,
      ata:                  s.received_in_netsuite || null,   // actual receipt date (legacy "received_in_netsuite")
      netsuite_id:          s.netsuite_id || null,
      invoice_value:        num(s.invoice_value),
      duty:                 num(s.duty),
      freight:              num(s.freight),
    };
    shipHeaders.set(key, h);
  } else {
    // consolidate shared logistics dates across the legs of one physical shipment
    h.etd_pol              = earliest(h.etd_pol, s.etd_pol || null);
    h.eta_pod              = latest(h.eta_pod, s.eta_pod || null);
    h.e_del                = latest(h.e_del, s.e_del || null);
    h.cargo_received_date  = latest(h.cargo_received_date, s.cargo_received_date || null);
    h.ata                  = latest(h.ata, s.received_in_netsuite || null);
    h.invoice_value        = h.invoice_value ?? num(s.invoice_value);
    h.duty                 = h.duty ?? num(s.duty);
    h.freight              = h.freight ?? num(s.freight);
    h.netsuite_id          = h.netsuite_id ?? (s.netsuite_id || null);
  }
  if (leg_id != null) {
    mainline_shipment_legs.push({
      id:                `spl_${h.id}_${leg_id}`,
      shipment_id:       h.id,
      leg_id,
      lot_number:        num(s.lot_number),
      expected_quantity: num(s.expected_quantity ?? s.expected_qty),
    });
  }
});
const mainline_shipments = [...shipHeaders.values()];

const mainline_asns = (Array.isArray(asns) ? asns : [])
  .filter((a) => bookingIdByNumber.has(a.booking_number))   // mainline bookings only
  .map((a) => ({
    id:           a.id,
    booking_id:   bookingIdByNumber.get(a.booking_number),
    file_url:     a.file_url || null,
    status:       a.status || null,
    generated_at: a.generated_at || a.created_at || null,
  }));

// ----- role_permissions (flatten permissions[]) ------------------------------
const role_permissions = [];
(Array.isArray(roles) ? roles : []).forEach((r) => (r.permissions || []).forEach((p) => role_permissions.push({ role_id: r.id, permission: p })));

// ============================================================================
//  WRITE + REPORT
// ============================================================================
// per-season schedule cutoffs (one row per season; null cutoffs when undefined)
const production_schedules = seasons.map((s) => ({
  season_id: s.id,
  ontime_by: (SCHEDULE_CUTOFFS[norm(s.code)] || {}).ontime_by || null,
  atrisk_by: (SCHEDULE_CUTOFFS[norm(s.code)] || {}).atrisk_by || null,
}));

// standard lead time per (mode, journey segment) in days — seeded defaults the
// reports use to project unbooked legs and grade slipped shipment segments.
// Editable master data; tune per trade lane once real history accumulates.
const TRANSIT_SEED = {
  m1: { production_handover: 7, origin_dwell: 7, port_to_port: 30, destination_leg: 7, receiving: 5 },  // Sea
  m2: { production_handover: 7, origin_dwell: 3, port_to_port: 7,  destination_leg: 3, receiving: 5 },  // Air
};
const transit_time_standards = Object.entries(TRANSIT_SEED).flatMap(([mode_id, segs]) =>
  Object.entries(segs).map(([segment, days]) => ({ id: `tts_${mode_id}_${segment}`, mode_id, segment, days })));

const out = {
  seasons,
  production_schedules,
  transit_time_standards,
  statuses,
  warehouse_facilities,
  allocation_channels,
  container_types,
  ports,
  product_skus: [...product_skus.values()],
  po_masters: [...po_masters.values()],
  po_orders: [...po_orders.values()],
  po_order_lines,
  mainline_po_legs,
  mainline_po_leg_lines,
  mainline_bookings,
  mainline_booking_po_legs,
  mainline_commercial_invoices,
  mainline_ci_line_items,
  mainline_packing_cartons,
  mainline_shipments,
  mainline_shipment_legs,
  mainline_asns,
  role_permissions,
};

if (!DRY) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, rows] of Object.entries(out)) {
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(rows, null, 2));
  }
}

// R2 reconciliation: per (po_number, sku) ordered vs Σ allocated (tautological
// for migrated data, but proves the roll-up wiring is sound).
const allocAgg = new Map();
mainline_po_leg_lines.forEach((l) => {
  const po = mainline_po_legs.find((g) => g.id === l.leg_id);
  if (!po) return;
  const k = `${po.po_number}|${l.sku_code}`;
  allocAgg.set(k, (allocAgg.get(k) || 0) + (l.allocated_qty || 0));
});
let mismatches = 0;
po_order_lines.forEach((o) => { if ((allocAgg.get(`${o.po_number}|${o.sku_code}`) || 0) !== o.ordered_qty) mismatches++; });

console.log(`\n=== Migration ${DRY ? '(dry run)' : '→ ' + path.relative(process.cwd(), OUT)} ===\n`);
console.log('Master data (decomposed warehouse):');
console.log(`  warehouse_facilities      ${out.warehouse_facilities.length}`);
console.log(`  allocation_channels       ${out.allocation_channels.length}`);
console.log(`  container_types           ${out.container_types.length}`);
console.log(`  ports                     ${out.ports.length}`);
console.log(`  production_schedules      ${out.production_schedules.length}`);
console.log(`  transit_time_standards    ${out.transit_time_standards.length}`);
console.log('PO hierarchy:');
console.log(`  po_masters (TRN)          ${out.po_masters.length}`);
console.log(`  po_orders  (po_number)    ${out.po_orders.length}`);
console.log(`  mainline_po_legs          ${out.mainline_po_legs.length}`);
console.log(`  po_order_lines            ${out.po_order_lines.length}`);
console.log(`  mainline_po_leg_lines     ${out.mainline_po_leg_lines.length}`);
console.log(`  product_skus              ${out.product_skus.length}`);
console.log('Transactional (mainline):');
console.log(`  mainline_bookings         ${out.mainline_bookings.length}`);
console.log(`  _booking_po_legs          ${out.mainline_booking_po_legs.length}`);
console.log(`  _commercial_invoices      ${out.mainline_commercial_invoices.length}`);
console.log(`  _ci_line_items            ${out.mainline_ci_line_items.length}`);
console.log(`  _packing_cartons          ${out.mainline_packing_cartons.length}`);
console.log(`  _shipments (headers)      ${out.mainline_shipments.length}`);
console.log(`  _shipment_legs (junction) ${out.mainline_shipment_legs.length}`);
console.log(`  _asns                     ${out.mainline_asns.length}`);
console.log(`  role_permissions          ${out.role_permissions.length}`);
console.log(`\nR2 reconciliation mismatches: ${mismatches}`);

// dedup + tally warnings
const tally = warnings.reduce((m, w) => (m[w] = (m[w] || 0) + 1, m), {});
const keys = Object.keys(tally);
console.log(`\nWarnings (${warnings.length} total, ${keys.length} distinct):`);
keys.slice(0, 25).forEach((w) => console.log(`  ${tally[w]}×  ${w}`));
if (keys.length > 25) console.log(`  …and ${keys.length - 25} more`);
console.log('');
