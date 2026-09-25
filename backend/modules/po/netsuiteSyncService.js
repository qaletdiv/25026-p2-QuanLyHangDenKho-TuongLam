'use strict';

// NetSuite sync (Phase 2a) — owns po_masters / po_orders / po_order_lines.
// Consumes flat NS PO objects (from integrationService.fetchNetSuitePOs) where each
// PO carries: poNumber, trnNumber, supplier, season, receivingWarehouse, line_items[].
// Maps them into the NetSuite-owned grains. Since 2026-09-25 it ALSO writes
// mainline_po_legs for v2 seasons (one leg per PO, `source:'netsuite'`); FW26
// legs stay owned by the WIP import. See the v1/v2 note below.
//
// R1 (protect-if-booked): a poNumber whose legs are referenced by a booking or
// shipment is LOCKED — sync skips all writes touching it. A TRN with any locked
// order keeps its existing master untouched (master still created if absent).

const { loadResolvers } = require('./resolvers');
const { models } = require('../../models');
const integrationService = require('../../services/integrationService');
const { pruneStaleReceipts } = require('../../utils/pruneStaleReceipts');

// ---------------------------------------------------------------------------
//  WORKFLOW v1 vs v2 — the boundary is the SEASON, not a feature flag.
//
//  v1 (FW26)   a PO is split into air/sea legs by the WIP import. One PO can
//              carry BOTH modes: 16 of 64 legged FW26 POs do. NetSuite has one
//              mode per PO header and CANNOT express that, which is why the
//              spreadsheet owns the split for this season.
//
//  v2 (SS27+)  1 PO = 1 warehouse = 1 method = ONE LEG, created right here from
//              the NetSuite record. No channel (everything lands in …First), no
//              WIP import, no air/sea split.
//
//  The two coexist with no migration: FW26 keeps its WIP-built legs untouched,
//  SS27 had ZERO legs to convert. Reverting v2 is deleting the condition below —
//  there is no schema fork to undo, because both regimes produce the same legs.
//
//  `source` records which built the row ('wip' | 'netsuite').
// ---------------------------------------------------------------------------
const V1_SEASONS = new Set(['FW26']);   // WIP import owns the split for these

// Fallback only — the real value comes from transit_time_standards.receiving,
// which is editable master data (5 days for both sea and air today).
const DEFAULT_RECEIVING_DAYS = 5;

const { addDays } = require('../mainline/reports/transitTimeService');

// ---- pure core: fold NS POs into the grains, honoring R1 -------------------
// existing = { masters, orders, orderLines, legs }
// ctx      = { resolvers, lockedPoNumbers:Set, lockedTrns:Set, receivingDays:Map }
function buildUpserts(pos, existing, ctx) {
  const { resolvers, lockedPoNumbers, lockedTrns, receivingDays } = ctx;
  const masters    = new Map(existing.masters.map((m) => [m.trnNumber, m]));
  const orders     = new Map(existing.orders.map((o) => [o.poNumber, o]));
  // order lines indexed by poNumber → keep other POs' lines intact
  const linesByPo  = existing.orderLines.reduce((mp, l) => ((mp[l.poNumber] = mp[l.poNumber] || []).push(l), mp), {});
  const legs       = new Map((existing.legs || []).map((l) => [l.id, l]));
  // ⚠️ SKU MASTER must be seeded before a leg line can reference it.
  // `mainline_po_leg_lines.skuCode` has an FK to product_skus; `po_order_lines`
  // does NOT (the data never satisfied it). Under v1 that gap was invisible
  // because forecast-stage POs had no legs — CLAUDE.md says as much: "none of
  // those SKUs appear in any leg line". v2 gives every PO a leg, so the missing
  // SKUs become a COMMIT-time FK failure. The WIP import already seeds them the
  // same way (upsertSkus); this is the sync's equivalent.
  const skus = new Map((existing.skus || []).map((s) => [s.skuCode, s]));
  let skusAdded = 0;
  // leg lines indexed by legId → WIP-owned legs keep theirs untouched
  const legLinesByLeg = (existing.legLines || []).reduce(
    (mp, l) => ((mp[l.legId] = mp[l.legId] || []).push(l), mp), {},
  );
  let legUpsert = 0;
  const legsSkippedV1 = [];

  const protectedPos = [];
  const rejectedPos = [];
  let mUpsert = 0, oUpsert = 0, lUpsert = 0;
  // (the `pol_<n>` running counter is gone — line ids are derived from the PO
  //  and NetSuite's line number now, so they are stable across syncs)

  for (const po of pos) {
    if (!po.poNumber) continue;

    // R4 (refuse-rejected): NetSuite said no, so there are no goods coming and
    // this is not a PO — never fold it in. The SuiteQL scope already excludes it
    // (poStatusClause + NOT_REJECTED_CLAUSE); this is the second lock on the door,
    // because the query is one edit away from letting it back through and THIS is
    // the code that writes. PO03521 / PO03789 arrived exactly that way.
    if (isRejected(po)) { rejectedPos.push(po.poNumber); continue; }

    // R1: locked order → skip everything that touches it.
    if (lockedPoNumbers.has(po.poNumber)) { protectedPos.push(po.poNumber); continue; }

    // --- po_masters (TRN grain) ---
    if (po.trnNumber) {
      if (!masters.has(po.trnNumber)) {
        masters.set(po.trnNumber, {
          trnNumber:    po.trnNumber,
          supplierId:   resolvers.supplierId(po.supplier, `TRN ${po.trnNumber}`),
          seasonId:     resolvers.seasonId(po.season, `TRN ${po.trnNumber}`),
          mainShoulder: po.mainShoulder || null,
          netsuiteId:   po.netsuiteId || null,
        });
        mUpsert++;
      } else if (!lockedTrns.has(po.trnNumber)) {
        // refresh an unlocked existing master
        const m = masters.get(po.trnNumber);
        m.supplierId   = resolvers.supplierId(po.supplier, `TRN ${po.trnNumber}`) ?? m.supplierId;
        m.seasonId     = resolvers.seasonId(po.season, `TRN ${po.trnNumber}`) ?? m.seasonId;
        m.mainShoulder = po.mainShoulder || m.mainShoulder;
        m.netsuiteId   = po.netsuiteId || m.netsuiteId;
        mUpsert++;
      }
    }

    // --- po_orders (poNumber grain) ---
    const fc = resolvers.facilityChannel(po.receivingWarehouse, po.poNumber);
    const prev = orders.get(po.poNumber) || {};
    orders.set(po.poNumber, {
      ...prev,                             // preserve fields this sync doesn't own
      poNumber:             po.poNumber,
      trnNumber:            po.trnNumber || prev.trnNumber || null,
      // Season from custbody7 ON THE PO, not via the TRN. The TRN still matters
      // to production, but it is not the logistics grain: a PO with no TRN still
      // has a season, and the v1/v2 rule below must not depend on one.
      seasonId:             resolvers.seasonId(po.season, po.poNumber) ?? prev.seasonId ?? null,
      // custbody_tt_po_type — 'Mainline' | 'SMS' | 'SMU'. SMU belongs to the
      // mainline module (confirmed 2026-09-25); the SMS scope stays SMM/SMS only.
      poType:               po.type || prev.poType || null,
      // NS PO internal id at the COMPONENT-PO grain — Item Receipts attach here
      // (createdfrom = this id), so received qty is scoped by it. (po_masters also
      // carries one, but that's lossy when a TRN spans several POs — this is the
      // authoritative per-poNumber id.)
      netsuiteId:           po.netsuiteId ?? prev.netsuiteId ?? null,
      // NetSuite's approval state for this PO ('Pending Approval' | 'Approved' |
      // null). Stored, not derived — nothing local can tell you whether a
      // supervisor has signed off. Drives the "Pending approval" badge on the PO
      // list/detail. Refreshed for EVERY held PO after this fold (see sync), not
      // just the ones in the pull, or it would freeze on POs that moved on.
      approvalStatus:       po.approvalStatus || prev.approvalStatus || null,
      // destination/channel/COO: NS fills them when it can resolve, but NEVER nulls
      // out a value already set (e.g. one the WIP import resolved) — so sync order
      // doesn't matter. WIP is the reliable source for these planning attributes.
      facilityId:           fc.facilityId ?? prev.facilityId ?? null,
      allocationChannelId: fc.allocationChannelId ?? prev.allocationChannelId ?? null,
      cooCountry:           po.coo || prev.cooCountry || null,
    });
    oUpsert++;

    // --- v2: ONE LEG PER PO, straight from NetSuite -------------------------
    const seasonCode = String(po.season || '').toUpperCase();
    if (!V1_SEASONS.has(seasonCode)) {
      const legId = `leg_ns_${po.poNumber}`;
      const existingLeg = legs.get(legId);

      // Never touch a leg the WIP import owns. v1 and v2 do not overlap today,
      // but a PO hand-split before its season flipped would otherwise lose that
      // split to a single generated leg.
      if (existingLeg && existingLeg.source && existingLeg.source !== 'netsuite') {
        legsSkippedV1.push(po.poNumber);
      } else {
        const modeId = resolvers.modeId(po.mode, po.poNumber)
          ?? (existingLeg ? existingLeg.modeId : null);

        // ⚠️ THE PLAN IS WRITTEN ONCE AND NEVER OVERWRITTEN.
        // `duedate` is what production committed to at the start of the season,
        // and the forecast measures slippage as (actual − plan). If a later sync
        // could move it, the plan would chase reality and slippage would always
        // read zero — the same self-healing trap the week bucketing avoids.
        const expectedReceiveDate = (existingLeg && existingLeg.expectedReceiveDate)
          || po.expectedReceiveDate || null;

        // E-DEL is DERIVED: arriving at the DC is the receive date minus the
        // `receiving` transit standard (5 days, equal for sea and air today).
        // Reading it from master data rather than hardcoding 5 keeps this the
        // exact inverse of the report's `expectedAta = eDel + 5`, so editing the
        // standard corrects both ends at once.
        const recvDays = receivingDays.get(modeId);
        const eDel = (existingLeg && existingLeg.eDel)
          || addDays(expectedReceiveDate, -(recvDays == null ? DEFAULT_RECEIVING_DAYS : recvDays));

        legs.set(legId, {
          id:         legId,
          poNumber:   po.poNumber,
          modeId,
          incotermId: resolvers.incotermId(po.incoterm, po.poNumber)
            ?? (existingLeg ? existingLeg.incotermId : null),
          crd:        po.crd || (existingLeg && existingLeg.crd) || null,   // custbody46
          hod:        po.hod || (existingLeg && existingLeg.hod) || null,   // custbody8
          expectedReceiveDate,                                              // duedate — frozen
          eDel,                                                             // derived — frozen
          // v2 does not carry etdPol. The real one lives on the SHIPMENT and
          // drives the transit segments; the leg's was never populated (0/87).
          etdPol:     null,
          source:     'netsuite',
        });
        legUpsert++;

        // --- the leg's SKU allocation --------------------------------------
        // With 1 PO = 1 leg the allocation IS the order line, but the report,
        // forecast and three-way match all read mainline_po_leg_lines — so a leg
        // without them contributes ZERO units and the PO is invisible. Mirroring
        // them here is what keeps all 26 leg-aware files working untouched.
        //
        // ⚠️ AGGREGATED BY SKU, not copied per line. NetSuite repeats a SKU
        // across PO lines (PO04826 does it 399 times), and the leg allocation is
        // per SKU — copying 1:1 would collide on the `mll_<leg>_<sku>` id and
        // double-count the quantity.
        const bySku = new Map();
        for (const li of po.line_items || []) {
          if (!li.skuCode) continue;
          bySku.set(li.skuCode, (bySku.get(li.skuCode) || 0) + (Number(li.expectedQty) || 0));
          // Seed the master with anything it has not seen. Fills only — never
          // clobbers richer NetSuite/migration-sourced attributes.
          if (!skus.has(li.skuCode)) {
            // Same shape the WIP import seeds (upsertSkus). The SKU's
            // descriptive attributes (gender/category/composition/upc) arrive
            // separately via SKU_ATTR_COLUMNS when those custom fields are
            // configured — this only has to satisfy the FK and name the item.
            skus.set(li.skuCode, {
              skuCode:     li.skuCode,
              styleColor:  null,
              itemName:    li.description || null,
              description: li.description || null,
              colorway:    null,
              size:        li.size || null,
              htsCode:     null,
              unitPrice:   Number(li.unitPrice) || null,
              upc:         li.upc || null,
              knitWoven:   li.knitWoven || null,
              category:    li.category || null,
              gender:      li.gender || null,
              composition: li.composition || null,
            });
            skusAdded++;
          }
        }
        legLinesByLeg[legId] = [...bySku.entries()].map(([skuCode, allocatedQty]) => ({
          id: `mll_${legId}_${skuCode}`,
          legId,
          skuCode,
          allocatedQty,
        }));
      }
    }

    // --- po_order_lines (replace this PO's lines) ---
    //
    // ⚠️ THE KEY IS (poNumber, netsuiteLineId), NOT (poNumber, skuCode).
    // NetSuite legitimately repeats one item across several PO lines — split by
    // receipt date/location, or a price correction. PO04826 does it for 399 SKUs.
    // The old `(po_number, sku_code)` unique held only because every PO so far
    // happened to have one line per item; the moment one did not, every sync
    // aborted. Same class of bug as sms_po_lines, which CLAUDE.md already
    // documents — and this is the table it warned not to copy the rule to.
    //
    // ⚠️ `netsuiteLineId` IS A PER-PO SEQUENCE (1, 2, 3…), NOT a global id.
    // Measured on live data: 4,096 line rows carry only 804 distinct values, so
    // an id of `pol_ns_<lineId>` would collapse 4,096 rows onto 804 — exactly
    // the mistake made on the SMS side. It IS unique WITHIN a PO (0 repeats
    // across all 22), so the PO number has to be part of both the id and the key.
    linesByPo[po.poNumber] = (po.line_items || []).map((li, i) => ({
      // Stable across syncs: the same NetSuite line keeps the same row id, so
      // this table stops renumbering ~12k rows on every run. Falls back to the
      // array position only if NetSuite omits the line id.
      id:             `pol_ns_${po.poNumber}_${li.netsuiteLineId || `i${i}`}`,
      poNumber:       po.poNumber,
      netsuiteLineId: li.netsuiteLineId ? String(li.netsuiteLineId) : null,
      skuCode:        li.skuCode,
      orderedQty:     Number(li.expectedQty) || 0,
      unitPrice:      Number(li.unitPrice) || null,
    }));
    lUpsert += linesByPo[po.poNumber].length;
  }

  return {
    masters:    [...masters.values()],
    orders:     [...orders.values()],
    orderLines: Object.values(linesByPo).flat(),
    legs:       [...legs.values()],
    legLines:   Object.values(legLinesByLeg).flat(),
    skus:       [...skus.values()],
    stats: {
      masters_upserted: mUpsert, orders_upserted: oUpsert, lines_upserted: lUpsert,
      legs_upserted: legUpsert, legs_skipped_wip_owned: legsSkippedV1, skus_added: skusAdded,
      protected: protectedPos, rejected_skipped: rejectedPos,
    },
  };
}

// NetSuite says this PO was rejected. Read from the display value the header query
// already selects (`BUILTIN.DF(t.approvalstatus) AS approvalStatus`) — the numeric
// code never reaches this layer.
function isRejected(po) {
  return String(po?.approvalStatus || '').trim().toLowerCase() === 'rejected';
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
function pruneRejected({ rejectedPoNumbers, masters, orders, orderLines, legs, legLines, referencedPoNumbers }) {
  const rejected = rejectedPoNumbers instanceof Set ? rejectedPoNumbers : new Set(rejectedPoNumbers || []);
  const referenced = referencedPoNumbers instanceof Set ? referencedPoNumbers : new Set(referencedPoNumbers || []);

  const removable = orders.filter((o) => rejected.has(o.poNumber) && !referenced.has(o.poNumber)).map((o) => o.poNumber);
  const keptReferenced = orders.filter((o) => rejected.has(o.poNumber) && referenced.has(o.poNumber)).map((o) => o.poNumber);
  const removeSet = new Set(removable);

  const nextOrders = orders.filter((o) => !removeSet.has(o.poNumber));
  const nextLines = orderLines.filter((l) => !removeSet.has(l.poNumber));
  // A v2 leg hangs off the PO, and mainline_po_legs.poNumber is a deferred FK to
  // po_orders — leaving one behind would fail the whole sync at COMMIT.
  const nextLegs = (legs || []).filter((l) => !removeSet.has(l.poNumber));
  const goneLegIds = new Set((legs || []).filter((l) => removeSet.has(l.poNumber)).map((l) => l.id));
  const nextLegLines = (legLines || []).filter((l) => !goneLegIds.has(l.legId));
  const survivingTrns = new Set(nextOrders.map((o) => o.trnNumber).filter(Boolean));
  const orphanedTrns = [...new Set(orders.filter((o) => removeSet.has(o.poNumber)).map((o) => o.trnNumber).filter(Boolean))]
    .filter((trn) => !survivingTrns.has(trn));
  const orphanSet = new Set(orphanedTrns);
  const nextMasters = masters.filter((m) => !orphanSet.has(m.trnNumber));

  return {
    masters: nextMasters,
    orders: nextOrders,
    orderLines: nextLines,
    removed: {
      poNumbers: removable,
      orders: orders.length - nextOrders.length,
      lines: orderLines.length - nextLines.length,
      legs: (legs || []).length - nextLegs.length,
      masters: masters.length - nextMasters.length,
      trns: orphanedTrns,
    },
    kept_referenced: keptReferenced,
  };
}

// ---- locked-set helpers (R1) ------------------------------------------------
/**
 * Every poNumber something in the portal points at: a WIP leg, a booking, a
 * shipment or an Item Receipt. Wider than computeLocked() on purpose — that one
 * answers "may sync overwrite this?", this one answers "may sync DELETE this?",
 * and a leg with no booking yet is still a portal row that must not be orphaned.
 */
async function computeReferenced() {
  const [legs, bookingLegs, shipmentLegs, receipts] = await Promise.all([
    models.mainline_po_legs.read(),
    models.mainline_booking_po_legs.read(),
    models.mainline_shipment_legs.read(),
    models.mainline_item_receipts.read().catch(() => []),
  ]);
  const referenced = new Set();
  const poByLeg = new Map(legs.map((l) => [l.id, l.poNumber]));
  // ⚠️ A leg the SYNC created is not evidence of anything. Under v2 every PO
  // gets one automatically, so counting it here would make every PO permanently
  // "referenced" and R4 could never prune a rejected one. Only a leg a HUMAN
  // produced (the WIP split) means someone committed to this PO — bookings,
  // shipments and receipts below still count either way.
  legs.forEach((l) => {
    if (l.poNumber && l.source !== 'netsuite') referenced.add(l.poNumber);
  });
  [...bookingLegs, ...shipmentLegs].forEach((r) => {
    const po = poByLeg.get(r.legId);
    if (po) referenced.add(po);
  });
  receipts.forEach((r) => { if (r.poNumber) referenced.add(r.poNumber); });
  return referenced;
}

async function computeLocked() {
  const [legs, bookingLegs, shipments] = await Promise.all([
    models.mainline_po_legs.read(),
    models.mainline_booking_po_legs.read(),
    models.mainline_shipments.read(),
  ]);
  const poByLeg = new Map(legs.map((l) => [l.id, l.poNumber]));
  const lockedPoNumbers = new Set();
  [...bookingLegs, ...shipments].forEach((r) => {
    const po = poByLeg.get(r.legId);
    if (po) lockedPoNumbers.add(po);
  });
  return lockedPoNumbers;
}

// ---- IO entrypoint ----------------------------------------------------------
// Fold NetSuite Item Receipts into mainline_item_receipts/_lines. Keyed on
// netsuiteIrId (idempotent); read-only from NS (no portal-owned fields).
// A receipt attaches to its source poNumber; received qty is derived from the lines.
function foldReceipts(nsReceipts, existingReceipts, existingLines, queriedPoNumbers = null) {
  const byIr = new Map(existingReceipts.filter((r) => r.netsuiteIrId).map((r) => [r.netsuiteIrId, r]));
  let irSeq = existingReceipts.reduce((mx, r) => Math.max(mx, +String(r.id).replace(/\D/g, '') || 0), 0);
  const outReceipts = [...existingReceipts];
  let outLines = [...existingLines];
  for (const ir of nsReceipts) {
    if (!ir.poNumber) continue;
    let r = byIr.get(ir.ir_id);
    if (!r) {
      r = { id: `mir_${++irSeq}`, netsuiteIrId: ir.ir_id, netsuiteIrTranid: ir.ir_tranid || null,
        poNumber: ir.poNumber, receiptDate: ir.receiptDate || null, source: 'netsuite',
        // portal-owned landed-cost match (confirmed per-PO IR ↔ shipment) — see
        // mainlineReceiptController; preserved across re-sync, never touched here.
        matchedShipmentId: null, confirmedBy: null, confirmedAt: null };
      outReceipts.push(r); byIr.set(ir.ir_id, r);
    } else {
      r.poNumber = ir.poNumber;                       // refresh NS facts only;
      r.netsuiteIrTranid = ir.ir_tranid || r.netsuiteIrTranid;   // NEVER touch the
      r.receiptDate = ir.receiptDate || r.receiptDate;             // matched_* columns
    }
    outLines = outLines.filter((l) => l.receiptId !== r.id);
    (ir.lines || []).forEach((l, i) => outLines.push({ id: `mirl_${r.id.replace(/\D/g, '')}_${i + 1}`, receiptId: r.id, skuCode: l.skuCode, qty: l.qty }));
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

  const [masters, orders, orderLines, existingLegs, existingLegLines, existingSkus, transitStds, resolvers, lockedPoNumbers] = await Promise.all([
    models.po_masters.read(), models.po_orders.read(), models.po_order_lines.read(),
    models.mainline_po_legs.read(),
    models.mainline_po_leg_lines.read(),
    models.product_skus.read(),
    models.transit_time_standards.read().catch(() => []),
    loadResolvers(), computeLocked(),
  ]);
  // modeId -> days for the `receiving` segment (E-DEL -> booked into NetSuite).
  // Master data, so editing it corrects every derived E-DEL on the next sync.
  const receivingDays = new Map(
    transitStds.filter((s) => s.segment === 'receiving').map((s) => [s.modeId, Number(s.days)]),
  );
  if (fetchError) {
    return { masters_upserted: 0, orders_upserted: 0, lines_upserted: 0, protected: [], warnings: [], fetched: 0, fetch_error: fetchError };
  }
  const lockedTrns = new Set(orders.filter((o) => lockedPoNumbers.has(o.poNumber)).map((o) => o.trnNumber));

  const result = buildUpserts(
    pos,
    { masters, orders, orderLines, legs: existingLegs, legLines: existingLegLines, skus: existingSkus },
    { resolvers, lockedPoNumbers, lockedTrns, receivingDays },
  );

  // Rejected POs the portal is ALREADY holding. The pull can't surface these —
  // they're out of scope by definition — so ask NetSuite about what we hold and
  // drop what it has rejected. Runs before the netsuiteId backfill so we don't
  // resolve ids for rows about to go. Never fails the sync.
  let rejected_removed = { poNumbers: [], orders: 0, lines: 0, masters: 0, trns: [] };
  let rejected_kept_referenced = [];
  let approval_refreshed = 0;
  try {
    const held = result.orders.map((o) => o.poNumber).filter(Boolean);
    // One query answers both: which held POs are rejected (prune) and what each
    // one's approval status is NOW (the badge). A PO that has left the A/B pull
    // scope — approved and received since — still gets its value corrected here.
    const statuses = await integrationService.fetchPoApprovalStatuses(held);
    result.orders.forEach((o) => {
      const ns = statuses.get(o.poNumber);
      if (ns && ns.approval !== o.approvalStatus) { o.approvalStatus = ns.approval; approval_refreshed++; }
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
      result.legs = p.legs;
      result.legLines = p.legLines;
      rejected_removed = p.removed;
      rejected_kept_referenced = p.kept_referenced;
      if (p.removed.poNumbers.length) console.log(`[PO sync] removed rejected PO(s): ${p.removed.poNumbers.join(', ')}`);
      if (p.kept_referenced.length) console.warn(`[PO sync] rejected but REFERENCED, left in place for review: ${p.kept_referenced.join(', ')}`);
    }
  } catch (e) {
    console.error('[PO sync] approval refresh / rejected-PO prune skipped:', e.message);
  }

  // Backfill NS internal ids for po_orders the active pull didn't return (received/
  // closed POs, D..H) by resolving their tranid → id. Lets received qty work for
  // those WITHOUT widening the PO pull (no new POs enter the list). Best-effort.
  try {
    const missing = result.orders.filter((o) => o.poNumber && !o.netsuiteId).map((o) => o.poNumber);
    if (missing.length) {
      const idByTranid = await integrationService.fetchPoIdsByTranid(missing);
      result.orders.forEach((o) => { if (!o.netsuiteId && idByTranid[o.poNumber]) o.netsuiteId = idByTranid[o.poNumber]; });
    }
  } catch (e) {
    console.error('[PO sync] netsuiteId backfill failed:', e.message);
  }

  await Promise.all([
    models.po_masters.write(result.masters),
    models.po_orders.write(result.orders),
    models.po_order_lines.write(result.orderLines),
    // v2 legs. FW26/WIP-owned rows pass through untouched — buildUpserts seeds
    // this from the existing table and only adds/refreshes `source:'netsuite'`.
    models.mainline_po_legs.write(result.legs),
    models.product_skus.write(result.skus),
    models.mainline_po_leg_lines.write(result.legLines),
  ]);

  // Item Receipts (received qty) — read-only, scoped to the mainline POs we hold
  // internal ids for. A PO keeps its netsuiteId after it leaves the active window,
  // so its later receipts keep syncing. Never fails the PO sync (degrades to skip).
  let receipts_upserted = 0;
  let receipts_removed = [];
  try {
    // Scope = every held PO we have an internal id for; that is exactly what the
    // receipt query asks about, so it is also exactly what the fold may prune.
    const scoped = result.orders.filter((o) => o.netsuiteId && o.poNumber);
    const poIds = scoped.map((o) => o.netsuiteId);
    if (poIds.length) {
      const nsReceipts = await integrationService.fetchNetSuiteItemReceipts(poIds);
      const [exR, exL] = await Promise.all([
        models.mainline_item_receipts.read(),
        models.mainline_item_receipt_lines.read(),
      ]);
      const folded = foldReceipts(nsReceipts, exR, exL, new Set(scoped.map((o) => o.poNumber)));
      await Promise.all([
        models.mainline_item_receipts.write(folded.receipts),
        models.mainline_item_receipt_lines.write(folded.receiptLines),
      ]);
      receipts_upserted = nsReceipts.length;
      receipts_removed = folded.removed;
      folded.removed.forEach((r) => console.warn(
        `[PO sync] receipt ${r.ir} (${r.poNumber}) no longer exists in NetSuite — removed${r.was_confirmed ? ' (carried a CONFIRMED match)' : ''}`,
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
