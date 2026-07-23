'use strict';

// NetSuite sync (Phase 2a) — owns po_masters / po_orders / po_order_lines.
// Consumes flat NS PO objects (from integrationService.fetchNetSuitePOs) where each
// PO carries: po_number, trn_number, supplier, season, receiving_warehouse, line_items[].
// Maps them into the three NetSuite-owned grains. NEVER writes legs (WIP owns those).
//
// R1 (protect-if-booked): a po_number whose legs are referenced by a booking or
// shipment is LOCKED — sync skips all writes touching it. A TRN with any locked
// order keeps its existing master untouched (master still created if absent).

const PoMasterModel = require('./PoMasterModel');
const PoOrderModel  = require('./PoOrderModel');
const LegReadModel  = require('./LegReadModel');
const { loadResolvers } = require('./resolvers');
const BaseModel = require('../../models/BaseModel');
const integrationService = require('../../services/integrationService');

// ---- pure core: fold NS POs into the three grains, honoring R1 -------------
// existing = { masters, orders, orderLines }
// ctx      = { resolvers, lockedPoNumbers:Set, lockedTrns:Set }
function buildUpserts(pos, existing, ctx) {
  const { resolvers, lockedPoNumbers, lockedTrns } = ctx;
  const masters    = new Map(existing.masters.map((m) => [m.trn_number, m]));
  const orders     = new Map(existing.orders.map((o) => [o.po_number, o]));
  // order lines indexed by po_number → keep other POs' lines intact
  const linesByPo  = existing.orderLines.reduce((mp, l) => ((mp[l.po_number] = mp[l.po_number] || []).push(l), mp), {});

  const protectedPos = [];
  let mUpsert = 0, oUpsert = 0, lUpsert = 0;
  let lineSeq = existing.orderLines.reduce((mx, l) => Math.max(mx, +String(l.id).replace(/\D/g, '') || 0), 0);

  for (const po of pos) {
    if (!po.po_number) continue;

    // R1: locked order → skip everything that touches it.
    if (lockedPoNumbers.has(po.po_number)) { protectedPos.push(po.po_number); continue; }

    // --- po_masters (TRN grain) ---
    if (po.trn_number) {
      if (!masters.has(po.trn_number)) {
        masters.set(po.trn_number, {
          trn_number:    po.trn_number,
          supplier_id:   resolvers.supplierId(po.supplier, `TRN ${po.trn_number}`),
          season_id:     resolvers.seasonId(po.season, `TRN ${po.trn_number}`),
          main_shoulder: po.main_shoulder || null,
          netsuite_id:   po.netsuite_id || null,
        });
        mUpsert++;
      } else if (!lockedTrns.has(po.trn_number)) {
        // refresh an unlocked existing master
        const m = masters.get(po.trn_number);
        m.supplier_id   = resolvers.supplierId(po.supplier, `TRN ${po.trn_number}`) ?? m.supplier_id;
        m.season_id     = resolvers.seasonId(po.season, `TRN ${po.trn_number}`) ?? m.season_id;
        m.main_shoulder = po.main_shoulder || m.main_shoulder;
        m.netsuite_id   = po.netsuite_id || m.netsuite_id;
        mUpsert++;
      }
    }

    // --- po_orders (po_number grain) ---
    const fc = resolvers.facilityChannel(po.receiving_warehouse, po.po_number);
    const prev = orders.get(po.po_number) || {};
    orders.set(po.po_number, {
      ...prev,                             // preserve fields this sync doesn't own
      po_number:             po.po_number,
      trn_number:            po.trn_number || prev.trn_number || null,
      // destination/channel/COO: NS fills them when it can resolve, but NEVER nulls
      // out a value already set (e.g. one the WIP import resolved) — so sync order
      // doesn't matter. WIP is the reliable source for these planning attributes.
      facility_id:           fc.facility_id ?? prev.facility_id ?? null,
      allocation_channel_id: fc.allocation_channel_id ?? prev.allocation_channel_id ?? null,
      coo_country:           po.coo || prev.coo_country || null,
    });
    oUpsert++;

    // --- po_order_lines (replace this PO's lines) ---
    linesByPo[po.po_number] = (po.line_items || []).map((li) => ({
      id:          `pol_${++lineSeq}`,
      po_number:   po.po_number,
      sku_code:    li.sku_code,
      ordered_qty: Number(li.expected_qty) || 0,
      unit_price:  Number(li.unit_price) || null,
    }));
    lUpsert += linesByPo[po.po_number].length;
  }

  return {
    masters:    [...masters.values()],
    orders:     [...orders.values()],
    orderLines: Object.values(linesByPo).flat(),
    stats: { masters_upserted: mUpsert, orders_upserted: oUpsert, lines_upserted: lUpsert, protected: protectedPos },
  };
}

// ---- locked-set helpers (R1) ------------------------------------------------
async function computeLocked() {
  const [legs, bookingLegs, shipments] = await Promise.all([
    LegReadModel.readLegs(),
    new BaseModel('migrated/mainline_booking_po_legs.json').read(),
    new BaseModel('migrated/mainline_shipments.json').read(),
  ]);
  const poByLeg = new Map(legs.map((l) => [l.id, l.po_number]));
  const lockedPoNumbers = new Set();
  [...bookingLegs, ...shipments].forEach((r) => {
    const po = poByLeg.get(r.leg_id);
    if (po) lockedPoNumbers.add(po);
  });
  return lockedPoNumbers;
}

// ---- IO entrypoint ----------------------------------------------------------
async function sync({ fetchPos } = {}) {
  const fetch = fetchPos || (() => integrationService.fetchNetSuitePOs({ type: 'mainline' }));

  // Degrade gracefully: a bad/expired NetSuite token or network error must not
  // 500 the endpoint or mutate data — report it and upsert nothing.
  let pos, fetchError = null;
  try { pos = await fetch(); }
  catch (e) { fetchError = e.response?.data?.['o:errorDetails']?.[0]?.detail || e.message; pos = []; }

  const [masters, orders, orderLines, resolvers, lockedPoNumbers] = await Promise.all([
    PoMasterModel.read(), PoOrderModel.readOrders(), PoOrderModel.readOrderLines(),
    loadResolvers(), computeLocked(),
  ]);
  if (fetchError) {
    return { masters_upserted: 0, orders_upserted: 0, lines_upserted: 0, protected: [], warnings: [], fetched: 0, fetch_error: fetchError };
  }
  const lockedTrns = new Set(orders.filter((o) => lockedPoNumbers.has(o.po_number)).map((o) => o.trn_number));

  const result = buildUpserts(pos, { masters, orders, orderLines }, { resolvers, lockedPoNumbers, lockedTrns });

  await Promise.all([
    PoMasterModel.write(result.masters),
    PoOrderModel.writeOrders(result.orders),
    PoOrderModel.writeOrderLines(result.orderLines),
  ]);
  return { ...result.stats, warnings: [...new Set(resolvers.warnings)], fetched: pos.length };
}

module.exports = { sync, buildUpserts, computeLocked };
