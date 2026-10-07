'use strict';

// GET /forecast — mainline inventory pipeline forecast: PLANNED vs ACTUAL as a
// PIVOT (2026-10-07, per Lam).
//
//   planned — the PO leg's E-DEL (mainline_po_legs.eDel). Blank → not planned.
//   actual  — the SHIPMENT's E-DEL (mainline_shipments.eDel). Blank, or no
//             shipment → not actual.
//
// Each unit sits in the week of EACH date it has, like a pivot: a PO planned for
// W1 that ships with E-DEL in W2 shows planned 1,000 in W1 and actual 1,000 in
// W2. PO E-DEL blank + shipment dated → 0 planned / 1,000 actual. Planned but no
// shipment E-DEL → 1,000 planned / 0 actual. Nothing is ever moved onto the other
// side's date. (This REPLACED the "best-known date" model, in which unbooked
// units counted as actual on their plan date and the receipt date beat the
// shipment E-DEL — the plan is a DELIVERY date and a receipt lands ~5 days after
// delivery, so received consignments showed ~+6d of false slip.)
// The NetSuite receipt still decides the STAGE (Received vs In Transit), and
// Received units are included — this is the full order book, not incoming-only.
//
// Grain = PO leg, split into mutually-exclusive PARTS (one per live shipment,
// then the unshipped remainder). The leg's allocation is handed out across its
// parts in order, capped at the leg, so Σ planned === Σ allocatedQty exactly;
// actual is the shipped qty, so a genuine over-shipment shows (planned 1,000 vs
// actual 1,025) and is NOT clamped — G2 permits it by design.
//
// Output: { seasons: ["SS27", …], bySeason: { all: [week…], SS27: [week…] } }
// per week, chronological:
//   { week: "W1 - 2027", weekNum,
//     plan:   { units, cartons, warehouses, warehouseChannels, suppliers },
//     actual: { units, cartons, warehouses, warehouseChannels, suppliers },
//     lines:  [ { …ident, stage, plannedUnits, actualUnits, cartons,
//                 planDate, actualDate, slipDays } ] }
// Σ lines.plannedUnits === plan.units and Σ lines.actualUnits === actual.units on
// every week. A part whose two dates fall in different weeks is TWO lines (one
// per week, the other side 0); slipDays exists only when both dates do.
//
// ⚠️ A CANCELLED consignment is not actual: its units fall back to the unshipped
// remainder as `Booked — Not Shipped` while the booking is still approved.
// ⚠️ CARTONS exist only on the actual side (from the uploaded packing list) — a
// plan has none. Do NOT estimate them from units: pcsPerCtn is inconsistent
// (range 4–230 on live data), so a divisor would invent a capacity figure.
//
// SEASON: the rollup is RE-RUN per season (cheap aggregation over shared joins),
// so every season view reconciles exactly. Season is DERIVED (leg → order → TRN
// master → season code); `seasons` lists only what the order book holds.

const { models } = require('../models');
const status = require('../lib/mainlineStatuses');
const { loadAtaByShipment, effectiveAta } = require('../lib/mainlineAtaLoader');

const readM = (f) => models[f].read().catch(() => []);
const read  = readM;

// ISO week number (matches the previous forecast's helper, UTC-safe).
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return { weekNo, year: t.getUTCFullYear() };
}

const weekKeyOf = (dateStr) => {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const { weekNo, year } = isoWeek(d);
  return { key: `W${weekNo} - ${year}`, weekNo, year };
};

const dayDiff = (from, to) => {
  if (!from || !to) return null;
  const a = new Date(from), b = new Date(to);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.round((b - a) / 86400000);
};

async function getMainlineForecast(req, res) {
  const [legs, legLines, orders, facilities, channels, bookings, bookingLegs, shipments, shipLegs, cartons,
         masters, suppliers, modes] =
    await Promise.all([
      readM('mainline_po_legs'), readM('mainline_po_leg_lines'), readM('po_orders'),
      readM('warehouse_facilities'), readM('allocation_channels'),
      readM('mainline_bookings'), readM('mainline_booking_po_legs'),
      readM('mainline_shipments'), readM('mainline_shipment_legs'), readM('mainline_packing_cartons'),
      readM('po_masters'), read('suppliers'), read('modes'),
    ]);
  const seasons = await readM('seasons');

  // The ACTUAL date of a landed consignment is the DERIVED ATA (NetSuite Item
  // Receipts via the shared resolver), not the hand-entered `ata` column — the
  // same precedence every other mainline consumer uses.
  const ataMatch = await loadAtaByShipment({ shipments, shipLegs, legs });

  const orderByPo = new Map(orders.map((o) => [o.poNumber, o]));
  const facName   = new Map(facilities.map((f) => [f.id, f.name]));
  const chanName  = new Map(channels.map((c) => [c.id, c.name]));
  const shipById  = new Map(shipments.map((s) => [s.id, s]));
  const masterByTrn = new Map(masters.map((m) => [m.trnNumber, m]));
  const supName   = new Map(suppliers.map((s) => [s.id, s.name]));
  const modeName  = new Map(modes.map((m) => [m.id, m.name]));
  const seasonCode = new Map(seasons.map((s) => [s.id, s.code]));
  const qtyByLeg  = legLines.reduce((m, l) => m.set(l.legId, (m.get(l.legId) || 0) + (Number(l.allocatedQty) || 0)), new Map());
  // ⚠️ A CANCELLED consignment is NOT incoming. Its junction rows are split out
  // here rather than filtered away, because those units have not vanished — the
  // booking still authorizes them, so they belong in the unshipped remainder under
  // the `Booked — Not Shipped` stage below. Leaving them in the shipped pass was
  // the bug this fixes: SHP-10 was cancelled and its 1,000 units still read
  // "In Transit" in W43, the only In-Transit row in the whole order book.
  const cancelledStatusId = await status.idForName('Cancelled');
  const isCancelledShip = (shipmentId) => (shipById.get(shipmentId) || {}).statusId === cancelledStatusId;
  const shipLegsByLeg = shipLegs
    .filter((j) => !isCancelledShip(j.shipmentId))
    .reduce((m, j) => { (m[j.legId] = m[j.legId] || []).push(j); return m; }, {});
  // Units whose consignment was cancelled, per leg. Counted as booked-not-shipped
  // only while the BOOKING is still approved — cancel the booking too and the units
  // are genuinely back to unbooked.
  const cancelledByLeg = new Map();
  shipLegs.filter((j) => isCancelledShip(j.shipmentId)).forEach((j) => {
    cancelledByLeg.set(j.legId, (cancelledByLeg.get(j.legId) || 0) + (Number(j.expectedQuantity) || 0));
  });

  // confirmed carton count per (bookingId | legId) = distinct ctnNumber
  const cartonSets = new Map();
  cartons.forEach((c) => {
    const k = `${c.bookingId}|${c.legId}`;
    if (!cartonSets.has(k)) cartonSets.set(k, new Set());
    cartonSets.get(k).add(c.ctnNumber);
  });
  const cartonCount = (bookingId, legId) => (cartonSets.get(`${bookingId}|${legId}`)?.size || 0);

  // Stage label for the unshipped remainder. "Booking Pending" means a booking
  // EXISTS AND IS AWAITING APPROVAL — the same test mainlineReportController
  // step 2 makes, deliberately NOT "a booking junction row exists", which would
  // also label rejected and cancelled bookings as pending.
  const bookingById = new Map(bookings.map((b) => [b.id, b]));
  const statusName = new Map();
  await Promise.all([...new Set(bookings.map((b) => b.bookingStatusId))]
    .map(async (id) => statusName.set(id, await status.nameForId(id))));
  const pendingLegs = new Set(
    bookingLegs
      .filter((j) => statusName.get((bookingById.get(j.bookingId) || {}).bookingStatusId) === 'Booking Pending')
      .map((j) => j.legId));
  // Legs an APPROVED booking still stands behind. Paired with cancelledByLeg above
  // this gives the `Booked — Not Shipped` rung: authorized, no consignment carrying
  // it right now. More confident than Booking Pending (someone has signed it off),
  // less than In Transit (nothing is moving).
  const approvedLegs = new Set(
    bookingLegs
      .filter((j) => statusName.get((bookingById.get(j.bookingId) || {}).bookingStatusId) === 'Booking Approved')
      .map((j) => j.legId));

  // Week accumulator, keyed "W## - YYYY". A week exists if EITHER series lands
  // there, so a consignment that slipped out of its planned week still leaves a
  // plan figure behind in it — that residue is the whole point of the comparison.
  // Each series carries the three breakdown maps the matrix can toggle between:
  // `warehouses`, `warehouseChannels` ("Facility · Channel") and `suppliers`.
  // Season of a leg, derived: leg → order → TRN master → season code.
  const seasonOfLeg = (leg) => {
    const order = orderByPo.get(leg.poNumber) || {};
    const master = masterByTrn.get(order.trnNumber) || {};
    return seasonCode.get(master.seasonId) || null;
  };

  // Seasons the order book actually holds, newest first ("SS27" → year, SS before
  // FW), mirroring seasonRank in components/SeasonScopeFilter so the dropdown on
  // this page orders identically to the lifecycle tables.
  const seasonRank = (code) => {
    const m = String(code || '').match(/^([A-Za-z]+)\s*(\d+)$/);
    return m ? Number(m[2]) * 2 + (m[1].toUpperCase() === 'FW' ? 1 : 0) : -1;
  };
  const seasonsPresent = [...new Set(legs.map(seasonOfLeg).filter(Boolean))]
    .sort((a, b) => seasonRank(b) - seasonRank(a));

  // ── The rollup. Runs once per season plus once for 'all'; everything above is
  // shared, so a season switch costs one cheap pass over the legs.
  const rollup = (legList) => {
  const weeks = new Map();
  const emptySeries = () => ({ units: 0, cartons: 0, warehouses: {}, warehouseChannels: {}, suppliers: {} });
  const weekAt = (key, weekNo, year) => {
    let w = weeks.get(key);
    if (!w) {
      w = { week: key, weekNum: weekNo, _year: year,
            plan: emptySeries(), actual: emptySeries(), lines: [] };
      weeks.set(key, w);
    }
    return w;
  };

  // Add `units`/`cartonsN` into one series of one week, across all three maps.
  const bucket = (series, dateStr, facilityName, channelName, supplierName, units, cartonsN) => {
    if (units <= 0) return;
    const wk = weekKeyOf(dateStr);
    if (!wk) return;
    const s = weekAt(wk.key, wk.weekNo, wk.year)[series];
    const wh = facilityName || 'Unknown';
    const whc = `${wh} · ${channelName || 'Unassigned'}`;
    const sup = supplierName || 'Unknown';
    s.units += units;
    s.cartons += cartonsN;
    const add = (map, k) => {
      if (!map[k]) map[k] = { units: 0, cartons: 0 };
      map[k].units += units;
      map[k].cartons += cartonsN;
    };
    add(s.warehouses, wh);
    add(s.warehouseChannels, whc);
    add(s.suppliers, sup);
  };

  for (const leg of legList) {
    const order = orderByPo.get(leg.poNumber) || {};
    const master = masterByTrn.get(order.trnNumber) || {};
    const orderFacility = facName.get(order.facilityId) || null;
    const orderChannel = chanName.get(order.allocationChannelId) || null;
    const supplier = supName.get(master.supplierId) || null;
    const legQty = qtyByLeg.get(leg.id) || 0;
    // PLANNED date = the leg's E-DEL, nothing else. Blank → no planned week.
    const planDate = leg.eDel || null;

    const ident = {
      poNumber: leg.poNumber,
      trnNumber: order.trnNumber || null,
      supplier,
      season: seasonCode.get(master.seasonId) || null,
      mode: modeName.get(leg.modeId) || null,
      legId: leg.id,
      crd: leg.crd || null,
      planDate,
      planWeek: weekKeyOf(planDate)?.key || null,
    };

    // ── Split the leg into mutually-exclusive PARTS: one per live shipment, then
    // the unshipped remainder. Each part carries BOTH quantities (the pivot):
    //   plannedUnits — the leg's allocation, handed out across the parts in order
    //                  and capped at legQty, so Σ planned === the leg exactly;
    //   actualUnits  — the shipment's qty, ONLY when the shipment has an E-DEL.
    // A blank date leaves that side empty: no planned week, or no actual week.
    let planLeft = legQty;
    const parts = [];
    for (const j of shipLegsByLeg[leg.id] || []) {
      const ship = shipById.get(j.shipmentId) || {};
      const qty = Number(j.expectedQuantity) || 0;
      if (qty <= 0) continue;
      const planned = Math.min(qty, Math.max(planLeft, 0));
      planLeft -= planned;
      const actualDate = ship.eDel || null;              // ACTUAL = shipment E-DEL only
      parts.push({
        plannedUnits: planned,
        actualUnits: actualDate ? qty : 0,
        actualDate,
        cartons: actualDate ? cartonCount(ship.bookingId, leg.id) : 0,
        // The NetSuite receipt decides the STAGE only, never the date.
        stage: effectiveAta(ataMatch, ship).ata ? 'Received' : 'In Transit',
        dateBasis: actualDate ? 'shipment_e_del' : null,
        shipmentId: ship.id || null,
        shipmentNumber: ship.shipmentNumber || null,
        carrierReference: ship.carrierReference || null,
        warehouse: facName.get(ship.facilityId) || orderFacility || 'Unknown',
      });
    }
    // Unshipped remainder: planned only, never actual. Split into Booked — Not
    // Shipped (its consignment was cancelled, booking still approved) and the rest.
    const rem = Math.max(planLeft, 0);
    if (rem > 0) {
      const bookedNotShipped = approvedLegs.has(leg.id)
        ? Math.min(cancelledByLeg.get(leg.id) || 0, rem)
        : 0;
      const remParts = [
        bookedNotShipped > 0 && { units: bookedNotShipped, stage: 'Booked — Not Shipped' },
        rem - bookedNotShipped > 0 && {
          units: rem - bookedNotShipped,
          stage: pendingLegs.has(leg.id) ? 'Booking Pending' : 'Awaiting Booking',
        },
      ].filter(Boolean);
      for (const p of remParts) parts.push({
        plannedUnits: p.units, actualUnits: 0, actualDate: null, cartons: 0,
        stage: p.stage, dateBasis: null,
        shipmentId: null, shipmentNumber: null, carrierReference: null,
        warehouse: orderFacility || 'Unknown',
      });
    }

    // ── Place each part: planned qty in the PLAN week, actual qty in the ACTUAL
    // week. Same week → one line carrying both; different weeks → one line in
    // each, with the other side 0. Σ lines' planned/actual === the week's series.
    const planWk = weekKeyOf(planDate);
    for (const p of parts) {
      const actWk = weekKeyOf(p.actualDate);
      if (planWk && p.plannedUnits > 0) bucket('plan', planDate, orderFacility, orderChannel, supplier, p.plannedUnits, 0);
      if (actWk && p.actualUnits > 0) bucket('actual', p.actualDate, p.warehouse, orderChannel, supplier, p.actualUnits, p.cartons);

      const line = (planned, actual, cartonsN) => ({
        ...ident,
        stage: p.stage,
        dateBasis: p.dateBasis,
        shipmentId: p.shipmentId,
        shipmentNumber: p.shipmentNumber,
        carrierReference: p.carrierReference,
        warehouse: p.warehouse,
        channel: orderChannel || 'Unassigned',
        plannedUnits: planned,
        actualUnits: actual,
        cartons: cartonsN,
        actualDate: p.actualDate,
        // Slip only exists when BOTH dates do.
        slipDays: dayDiff(planDate, p.actualDate),
      });
      const planHere = planWk && p.plannedUnits > 0;
      const actHere = actWk && p.actualUnits > 0;
      if (planHere && actHere && planWk.key === actWk.key) {
        weekAt(planWk.key, planWk.weekNo, planWk.year).lines.push(line(p.plannedUnits, p.actualUnits, p.cartons));
      } else {
        if (planHere) weekAt(planWk.key, planWk.weekNo, planWk.year).lines.push(line(p.plannedUnits, 0, 0));
        if (actHere) weekAt(actWk.key, actWk.weekNo, actWk.year).lines.push(line(0, p.actualUnits, p.cartons));
      }
    }
  }

  // sort by real chronology (year, then week); strip the private _year field.
  // Drill-down lines sort biggest-first (actual, then planned): a week is opened
  // to find out what is driving it.
  return [...weeks.values()]
    .sort((a, b) => a._year - b._year || a.weekNum - b.weekNum)
    .map(({ _year, ...w }) => {
      w.lines.sort((a, b) => (b.actualUnits + b.plannedUnits) - (a.actualUnits + a.plannedUnits)
        || a.poNumber.localeCompare(b.poNumber));
      return w;
    });
  };

  const bySeason = { all: rollup(legs) };
  seasonsPresent.forEach((code) => {
    bySeason[code] = rollup(legs.filter((l) => seasonOfLeg(l) === code));
  });

  res.json({ seasons: seasonsPresent, bySeason });
}

module.exports = { getMainlineForecast };
