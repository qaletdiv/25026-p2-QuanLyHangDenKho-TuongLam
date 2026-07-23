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
const ItemReceiptModel = require('../mainline/receipts/MainlineItemReceiptModel');

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
      // NS PO internal id at the COMPONENT-PO grain — Item Receipts attach here
      // (createdfrom = this id), so received qty is scoped by it. (po_masters also
      // carries one, but that's lossy when a TRN spans several POs — this is the
      // authoritative per-po_number id.)
      netsuite_id:           po.netsuite_id ?? prev.netsuite_id ?? null,
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
// Fold NetSuite Item Receipts into mainline_item_receipts/_lines. Keyed on
// netsuite_ir_id (idempotent); read-only from NS (no portal-owned fields).
// A receipt attaches to its source po_number; received qty is derived from the lines.
function foldReceipts(nsReceipts, existingReceipts, existingLines) {
  const byIr = new Map(existingReceipts.filter((r) => r.netsuite_ir_id).map((r) => [r.netsuite_ir_id, r]));
  let irSeq = existingReceipts.reduce((mx, r) => Math.max(mx, +String(r.id).replace(/\D/g, '') || 0), 0);
  const outReceipts = [...existingReceipts];
  let outLines = [...existingLines];
  for (const ir of nsReceipts) {
    if (!ir.po_number) continue;
    let r = byIr.get(ir.ir_id);
    if (!r) {
      r = { id: `mir_${++irSeq}`, netsuite_ir_id: ir.ir_id, netsuite_ir_tranid: ir.ir_tranid || null,
        po_number: ir.po_number, receipt_date: ir.receipt_date || null, source: 'netsuite' };
      outReceipts.push(r); byIr.set(ir.ir_id, r);
    } else {
      r.po_number = ir.po_number;
      r.netsuite_ir_tranid = ir.ir_tranid || r.netsuite_ir_tranid;
      r.receipt_date = ir.receipt_date || r.receipt_date;
    }
    outLines = outLines.filter((l) => l.receipt_id !== r.id);
    (ir.lines || []).forEach((l, i) => outLines.push({ id: `mirl_${r.id.replace(/\D/g, '')}_${i + 1}`, receipt_id: r.id, sku_code: l.sku_code, qty: l.qty }));
  }
  return { receipts: outReceipts, receiptLines: outLines };
}

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

  // Backfill NS internal ids for po_orders the active pull didn't return (received/
  // closed POs, D..H) by resolving their tranid → id. Lets received qty work for
  // those WITHOUT widening the PO pull (no new POs enter the list). Best-effort.
  try {
    const missing = result.orders.filter((o) => o.po_number && !o.netsuite_id).map((o) => o.po_number);
    if (missing.length) {
      const idByTranid = await integrationService.fetchPoIdsByTranid(missing);
      result.orders.forEach((o) => { if (!o.netsuite_id && idByTranid[o.po_number]) o.netsuite_id = idByTranid[o.po_number]; });
    }
  } catch (e) {
    console.error('[PO sync] netsuite_id backfill failed:', e.message);
  }

  await Promise.all([
    PoMasterModel.write(result.masters),
    PoOrderModel.writeOrders(result.orders),
    PoOrderModel.writeOrderLines(result.orderLines),
  ]);

  // Item Receipts (received qty) — read-only, scoped to the mainline POs we hold
  // internal ids for. A PO keeps its netsuite_id after it leaves the active window,
  // so its later receipts keep syncing. Never fails the PO sync (degrades to skip).
  let receipts_upserted = 0;
  try {
    const poIds = result.orders.map((o) => o.netsuite_id).filter(Boolean);
    if (poIds.length) {
      const nsReceipts = await integrationService.fetchNetSuiteItemReceipts(poIds);
      const [exR, exL] = await Promise.all([ItemReceiptModel.readReceipts(), ItemReceiptModel.readReceiptLines()]);
      const folded = foldReceipts(nsReceipts, exR, exL);
      await Promise.all([ItemReceiptModel.writeReceipts(folded.receipts), ItemReceiptModel.writeReceiptLines(folded.receiptLines)]);
      receipts_upserted = nsReceipts.length;
    }
  } catch (e) {
    console.error('[PO sync] item-receipt fetch failed — received qty skipped:', e.message);
  }

  return { ...result.stats, receipts_upserted, warnings: [...new Set(resolvers.warnings)], fetched: pos.length };
}

module.exports = { sync, buildUpserts, computeLocked };
