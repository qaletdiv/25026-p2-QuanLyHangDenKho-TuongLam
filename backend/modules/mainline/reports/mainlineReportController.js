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
//                    shipment's E-DEL (date_basis 'actual'); pre-shipment rows
//                    grade the leg's WIP-projected E-DEL (date_basis 'projected').
//                    Unbooked legs also cross-check achievability: if CRD + the
//                    standard transit time (transit_time_standards) lands LATER
//                    than the stated E-DEL, the later date is graded.
//   • kpi_status   — the flattened cascade the manager's tables pivot on:
//                    Received (actual ATA filled) → Delivered → timeliness.
//
// `reason` is a human-readable explanation of the grade (cutoff comparison, the
// not-booked/not-approved state, the slipped transit segment, achievability).
// All of this is DERIVED at read-time — nothing is stored.

const BaseModel = require('../../../models/BaseModel');
const status = require('../statuses');
const transit = require('./transitTimeService');

const read = (f) => new BaseModel(`${f}.json`).read().catch(() => []);
const readM = (f) => read(`migrated/${f}`);

// E-DEL vs the season's cutoffs. ISO date strings compare lexicographically.
function timelinessFor(eDel, sched) {
  if (!eDel || !sched || !sched.ontime_by || !sched.atrisk_by) return 'Unknown';
  if (eDel <= sched.ontime_by) return 'On Time';
  if (eDel <= sched.atrisk_by) return 'At Risk';
  return 'Late';
}

// The grading explanation shared by every row's reason string.
function timelinessClause(eDel, sched, tl) {
  if (tl === 'On Time') return `E-DEL ${eDel} within on-time cutoff ${sched.ontime_by}`;
  if (tl === 'At Risk') return `E-DEL ${eDel} past on-time cutoff ${sched.ontime_by} (at-risk until ${sched.atrisk_by})`;
  if (tl === 'Late')    return `E-DEL ${eDel} past at-risk cutoff ${sched.atrisk_by}`;
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

  const orderByPo     = new Map(d.orders.map((o) => [o.po_number, o]));
  const masterByTrn   = new Map(d.masters.map((m) => [m.trn_number, m]));
  const seasonCode    = new Map(d.seasons.map((s) => [s.id, s.code]));
  const facName       = new Map(d.facilities.map((f) => [f.id, f.name]));
  const chanName      = new Map(d.channels.map((c) => [c.id, c.name]));
  const supName       = new Map(d.suppliers.map((s) => [s.id, s.name]));
  const modeName      = new Map(d.modes.map((m) => [m.id, m.name]));
  const schedBySeason = new Map(d.schedules.map((p) => [p.season_id, p]));
  const shipById      = new Map(d.shipments.map((s) => [s.id, s]));
  const bookingById   = new Map(d.bookings.map((b) => [b.id, b]));
  const stdByMode     = transit.standardsByMode(d.standards);

  const qtyByLeg = d.legLines.reduce((m, l) => m.set(l.leg_id, (m.get(l.leg_id) || 0) + (Number(l.allocated_qty) || 0)), new Map());
  const shipLegsByLeg = d.shipLegs.reduce((m, j) => { (m[j.leg_id] = m[j.leg_id] || []).push(j); return m; }, {});
  const bookLegsByLeg = d.bookingLegs.reduce((m, j) => { (m[j.leg_id] = m[j.leg_id] || []).push(j); return m; }, {});

  // status_id → name (shipment progress pipeline + booking statuses)
  const statusName = new Map();
  const statusIds = new Set([
    ...d.shipments.map((s) => s.status_id),
    ...d.bookings.map((b) => b.booking_status_id),
  ]);
  await Promise.all([...statusIds].map(async (id) => statusName.set(id, await status.nameForId(id))));

  // Pre-compute per-shipment transit facts: earliest CRD across its legs,
  // per-segment durations, and segments that ran over their standard.
  const legById = new Map(d.legs.map((l) => [l.id, l]));
  const shipFacts = new Map(d.shipments.map((s) => {
    const crds = (d.shipLegs.filter((j) => j.shipment_id === s.id))
      .map((j) => (legById.get(j.leg_id) || {}).crd).filter(Boolean).sort();
    const crd = crds[0] || null;
    const durations = transit.segmentDurations(s, crd);
    return [s.id, { crd, durations, slipped: transit.slippedSegments(durations, s.mode_id, stdByMode) }];
  }));

  const rows = [];

  for (const leg of d.legs) {
    const order  = orderByPo.get(leg.po_number) || {};
    const master = masterByTrn.get(order.trn_number) || {};
    const seasonId = master.season_id || null;
    const sched    = schedBySeason.get(seasonId) || null;
    const channel  = chanName.get(order.allocation_channel_id) || null;

    const base = {
      leg_id:      leg.id,
      po_number:   leg.po_number || null,
      trn_number:  order.trn_number || null,
      supplier:    supName.get(master.supplier_id) || null,
      season:      seasonCode.get(seasonId) || null,
      channel,
      segment:     channel ? (SEGMENT[channel] || null) : null,   // WS / EC
      crd:         leg.crd || null,
    };
    const legQty = qtyByLeg.get(leg.id) || 0;
    let counted = 0;

    // 1 — shipment rows (actual)
    for (const j of shipLegsByLeg[leg.id] || []) {
      const ship  = shipById.get(j.shipment_id) || {};
      const facts = shipFacts.get(j.shipment_id) || { slipped: [] };
      const qty   = Number(j.expected_quantity) || 0;
      counted += qty;
      const progress   = statusName.get(ship.status_id) || null;
      const timeliness = timelinessFor(ship.e_del, sched);

      let reason;
      if (ship.ata) {
        const lateBy = transit.daysBetween(transit.addDays(ship.e_del, 5), ship.ata);
        reason = `Received ${ship.ata}` + (lateBy != null ? (lateBy > 0 ? ` — ${lateBy}d after expected ATA` : ' — within expected ATA') : '');
      } else {
        reason = `${progress || 'Shipped'} on ${ship.shipment_number || j.shipment_id} — ${timelinessClause(ship.e_del, sched, timeliness)}`;
        const worst = facts.slipped[0];
        if (worst && (timeliness === 'Late' || timeliness === 'At Risk')) {
          reason += `; ${worst.label} took ${worst.actual}d vs ${worst.standard}d standard`;
        }
      }

      rows.push({
        ...base,
        row_id:          `${leg.id}|ship|${j.shipment_id}`,
        shipment_id:     j.shipment_id,
        shipment_number: ship.shipment_number || null,
        booking_id:      ship.booking_id || null,
        booking_number:  (bookingById.get(ship.booking_id) || {}).booking_number || null,
        facility:        facName.get(ship.facility_id) || facName.get(order.facility_id) || null,
        mode_id:         ship.mode_id || leg.mode_id || null,
        mode:            modeName.get(ship.mode_id || leg.mode_id) || null,
        qty,
        stage:           progress,
        progress_status: progress,
        date_basis:      'actual',
        e_del:           ship.e_del || null,
        expected_ata:    transit.addDays(ship.e_del, 5),   // derived, never stored
        ata:             ship.ata || null,
        timeliness,
        kpi_status:      kpiStatusFor(ship.ata, progress, timeliness),
        reason,
      });
    }

    // 2 — pending-booking rows (projected; approved bookings are covered by their shipments)
    for (const bl of bookLegsByLeg[leg.id] || []) {
      const booking = bookingById.get(bl.booking_id) || {};
      if (statusName.get(booking.booking_status_id) !== 'Booking Pending') continue;
      const qty = Number(bl.units) || Math.max(0, legQty - counted);
      if (qty <= 0) continue;
      counted += qty;
      const timeliness = timelinessFor(leg.e_del, sched);

      rows.push({
        ...base,
        row_id:          `${leg.id}|bkg|${bl.booking_id}`,
        shipment_id:     null,
        shipment_number: null,
        booking_id:      bl.booking_id,
        booking_number:  booking.booking_number || null,
        facility:        facName.get(order.facility_id) || null,
        mode_id:         leg.mode_id || null,
        mode:            modeName.get(leg.mode_id) || null,
        qty,
        stage:           'Booking Pending',
        progress_status: null,
        date_basis:      'projected',
        e_del:           leg.e_del || null,
        expected_ata:    transit.addDays(leg.e_del, 5),
        ata:             null,
        timeliness,
        kpi_status:      timeliness,
        reason:          `Booking ${booking.booking_number || bl.booking_id} awaiting approval — ${timelinessClause(leg.e_del, sched, timeliness)}`,
      });
    }

    // 3 — Awaiting Booking remainder (projected + achievability cross-check)
    const rem = legQty - counted;
    if (rem > 0) {
      const stated  = leg.e_del || null;
      const transitEDel = transit.projectedEDel(leg.crd, leg.mode_id, stdByMode);
      // grade the later (worse) of the stated E-DEL and what standard transit allows
      const graded = [stated, transitEDel].filter(Boolean).sort().pop() || null;
      const timeliness = timelinessFor(graded, sched);

      let reason = `Not booked yet — ${timelinessClause(graded, sched, timeliness)}`;
      if (stated && transitEDel && transitEDel > stated) {
        const stdDays = transit.standardPreDeliveryDays(leg.mode_id, stdByMode);
        reason = `Not booked yet — stated E-DEL ${stated} not achievable from CRD ${leg.crd} + ${stdDays}d standard ${modeName.get(leg.mode_id) || ''} transit (earliest ${transitEDel}); ${timelinessClause(graded, sched, timeliness)}`;
      }

      rows.push({
        ...base,
        row_id:          `${leg.id}|awaiting`,
        shipment_id:     null,
        shipment_number: null,
        booking_id:      null,
        booking_number:  null,
        facility:        facName.get(order.facility_id) || null,
        mode_id:         leg.mode_id || null,
        mode:            modeName.get(leg.mode_id) || null,
        qty:             rem,
        stage:           'Awaiting Booking',
        progress_status: null,
        date_basis:      'projected',
        e_del:           graded,
        expected_ata:    transit.addDays(graded, 5),
        ata:             null,
        timeliness,
        kpi_status:      timeliness,
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
  const orderByPo  = new Map(orders.map((o) => [o.po_number, o]));
  const stdByMode  = transit.standardsByMode(standards);

  const shipmentRows = shipments.map((s) => {
    const myLegs = shipLegs.filter((j) => j.shipment_id === s.id).map((j) => legById.get(j.leg_id) || {});
    const crd = myLegs.map((l) => l.crd).filter(Boolean).sort()[0] || null;
    const coo = [...new Set(myLegs.map((l) => (orderByPo.get(l.po_number) || {}).coo_country).filter(Boolean))].join(', ') || null;
    const durations = transit.segmentDurations(s, crd);
    return {
      shipment_id:     s.id,
      shipment_number: s.shipment_number || null,
      booking_number:  (bookingById.get(s.booking_id) || {}).booking_number || null,
      supplier_name:   supName.get((bookingById.get(s.booking_id) || {}).supplier_id) || null,
      coo,
      pol_port:        portName.get(s.pol_port_id) || null,
      mode_id:         s.mode_id || null,
      mode:            modeNameOf.get(s.mode_id) || null,
      crd,
      cargo_received_date: s.cargo_received_date || null,
      etd_pol: s.etd_pol || null, eta_pod: s.eta_pod || null,
      e_del: s.e_del || null, ata: s.ata || null,
      durations,
      slipped: transit.slippedSegments(durations, s.mode_id, stdByMode),
    };
  });

  // lane aggregates: supplier × COO × departure port × mode (mode kept in the key —
  // an Air and a Sea shipment on the same lane must not average together)
  const laneMap = new Map();
  for (const r of shipmentRows) {
    const key = [r.supplier_name, r.coo, r.pol_port, r.mode_id].join('|');
    if (!laneMap.has(key)) laneMap.set(key, { supplier_name: r.supplier_name, coo: r.coo, pol_port: r.pol_port, mode_id: r.mode_id, mode: r.mode, rows: [] });
    laneMap.get(key).rows.push(r);
  }
  const stats = (all, invalid_segments, key) => {
    // negative duration = dates entered out of order → excluded from the average,
    // surfaced via invalid_segments so the UI can flag the cell instead
    const vals = all.filter((v) => v >= 0);
    if (all.length > vals.length) invalid_segments.push(key);
    return vals.length
      ? { avg: Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 10) / 10, min: Math.min(...vals), max: Math.max(...vals), n: vals.length }
      : null;
  };
  const lanes = [...laneMap.values()].map((lane) => {
    const segments = {};
    const invalid_segments = [];
    transit.SEGMENTS.forEach((seg) => {
      const all = lane.rows.map((r) => r.durations[seg.key]).filter((v) => v != null);
      segments[seg.key] = stats(all, invalid_segments, seg.key);
    });
    // end-to-end CRD → ATA (door to received-in-system)
    const total = stats(lane.rows.map((r) => transit.daysBetween(r.crd, r.ata)).filter((v) => v != null), invalid_segments, 'total');
    return {
      total,
      supplier_name: lane.supplier_name, coo: lane.coo, pol_port: lane.pol_port,
      mode_id: lane.mode_id, mode: lane.mode,
      sample_count: lane.rows.length,
      segments,
      invalid_segments,
      standard: stdByMode.get(lane.mode_id) || {},
    };
  }).sort((a, b) => (a.supplier_name || '~').localeCompare(b.supplier_name || '~') || (a.coo || '').localeCompare(b.coo || ''));

  // per-mode aggregates: every mode with standards or shipments
  const modeIds = [...new Set([...stdByMode.keys(), ...shipments.map((s) => s.mode_id).filter(Boolean)])];
  const modeRows = modeIds.map((modeId) => {
    const mine = shipmentRows.filter((r) => r.mode_id === modeId);
    const std  = stdByMode.get(modeId) || {};
    const actual = {};
    transit.SEGMENTS.forEach((seg) => {
      // negatives (dates out of order) are excluded — they'd make a lane look fast
      const vals = mine.map((r) => r.durations[seg.key]).filter((v) => v != null && v >= 0);
      actual[seg.key] = vals.length
        ? { avg: Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 10) / 10, min: Math.min(...vals), max: Math.max(...vals), n: vals.length }
        : null;
    });
    const totals = mine.map((r) => transit.daysBetween(r.crd, r.e_del)).filter((v) => v != null && v >= 0);
    return {
      mode_id: modeId,
      mode: modeNameOf.get(modeId) || modeId,
      sample_count: mine.length,
      standard: std,                                                          // { segment: days }
      standard_pre_delivery_days: transit.standardPreDeliveryDays(modeId, stdByMode),  // CRD → E-DEL
      actual,                                                                 // { segment: {avg,min,max,n} | null }
      actual_pre_delivery_avg: totals.length ? Math.round((totals.reduce((a, v) => a + v, 0) / totals.length) * 10) / 10 : null,
    };
  });

  res.json({ segments: transit.SEGMENTS.map(({ key, label }) => ({ key, label })), lanes, modes: modeRows, shipments: shipmentRows });
}

module.exports = { getMainlineReport, getTransitTimes };
