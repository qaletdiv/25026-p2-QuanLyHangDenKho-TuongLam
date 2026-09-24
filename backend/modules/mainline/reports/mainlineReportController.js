'use strict';

// GET /reports/mainline — the season KPI report, computed at the PO-LEG grain.
//
// Every mainline_po_leg appears (not just shipped ones): the report is the full
// season order book. Each leg's expected qty is split across mutually-exclusive
// rows so the grand total reconciles to the season total (qty counted exactly once):
//
//   1. shipment rows   — one per shipment↔leg junction (actual dates/status);
//   2. pending-booking rows — legs on a "Booking Pending" booking (no shipment yet);
//   3. an "Awaiting Booking" remainder row — expected qty not covered by 1–2.
//
// Three orthogonal axes per row:
//   • stage        — WHERE the qty is: Awaiting Booking → Booking Pending → the
//                    shipment pipeline (Ready to Ship … Received). This is the
//                    "why" axis: late qty with stage=Awaiting Booking is late
//                    because nobody booked it.
//   • timeliness   — On Time / At Risk / Late, graded from the best-known E-DEL
//                    vs the season production schedule. Shipment rows grade the
//                    shipment's E-DEL (dateBasis 'actual'); pre-shipment rows
//                    grade the leg's WIP-projected E-DEL (dateBasis 'projected').
//                    Unbooked legs also cross-check achievability: if CRD + the
//                    standard transit time (transit_time_standards) lands LATER
//                    than the stated E-DEL, the later date is graded.
//   • kpiStatus   — the flattened cascade the manager's tables pivot on:
//                    Received (actual ATA known) → Delivered → timeliness. ATA is
//                    DERIVED from NetSuite Item Receipts (receipts/ataLoader), the
//                    same source the shipment list and transit report use — not the
//                    hand-entered `ata` column, which is set on almost nothing.
//
// `reason` is a human-readable explanation of the grade (cutoff comparison, the
// not-booked/not-approved state, the slipped transit segment, achievability).
// All of this is DERIVED at read-time — nothing is stored.

const { models } = require('../../../models');
const status = require('../statuses');
const transit = require('./transitTimeService');
const { loadAtaByShipment, effectiveAta } = require('../receipts/ataLoader');

const read = (f) => models[f].read().catch(() => []);
const readM = read;

// E-DEL vs the season's cutoffs. ISO date strings compare lexicographically.
function timelinessFor(eDel, sched) {
  if (!eDel || !sched || !sched.ontimeBy || !sched.atriskBy) return 'Unknown';
  if (eDel <= sched.ontimeBy) return 'On Time';
  if (eDel <= sched.atriskBy) return 'At Risk';
  return 'Late';
}

// The grading explanation shared by every row's reason string.
function timelinessClause(eDel, sched, tl) {
  if (tl === 'On Time') return `E-DEL ${eDel} within on-time cutoff ${sched.ontimeBy}`;
  if (tl === 'At Risk') return `E-DEL ${eDel} past on-time cutoff ${sched.ontimeBy} (at-risk until ${sched.atriskBy})`;
  if (tl === 'Late')    return `E-DEL ${eDel} past at-risk cutoff ${sched.atriskBy}`;
  return eDel ? 'no production schedule for this season' : 'no E-DEL available';
}

// The flattened, mutually-exclusive KPI bucket (qty counted once, tables
// reconcile to Grand Total).
function kpiStatusFor(ata, progress, tl) {
  if (ata) return 'Received';
  if (progress === 'Delivered') return 'Delivered';
  return tl;   // On Time / At Risk / Late / Unknown
}

// Wholesale = Reserved channel, Ecomm = First channel.
const SEGMENT = { Reserved: 'WS', First: 'EC' };

async function loadJoins() {
  const [legs, legLines, orders, masters, seasons, facilities, channels, schedules,
         bookings, bookingLegs, shipments, shipLegs, suppliers, modes, standards] = await Promise.all([
    readM('mainline_po_legs'), readM('mainline_po_leg_lines'), readM('po_orders'), readM('po_masters'),
    readM('seasons'), readM('warehouse_facilities'), readM('allocation_channels'), readM('production_schedules'),
    readM('mainline_bookings'), readM('mainline_booking_po_legs'),
    readM('mainline_shipments'), readM('mainline_shipment_legs'),
    read('suppliers'), read('modes'), transit.getStandards(),
  ]);
  return { legs, legLines, orders, masters, seasons, facilities, channels, schedules,
           bookings, bookingLegs, shipments, shipLegs, suppliers, modes, standards };
}

async function getMainlineReport(req, res) {
  const d = await loadJoins();

  const orderByPo     = new Map(d.orders.map((o) => [o.poNumber, o]));
  const masterByTrn   = new Map(d.masters.map((m) => [m.trnNumber, m]));
  const seasonCode    = new Map(d.seasons.map((s) => [s.id, s.code]));
  const facName       = new Map(d.facilities.map((f) => [f.id, f.name]));
  const chanName      = new Map(d.channels.map((c) => [c.id, c.name]));
  const supName       = new Map(d.suppliers.map((s) => [s.id, s.name]));
  const modeName      = new Map(d.modes.map((m) => [m.id, m.name]));
  const schedBySeason = new Map(d.schedules.map((p) => [p.seasonId, p]));
  const shipById      = new Map(d.shipments.map((s) => [s.id, s]));
  const bookingById   = new Map(d.bookings.map((b) => [b.id, b]));
  const stdByMode     = transit.standardsByMode(d.standards);

  const qtyByLeg = d.legLines.reduce((m, l) => m.set(l.legId, (m.get(l.legId) || 0) + (Number(l.allocatedQty) || 0)), new Map());
  const shipLegsByLeg = d.shipLegs.reduce((m, j) => { (m[j.legId] = m[j.legId] || []).push(j); return m; }, {});
  const bookLegsByLeg = d.bookingLegs.reduce((m, j) => { (m[j.legId] = m[j.legId] || []).push(j); return m; }, {});

  // statusId → name (shipment progress pipeline + booking statuses)
  const statusName = new Map();
  const statusIds = new Set([
    ...d.shipments.map((s) => s.statusId),
    ...d.bookings.map((b) => b.bookingStatusId),
  ]);
  await Promise.all([...statusIds].map(async (id) => statusName.set(id, await status.nameForId(id))));

  // Pre-compute per-shipment transit facts: earliest CRD across its legs, the
  // effective ATA, per-segment durations, and segments that ran over their standard.
  //
  // ATA is the arrival date the whole `kpiStatus` cascade turns on ("Received"
  // beats every timeliness grade), and it is DERIVED from NetSuite Item Receipts by
  // the shared resolver — not read off the header column, which is a manual
  // stopgap set on 1 of 9 live shipments. Reading the column made 8 received
  // consignments report as still in flight, and graded them on E-DEL as if their
  // arrival were still a question.
  const legById = new Map(d.legs.map((l) => [l.id, l]));
  const ataMatch = await loadAtaByShipment({ shipments: d.shipments, shipLegs: d.shipLegs, legs: d.legs });
  const shipFacts = new Map(d.shipments.map((s) => {
    const crds = (d.shipLegs.filter((j) => j.shipmentId === s.id))
      .map((j) => (legById.get(j.legId) || {}).crd).filter(Boolean).sort();
    const crd = crds[0] || null;
    const { ata, ataSource } = effectiveAta(ataMatch, s);
    // the E-DEL → ATA segment is graded off the effective date too, so a slipped
    // "DC → NetSuite Receive" can actually surface in a row's reason
    const durations = transit.segmentDurations({ ...s, ata }, crd);
    return [s.id, { crd, ata, ataSource, durations, slipped: transit.slippedSegments(durations, s.modeId, stdByMode) }];
  }));

  const rows = [];

  for (const leg of d.legs) {
    const order  = orderByPo.get(leg.poNumber) || {};
    const master = masterByTrn.get(order.trnNumber) || {};
    const seasonId = master.seasonId || null;
    const sched    = schedBySeason.get(seasonId) || null;
    const channel  = chanName.get(order.allocationChannelId) || null;

    const base = {
      legId:      leg.id,
      poNumber:   leg.poNumber || null,
      trnNumber:  order.trnNumber || null,
      supplier:    supName.get(master.supplierId) || null,
      season:      seasonCode.get(seasonId) || null,
      channel,
      segment:     channel ? (SEGMENT[channel] || null) : null,   // WS / EC
      crd:         leg.crd || null,
    };
    const legQty = qtyByLeg.get(leg.id) || 0;
    let counted = 0;

    // 1 — shipment rows (actual)
    for (const j of shipLegsByLeg[leg.id] || []) {
      const ship  = shipById.get(j.shipmentId) || {};
      // A CANCELLED consignment is not an actual. It used to emit a row here with
      // stage 'Cancelled', graded on the timeliness cascade and counted in the
      // order book as though it were still coming. Its units are picked up by step
      // 2b below, which says what they really are: booked, not shipped.
      if (statusName.get(ship.statusId) === 'Cancelled') continue;
      const facts = shipFacts.get(j.shipmentId) || { slipped: [], ata: null, ataSource: null };
      const qty   = Number(j.expectedQuantity) || 0;
      counted += qty;
      const progress   = statusName.get(ship.statusId) || null;
      const timeliness = timelinessFor(ship.eDel, sched);
      const ata        = facts.ata;   // derived (Item Receipt) → header column, see shipFacts

      let reason;
      if (ata) {
        const lateBy = transit.daysBetween(transit.addDays(ship.eDel, 5), ata);
        reason = `Received ${ata}` + (lateBy != null ? (lateBy > 0 ? ` — ${lateBy}d after expected ATA` : ' — within expected ATA') : '');
      } else {
        reason = `${progress || 'Shipped'} on ${ship.shipmentNumber || j.shipmentId} — ${timelinessClause(ship.eDel, sched, timeliness)}`;
        const worst = facts.slipped[0];
        if (worst && (timeliness === 'Late' || timeliness === 'At Risk')) {
          reason += `; ${worst.label} took ${worst.actual}d vs ${worst.standard}d standard`;
        }
      }

      rows.push({
        ...base,
        rowId:          `${leg.id}|ship|${j.shipmentId}`,
        shipmentId:     j.shipmentId,
        shipmentNumber: ship.shipmentNumber || null,
        bookingId:      ship.bookingId || null,
        bookingNumber:  (bookingById.get(ship.bookingId) || {}).bookingNumber || null,
        facility:        facName.get(ship.facilityId) || facName.get(order.facilityId) || null,
        modeId:         ship.modeId || leg.modeId || null,
        mode:            modeName.get(ship.modeId || leg.modeId) || null,
        qty,
        stage:           progress,
        progressStatus: progress,
        dateBasis:      'actual',
        eDel:           ship.eDel || null,
        expectedAta:    transit.addDays(ship.eDel, 5),   // derived, never stored
        ata,
        ataSource:      facts.ataSource,
        timeliness,
        kpiStatus:      kpiStatusFor(ata, progress, timeliness),
        reason,
      });
    }

    // 2 — pending-booking rows (projected; approved bookings are covered by their shipments)
    for (const bl of bookLegsByLeg[leg.id] || []) {
      const booking = bookingById.get(bl.bookingId) || {};
      if (statusName.get(booking.bookingStatusId) !== 'Booking Pending') continue;
      const qty = Number(bl.units) || Math.max(0, legQty - counted);
      if (qty <= 0) continue;
      counted += qty;
      const timeliness = timelinessFor(leg.eDel, sched);

      rows.push({
        ...base,
        rowId:          `${leg.id}|bkg|${bl.bookingId}`,
        shipmentId:     null,
        shipmentNumber: null,
        bookingId:      bl.bookingId,
        bookingNumber:  booking.bookingNumber || null,
        facility:        facName.get(order.facilityId) || null,
        modeId:         leg.modeId || null,
        mode:            modeName.get(leg.modeId) || null,
        qty,
        stage:           'Booking Pending',
        progressStatus: null,
        dateBasis:      'projected',
        eDel:           leg.eDel || null,
        expectedAta:    transit.addDays(leg.eDel, 5),
        ata:             null,
        timeliness,
        kpiStatus:      timeliness,
        reason:          `Booking ${booking.bookingNumber || bl.bookingId} awaiting approval — ${timelinessClause(leg.eDel, sched, timeliness)}`,
      });
    }

    // 2b — BOOKED — NOT SHIPPED: an approved booking whose consignment was
    // cancelled. One rung above Booking Pending (a supervisor has signed it off)
    // and below In Transit (nothing is moving), so it sits between them. Graded
    // like the pending row, on the LEG's E-DEL: the cancelled shipment's own dates
    // described a sailing that is not happening.
    for (const j of shipLegsByLeg[leg.id] || []) {
      const ship = shipById.get(j.shipmentId) || {};
      if (statusName.get(ship.statusId) !== 'Cancelled') continue;
      const booking = bookingById.get(ship.bookingId) || {};
      // Only while the BOOKING still stands. Cancel that too and the units are
      // genuinely unbooked again — step 3 picks them up.
      if (statusName.get(booking.bookingStatusId) !== 'Booking Approved') continue;
      const qty = Math.min(Number(j.expectedQuantity) || 0, Math.max(0, legQty - counted));
      if (qty <= 0) continue;
      counted += qty;
      const timeliness = timelinessFor(leg.eDel, sched);

      rows.push({
        ...base,
        rowId:          `${leg.id}|unshipped|${j.shipmentId}`,
        shipmentId:     null,
        shipmentNumber: null,
        bookingId:      ship.bookingId || null,
        bookingNumber:  booking.bookingNumber || null,
        facility:        facName.get(order.facilityId) || null,
        modeId:         leg.modeId || null,
        mode:            modeName.get(leg.modeId) || null,
        qty,
        stage:           'Booked — Not Shipped',
        progressStatus: null,
        dateBasis:      'projected',
        eDel:           leg.eDel || null,
        expectedAta:    transit.addDays(leg.eDel, 5),
        ata:             null,
        timeliness,
        kpiStatus:      timeliness,
        reason:          `Consignment ${ship.shipmentNumber || j.shipmentId} was cancelled — booking ${booking.bookingNumber || ship.bookingId} still authorizes these units; ${timelinessClause(leg.eDel, sched, timeliness)}`,
      });
    }

    // 3 — Awaiting Booking remainder (projected + achievability cross-check)
    const rem = legQty - counted;
    if (rem > 0) {
      const stated  = leg.eDel || null;
      const transitEDel = transit.projectedEDel(leg.crd, leg.modeId, stdByMode);
      // grade the later (worse) of the stated E-DEL and what standard transit allows
      const graded = [stated, transitEDel].filter(Boolean).sort().pop() || null;
      const timeliness = timelinessFor(graded, sched);

      let reason = `Not booked yet — ${timelinessClause(graded, sched, timeliness)}`;
      if (stated && transitEDel && transitEDel > stated) {
        const stdDays = transit.standardPreDeliveryDays(leg.modeId, stdByMode);
        reason = `Not booked yet — stated E-DEL ${stated} not achievable from CRD ${leg.crd} + ${stdDays}d standard ${modeName.get(leg.modeId) || ''} transit (earliest ${transitEDel}); ${timelinessClause(graded, sched, timeliness)}`;
      }

      rows.push({
        ...base,
        rowId:          `${leg.id}|awaiting`,
        shipmentId:     null,
        shipmentNumber: null,
        bookingId:      null,
        bookingNumber:  null,
        facility:        facName.get(order.facilityId) || null,
        modeId:         leg.modeId || null,
        mode:            modeName.get(leg.modeId) || null,
        qty:             rem,
        stage:           'Awaiting Booking',
        progressStatus: null,
        dateBasis:      'projected',
        eDel:           graded,
        expectedAta:    transit.addDays(graded, 5),
        ata:             null,
        timeliness,
        kpiStatus:      timeliness,
        reason,
      });
    }
  }

  res.json(rows);
}

// GET /reports/mainline/transit-times — actual segment durations vs the standards,
// aggregated per LANE (supplier × country of origin × departure port × mode) plus
// the per-mode and per-shipment breakdowns. Everything derived at read-time.
async function getTransitTimes(req, res) {
  const [shipments, shipLegs, legs, modes, standards, bookings, suppliers, ports, orders] = await Promise.all([
    readM('mainline_shipments'), readM('mainline_shipment_legs'), readM('mainline_po_legs'),
    read('modes'), transit.getStandards(), readM('mainline_bookings'),
    read('suppliers'), readM('ports'), readM('po_orders'),
  ]);
  const legById    = new Map(legs.map((l) => [l.id, l]));
  const modeNameOf = new Map(modes.map((m) => [m.id, m.name]));
  const bookingById = new Map(bookings.map((b) => [b.id, b]));
  const supName    = new Map(suppliers.map((s) => [s.id, s.name]));
  const portName   = new Map(ports.map((p) => [p.id, p.code ? `${p.name} (${p.code})` : p.name]));
  const orderByPo  = new Map(orders.map((o) => [o.poNumber, o]));
  const stdByMode  = transit.standardsByMode(standards);

  // ATA = the day the goods landed in NetSuite, DERIVED from Item Receipts by the
  // one shared resolver — the same call mainlineShipmentService makes, so the
  // report and the shipment list can never disagree about when a consignment
  // arrived. Without it this report read the raw `ata` COLUMN, which is a manual
  // back-fill and is set on 1 of 9 shipments, so `DC → NetSuite Receive` and
  // `CRD → ATA` were blank on everything that had in fact been received.
  // Precedence and source labelling live in effectiveAta (one rule, all consumers).
  const ataMatch = await loadAtaByShipment({ shipments, shipLegs, legs });

  const shipmentRows = shipments.map((s) => {
    const myLegs = shipLegs.filter((j) => j.shipmentId === s.id).map((j) => legById.get(j.legId) || {});
    const crd = myLegs.map((l) => l.crd).filter(Boolean).sort()[0] || null;
    const coo = [...new Set(myLegs.map((l) => (orderByPo.get(l.poNumber) || {}).cooCountry).filter(Boolean))].join(', ') || null;
    const { ata, ataSource } = effectiveAta(ataMatch, s);
    // Both remaining segments hang off ATA, so they are computed from the EFFECTIVE
    // date, not the column.
    const durations = transit.segmentDurations({ ...s, ata }, crd);
    return {
      shipmentId:     s.id,
      shipmentNumber: s.shipmentNumber || null,
      bookingNumber:  (bookingById.get(s.bookingId) || {}).bookingNumber || null,
      supplierName:   supName.get((bookingById.get(s.bookingId) || {}).supplierId) || null,
      coo,
      polPort:        portName.get(s.polPortId) || null,
      modeId:         s.modeId || null,
      mode:            modeNameOf.get(s.modeId) || null,
      crd,
      cargoReceivedDate: s.cargoReceivedDate || null,
      etdPol: s.etdPol || null, etaPod: s.etaPod || null,
      eDel: s.eDel || null,
      ata,
      // 'manual' = typed on the shipment header, 'netsuite' = attributed Item
      // Receipt(s). Shown in the CRD → ATA tooltip so a reader can tell which
      // arrival date a duration was measured to.
      ataSource,
      durations,
      // end-to-end CRD → ATA, same yardstick as the lane row's `total` (NOT Σ
      // durations — a missing intermediate date nulls its segments while the
      // end-to-end span is still known).
      totalDays: transit.daysBetween(crd, ata),
      slipped: transit.slippedSegments(durations, s.modeId, stdByMode),
    };
  });

  // lane aggregates: supplier × COO × departure port × mode (mode kept in the key —
  // an Air and a Sea shipment on the same lane must not average together)
  const laneMap = new Map();
  for (const r of shipmentRows) {
    const key = [r.supplierName, r.coo, r.polPort, r.modeId].join('|');
    if (!laneMap.has(key)) laneMap.set(key, { supplierName: r.supplierName, coo: r.coo, polPort: r.polPort, modeId: r.modeId, mode: r.mode, rows: [] });
    laneMap.get(key).rows.push(r);
  }
  const stats = (all, invalidSegments, key) => {
    // negative duration = dates entered out of order → excluded from the average,
    // surfaced via invalidSegments so the UI can flag the cell instead
    const vals = all.filter((v) => v >= 0);
    if (all.length > vals.length) invalidSegments.push(key);
    return vals.length
      ? { avg: Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 10) / 10, min: Math.min(...vals), max: Math.max(...vals), n: vals.length }
      : null;
  };
  const lanes = [...laneMap.values()].map((lane) => {
    const segments = {};
    const invalidSegments = [];
    transit.SEGMENTS.forEach((seg) => {
      const all = lane.rows.map((r) => r.durations[seg.key]).filter((v) => v != null);
      segments[seg.key] = stats(all, invalidSegments, seg.key);
    });
    // end-to-end CRD → ATA (door to received-in-system)
    const total = stats(lane.rows.map((r) => transit.daysBetween(r.crd, r.ata)).filter((v) => v != null), invalidSegments, 'total');
    return {
      total,
      supplierName: lane.supplierName, coo: lane.coo, polPort: lane.polPort,
      modeId: lane.modeId, mode: lane.mode,
      sampleCount: lane.rows.length,
      segments,
      invalidSegments,
      standard: stdByMode.get(lane.modeId) || {},
    };
  }).sort((a, b) => (a.supplierName || '~').localeCompare(b.supplierName || '~') || (a.coo || '').localeCompare(b.coo || ''));

  // per-mode aggregates: every mode with standards or shipments
  const modeIds = [...new Set([...stdByMode.keys(), ...shipments.map((s) => s.modeId).filter(Boolean)])];
  const modeRows = modeIds.map((modeId) => {
    const mine = shipmentRows.filter((r) => r.modeId === modeId);
    const std  = stdByMode.get(modeId) || {};
    const actual = {};
    transit.SEGMENTS.forEach((seg) => {
      // negatives (dates out of order) are excluded — they'd make a lane look fast
      const vals = mine.map((r) => r.durations[seg.key]).filter((v) => v != null && v >= 0);
      actual[seg.key] = vals.length
        ? { avg: Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 10) / 10, min: Math.min(...vals), max: Math.max(...vals), n: vals.length }
        : null;
    });
    const totals = mine.map((r) => transit.daysBetween(r.crd, r.eDel)).filter((v) => v != null && v >= 0);
    return {
      modeId: modeId,
      mode: modeNameOf.get(modeId) || modeId,
      sampleCount: mine.length,
      standard: std,                                                          // { segment: days }
      standardPreDeliveryDays: transit.standardPreDeliveryDays(modeId, stdByMode),  // CRD → E-DEL
      actual,                                                                 // { segment: {avg,min,max,n} | null }
      actualPreDeliveryAvg: totals.length ? Math.round((totals.reduce((a, v) => a + v, 0) / totals.length) * 10) / 10 : null,
    };
  });

  res.json({ segments: transit.SEGMENTS.map(({ key, label }) => ({ key, label })), lanes, modes: modeRows, shipments: shipmentRows });
}

module.exports = { getMainlineReport, getTransitTimes };
