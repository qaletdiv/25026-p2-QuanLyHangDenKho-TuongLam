'use strict';

// GET /forecast — mainline inventory pipeline forecast (LIVE migrated data).
//
// Replaces the frozen purchase-orders.json consumer (controllers/reportController
// .getForecast) with the normalized mainline dataset. The OUTPUT CONTRACT is
// unchanged so the existing Forecast UI renders identically:
//
//   [ { week: "W29 - 2026", weekNum, cartons, units,
//       warehouses: { <facility name>: { units, cartons } } }, … ]  (sorted by date)
//
// Grain = PO leg (the full projected order book), same as the mainline report.
// Each leg's expected qty (Σ allocated_qty) is placed on the week it is expected
// to ARRIVE at its destination facility, split into mutually-exclusive parts so
// the totals reconcile:
//   1. shipment legs      → bucketed by the shipment's expected-delivery week
//                           (E-DEL); rows already received are IN already, so they
//                           are excluded from the incoming pipeline. "Received" =
//                           the ATA derived from NetSuite Item Receipts
//                           (receipts/ataLoader), the same source the shipment list
//                           and the KPI report use.
//                           Cartons = confirmed distinct cartons from the packing
//                           list for that (booking, leg).
//   2. remainder (unshipped: booking-pending + awaiting-booking) → projected onto
//      the leg's E-DEL. Units only (nothing packed yet → 0 cartons). This is the
//      projected inbound that isn't shipped yet — the "forecast" proper.
// All derived at read-time; nothing stored.

const BaseModel = require('../../../models/BaseModel');
const { loadAtaByShipment, effectiveAta } = require('../receipts/ataLoader');

const readM = (f) => new BaseModel(`migrated/${f}.json`).read().catch(() => []);

// ISO week number (matches the previous forecast's helper, UTC-safe).
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return { weekNo, year: t.getUTCFullYear() };
}

async function getMainlineForecast(req, res) {
  const [legs, legLines, orders, facilities, channels, bookings, bookingLegs, shipments, shipLegs, cartons] =
    await Promise.all([
      readM('mainline_po_legs'), readM('mainline_po_leg_lines'), readM('po_orders'),
      readM('warehouse_facilities'), readM('allocation_channels'),
      readM('mainline_bookings'), readM('mainline_booking_po_legs'),
      readM('mainline_shipments'), readM('mainline_shipment_legs'), readM('mainline_packing_cartons'),
    ]);

  // "Already received" is decided by the DERIVED ATA (NetSuite Item Receipts via
  // the shared resolver), not the hand-entered `ata` column — see step 1 below.
  const ataMatch = await loadAtaByShipment({ shipments, shipLegs, legs });

  const orderByPo = new Map(orders.map((o) => [o.po_number, o]));
  const facName   = new Map(facilities.map((f) => [f.id, f.name]));
  const chanName  = new Map(channels.map((c) => [c.id, c.name]));
  const shipById  = new Map(shipments.map((s) => [s.id, s]));
  const qtyByLeg  = legLines.reduce((m, l) => m.set(l.leg_id, (m.get(l.leg_id) || 0) + (Number(l.allocated_qty) || 0)), new Map());
  const shipLegsByLeg = shipLegs.reduce((m, j) => { (m[j.leg_id] = m[j.leg_id] || []).push(j); return m; }, {});

  // confirmed carton count per (booking_id | leg_id) = distinct ctn_number
  const cartonSets = new Map();
  cartons.forEach((c) => {
    const k = `${c.booking_id}|${c.leg_id}`;
    if (!cartonSets.has(k)) cartonSets.set(k, new Set());
    cartonSets.get(k).add(c.ctn_number);
  });
  const cartonCount = (bookingId, legId) => (cartonSets.get(`${bookingId}|${legId}`)?.size || 0);

  // week bucket accumulator, keyed "W## - YYYY". Each week carries TWO breakdown
  // maps so the UI can toggle: `warehouses` (facility only) and `warehouse_channels`
  // (facility × allocation channel, key "Facility · Channel"). Channel is a PO/order
  // attribute (Reserved/First); legs with none show "Unassigned".
  const weeks = new Map();
  const bucket = (dateStr, facilityName, channelName, units, cartonsN) => {
    if (!dateStr || units <= 0) return;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return;
    const { weekNo, year } = isoWeek(d);
    const key = `W${weekNo} - ${year}`;
    let w = weeks.get(key);
    if (!w) { w = { week: key, weekNum: weekNo, _year: year, cartons: 0, units: 0, warehouses: {}, warehouse_channels: {} }; weeks.set(key, w); }
    const wh = facilityName || 'Unknown';
    const whc = `${wh} · ${channelName || 'Unassigned'}`;
    w.units += units;
    w.cartons += cartonsN;
    const add = (map, k) => {
      if (!map[k]) map[k] = { units: 0, cartons: 0 };
      map[k].units += units;
      map[k].cartons += cartonsN;
    };
    add(w.warehouses, wh);
    add(w.warehouse_channels, whc);
  };

  for (const leg of legs) {
    const order = orderByPo.get(leg.po_number) || {};
    const orderFacility = facName.get(order.facility_id) || null;
    const orderChannel = chanName.get(order.allocation_channel_id) || null;
    const legQty = qtyByLeg.get(leg.id) || 0;
    let counted = 0;

    // 1 — shipment legs (actual pipeline)
    for (const j of shipLegsByLeg[leg.id] || []) {
      const ship = shipById.get(j.shipment_id) || {};
      const qty = Number(j.expected_quantity) || 0;
      counted += qty;
      // Already received → in stock, not incoming. `counted` is incremented FIRST
      // (above), so excluding the leg here removes it from the pipeline without
      // letting step 2 re-project it as unshipped remainder.
      if (effectiveAta(ataMatch, ship).ata) continue;
      const date = ship.e_del || ship.eta_pod || ship.etd_pol || null;
      const facility = facName.get(ship.facility_id) || orderFacility;
      bucket(date, facility, orderChannel, qty, cartonCount(ship.booking_id, leg.id));
    }

    // 2 — remainder not yet shipped (booking-pending + awaiting-booking): projected
    const rem = legQty - counted;
    if (rem > 0) bucket(leg.e_del || leg.etd_pol || null, orderFacility, orderChannel, rem, 0);
  }

  // sort by real chronology (year, then week); strip the private _year field
  const forecast = [...weeks.values()]
    .sort((a, b) => a._year - b._year || a.weekNum - b.weekNum)
    .map(({ _year, ...w }) => w);

  res.json(forecast);
}

module.exports = { getMainlineForecast };
