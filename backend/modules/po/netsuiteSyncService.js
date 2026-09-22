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
const { pruneStaleReceipts } = require('../../utils/pruneStaleReceipts');

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
  const rejectedPos = [];
  let mUpsert = 0, oUpsert = 0, lUpsert = 0;
  let lineSeq = existing.orderLines.reduce((mx, l) => Math.max(mx, +String(l.id).replace(/\D/g, '') || 0), 0);

  for (const po of pos) {
    if (!po.po_number) continue;

    // R4 (refuse-rejected): NetSuite said no, so there are no goods coming and
    // this is not a PO — never fold it in. The SuiteQL scope already excludes it
    // (poStatusClause + NOT_REJECTED_CLAUSE); this is the second lock on the door,
    // because the query is one edit away from letting it back through and THIS is
    // the code that writes. PO03521 / PO03789 arrived exactly that way.
    if (isRejected(po)) { rejectedPos.push(po.po_number); continue; }

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
      // NetSuite's approval state for this PO ('Pending Approval' | 'Approved' |
      // null). Stored, not derived — nothing local can tell you whether a
      // supervisor has signed off. Drives the "Pending approval" badge on the PO
      // list/detail. Refreshed for EVERY held PO after this fold (see sync), not
      // just the ones in the pull, or it would freeze on POs that moved on.
      approval_status:       po.approval_status || prev.approval_status || null,
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
    stats: {
      masters_upserted: mUpsert, orders_upserted: oUpsert, lines_upserted: lUpsert,
      protected: protectedPos, rejected_skipped: rejectedPos,
    },
  };
}

// NetSuite says this PO was rejected. Read from the display value the header query
// already selects (`BUILTIN.DF(t.approvalstatus) AS approval_status`) — the numeric
// code never reaches this layer.
function isRejected(po) {
  return String(po?.approval_status || '').trim().toLowerCase() === 'rejected';
}

/**
 * Remove POs NetSuite has rejected from the three NS-owned grains.
 *
 * A filter on the pull cannot do this: the usual case is a PO that was synced
 * while pending and rejected afterwards, so it is already stored and simply stops
 * being refreshed — it would sit in the order book, in the forecast and in the
 * booking picker forever.
 *
 * REFUSES to touch a PO anything else points at (legs, a booking, a shipment or a
 * receipt). Deleting one of those would orphan real transactional records, and a
 * rejected-but-booked PO is a genuine contradiction for a human to resolve, not
 * something a sync should silently paper over — so it is reported instead. This
 * mirrors R1: NetSuite owns this hierarchy, but never at the cost of portal rows.
 *
 * A master is dropped only when the LAST of its POs goes, so a TRN that still has
 * live POs keeps its header.
 *
 * Pure: takes and returns the tables. Same helper used by the sync and by
 * scripts/prune-rejected-pos.js.
 */
function pruneRejected({ rejectedPoNumbers, masters, orders, orderLines, referencedPoNumbers }) {
  const rejected = rejectedPoNumbers instanceof Set ? rejectedPoNumbers : new Set(rejectedPoNumbers || []);
  const referenced = referencedPoNumbers instanceof Set ? referencedPoNumbers : new Set(referencedPoNumbers || []);

  const removable = orders.filter((o) => rejected.has(o.po_number) && !referenced.has(o.po_number)).map((o) => o.po_number);
  const keptReferenced = orders.filter((o) => rejected.has(o.po_number) && referenced.has(o.po_number)).map((o) => o.po_number);
  const removeSet = new Set(removable);

  const nextOrders = orders.filter((o) => !removeSet.has(o.po_number));
  const nextLines = orderLines.filter((l) => !removeSet.has(l.po_number));
  const survivingTrns = new Set(nextOrders.map((o) => o.trn_number).filter(Boolean));
  const orphanedTrns = [...new Set(orders.filter((o) => removeSet.has(o.po_number)).map((o) => o.trn_number).filter(Boolean))]
    .filter((trn) => !survivingTrns.has(trn));
  const orphanSet = new Set(orphanedTrns);
  const nextMasters = masters.filter((m) => !orphanSet.has(m.trn_number));

  return {
    masters: nextMasters,
    orders: nextOrders,
    orderLines: nextLines,
    removed: {
      po_numbers: removable,
      orders: orders.length - nextOrders.length,
      lines: orderLines.length - nextLines.length,
      masters: masters.length - nextMasters.length,
      trns: orphanedTrns,
    },
    kept_referenced: keptReferenced,
  };
}

// ---- locked-set helpers (R1) ------------------------------------------------
/**
 * Every po_number something in the portal points at: a WIP leg, a booking, a
 * shipment or an Item Receipt. Wider than computeLocked() on purpose — that one
 * answers "may sync overwrite this?", this one answers "may sync DELETE this?",
 * and a leg with no booking yet is still a portal row that must not be orphaned.
 */
async function computeReferenced() {
  const [legs, bookingLegs, shipmentLegs, receipts] = await Promise.all([
    LegReadModel.readLegs(),
    new BaseModel('migrated/mainline_booking_po_legs.json').read(),
    new BaseModel('migrated/mainline_shipment_legs.json').read(),
    ItemReceiptModel.readReceipts().catch(() => []),
  ]);
  const referenced = new Set();
  const poByLeg = new Map(legs.map((l) => [l.id, l.po_number]));
  legs.forEach((l) => { if (l.po_number) referenced.add(l.po_number); });
  [...bookingLegs, ...shipmentLegs].forEach((r) => {
    const po = poByLeg.get(r.leg_id);
    if (po) referenced.add(po);
  });
  receipts.forEach((r) => { if (r.po_number) referenced.add(r.po_number); });
  return referenced;
}

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
function foldReceipts(nsReceipts, existingReceipts, existingLines, queriedPoNumbers = null) {
  const byIr = new Map(existingReceipts.filter((r) => r.netsuite_ir_id).map((r) => [r.netsuite_ir_id, r]));
  let irSeq = existingReceipts.reduce((mx, r) => Math.max(mx, +String(r.id).replace(/\D/g, '') || 0), 0);
  const outReceipts = [...existingReceipts];
  let outLines = [...existingLines];
  for (const ir of nsReceipts) {
    if (!ir.po_number) continue;
    let r = byIr.get(ir.ir_id);
    if (!r) {
      r = { id: `mir_${++irSeq}`, netsuite_ir_id: ir.ir_id, netsuite_ir_tranid: ir.ir_tranid || null,
        po_number: ir.po_number, receipt_date: ir.receipt_date || null, source: 'netsuite',
        // portal-owned landed-cost match (confirmed per-PO IR ↔ shipment) — see
        // mainlineReceiptController; preserved across re-sync, never touched here.
        matched_shipment_id: null, confirmed_by: null, confirmed_at: null };
      outReceipts.push(r); byIr.set(ir.ir_id, r);
    } else {
      r.po_number = ir.po_number;                       // refresh NS facts only;
      r.netsuite_ir_tranid = ir.ir_tranid || r.netsuite_ir_tranid;   // NEVER touch the
      r.receipt_date = ir.receipt_date || r.receipt_date;             // matched_* columns
    }
    outLines = outLines.filter((l) => l.receipt_id !== r.id);
    (ir.lines || []).forEach((l, i) => outLines.push({ id: `mirl_${r.id.replace(/\D/g, '')}_${i + 1}`, receipt_id: r.id, sku_code: l.sku_code, qty: l.qty }));
  }

  // Receipts NetSuite has DELETED. The loop above only adds and refreshes, so an
  // IR deleted in NetSuite and replaced left the portal holding both and summing
  // them as received — found on SMS PO04801, identical hole here. `queriedPoNumbers`
  // is required to prune: without it we cannot tell "NetSuite says this is gone"
  // from "we never asked about this PO", so callers that don't pass it keep the
  // old add-only behaviour rather than deleting on a guess.
  if (queriedPoNumbers) {
    const pruned = pruneStaleReceipts({
      nsReceipts, queriedPoNumbers, receipts: outReceipts, receiptLines: outLines,
    });
    return { receipts: pruned.receipts, receiptLines: pruned.receiptLines, removed: pruned.removed };
  }
  return { receipts: outReceipts, receiptLines: outLines, removed: [] };
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

  // Rejected POs the portal is ALREADY holding. The pull can't surface these —
  // they're out of scope by definition — so ask NetSuite about what we hold and
  // drop what it has rejected. Runs before the netsuite_id backfill so we don't
  // resolve ids for rows about to go. Never fails the sync.
  let rejected_removed = { po_numbers: [], orders: 0, lines: 0, masters: 0, trns: [] };
  let rejected_kept_referenced = [];
  let approval_refreshed = 0;
  try {
    const held = result.orders.map((o) => o.po_number).filter(Boolean);
    // One query answers both: which held POs are rejected (prune) and what each
    // one's approval status is NOW (the badge). A PO that has left the A/B pull
    // scope — approved and received since — still gets its value corrected here.
    const statuses = await integrationService.fetchPoApprovalStatuses(held);
    result.orders.forEach((o) => {
      const ns = statuses.get(o.po_number);
      if (ns && ns.approval !== o.approval_status) { o.approval_status = ns.approval; approval_refreshed++; }
    });
    const rejectedNow = new Set([...statuses.entries()].filter(([, v]) => v.rejected).map(([k]) => k));
    if (rejectedNow.size) {
      const p = pruneRejected({
        rejectedPoNumbers: rejectedNow,
        masters: result.masters, orders: result.orders, orderLines: result.orderLines,
        referencedPoNumbers: await computeReferenced(),
      });
      result.masters = p.masters;
      result.orders = p.orders;
      result.orderLines = p.orderLines;
      rejected_removed = p.removed;
      rejected_kept_referenced = p.kept_referenced;
      if (p.removed.po_numbers.length) console.log(`[PO sync] removed rejected PO(s): ${p.removed.po_numbers.join(', ')}`);
      if (p.kept_referenced.length) console.warn(`[PO sync] rejected but REFERENCED, left in place for review: ${p.kept_referenced.join(', ')}`);
    }
  } catch (e) {
    console.error('[PO sync] approval refresh / rejected-PO prune skipped:', e.message);
  }

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
  let receipts_removed = [];
  try {
    // Scope = every held PO we have an internal id for; that is exactly what the
    // receipt query asks about, so it is also exactly what the fold may prune.
    const scoped = result.orders.filter((o) => o.netsuite_id && o.po_number);
    const poIds = scoped.map((o) => o.netsuite_id);
    if (poIds.length) {
      const nsReceipts = await integrationService.fetchNetSuiteItemReceipts(poIds);
      const [exR, exL] = await Promise.all([ItemReceiptModel.readReceipts(), ItemReceiptModel.readReceiptLines()]);
      const folded = foldReceipts(nsReceipts, exR, exL, new Set(scoped.map((o) => o.po_number)));
      await Promise.all([ItemReceiptModel.writeReceipts(folded.receipts), ItemReceiptModel.writeReceiptLines(folded.receiptLines)]);
      receipts_upserted = nsReceipts.length;
      receipts_removed = folded.removed;
      folded.removed.forEach((r) => console.warn(
        `[PO sync] receipt ${r.ir} (${r.po_number}) no longer exists in NetSuite — removed${r.was_confirmed ? ' (carried a CONFIRMED match)' : ''}`,
      ));
    }
  } catch (e) {
    console.error('[PO sync] item-receipt fetch failed — received qty skipped:', e.message);
  }

  return {
    ...result.stats, receipts_upserted, receipts_removed, rejected_removed, rejected_kept_referenced,
    approval_refreshed, warnings: [...new Set(resolvers.warnings)], fetched: pos.length,
  };
}

module.exports = { sync, buildUpserts, computeLocked, computeReferenced, pruneRejected, isRejected };
