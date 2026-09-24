'use strict';

// GET /forecast — mainline inventory pipeline forecast (LIVE migrated data).
//
// PLAN vs ACTUAL over the FULL order book (2026-09-10). The page used to answer
// one question — "what is still incoming?" — with one number per week. It now
// answers the planning question directly by carrying the SAME units on TWO dates:
//
//   plan   — every unit on its PO leg's stated E-DEL. What was ORDERED to happen.
//   actual — the best-known date for that unit: the derived NetSuite ATA once it
//            has landed, else the SHIPMENT's E-DEL once it is booked and shipped,
//            else (nothing shipped yet) the leg E-DEL, because no better
//            information exists.
//
// The gap between the two series IS the slippage, per week and per PO. A unit
// appears in BOTH series, so each one totals the whole order book — they are not
// mutually exclusive buckets and must never be added together.
//
// ⚠️ RECEIVED UNITS ARE INCLUDED. This is the deliberate reversal of the old
// behaviour, which `continue`d on any shipment with a derived ATA because
// receipted goods are in stock, not incoming. Excluding them made the actual
// series structurally empty — all 9 mainline shipments are receipted, so there
// was nothing to compare the plan against. Consequence to know: `/forecast` is
// now the full order book (~264k units), NOT an incoming-only view, and its
// grand total therefore includes goods already in the warehouse. `stage` says
// which is which, and the UI leads with the still-to-arrive figure.
//
// Output:
//   { seasons: ["FW26", …],        // present in the mainline order book, newest first
//     bySeason: { all: [week…], FW26: [week…], … } }
//
// and per week (sorted by chronology):
//   { week: "W29 - 2026", weekNum,
//     plan:   { units, cartons, warehouses, warehouseChannels, suppliers },
//     actual: { units, cartons, warehouses, warehouseChannels, suppliers },
//     backed: { … },                                              // ⊆ actual
//     units, cartons, warehouses, warehouseChannels, suppliers,  // = actual
//     lines: [ … ] }                                              // actual-week grain
//
// ⚠️ `backed` IS THE FOUNDATION, and it is a SUBSET of `actual` — never add them.
// It holds only the units resting on a real shipment (stage Received or In
// Transit), i.e. on an approved booking, as opposed to a date typed on a PO that
// nobody has committed to. `backed.units / actual.units` is the week's
// CONFIDENCE, and it is the honest answer to "does this forecast have a
// foundation?". Received and In Transit both qualify: the evidence is that the
// shipment EXISTS, not that it has landed.
// Measured 2026-09-15 — the answer today is sobering and explains why the split
// is worth carrying: bookings are being recorded RETROSPECTIVELY. Median lead
// time from booking approval to the shipment's own E-DEL is **−5 days**, 8 of 9
// bookings were approved AFTER their E-DEL and 5 of 9 after the goods had
// already landed, so shipment-backed units in the FUTURE total **0** while
// 42,935 sit in the past. That is a process gap, not a modelling one — no
// restructuring makes the shipment table predictive while bookings are entered
// after the fact. The split is built so the page tells the truth about that now
// and becomes shipment-dominant on its own as booking discipline moves earlier.
//
// SEASON: the whole rollup is RE-RUN per season rather than filtered client-side.
// The expensive joins (ATA resolution, receipt matching, carton sets, status
// lookups) are computed ONCE and only the cheap aggregation loop repeats, so with
// a handful of seasons the payload is tiny and switching is instant — while every
// series, every breakdown map, the cartons and the drill-down stay exact by
// construction, because they come from the SAME code path as the unfiltered view.
// Filtering client-side would have meant re-deriving the plan series in the
// browser, and the plan is leg-grained while the lines are part-grained, so the
// two would have had to be reconciled by hand. Season is DERIVED at read
// (leg → po_orders.trnNumber → po_masters.seasonId → seasons.code), per the
// 3NF rule; `seasons` lists only what the order book actually holds, so the
// dropdown can never offer a season that renders an empty page.
//
// Grain = PO leg. Each leg's expected qty (Σ allocatedQty) is placed whole onto
// the plan series, and split into mutually-exclusive parts on the actual series
// (shipment legs + unshipped remainder) so the actual series reconciles too.
// All derived at read-time; nothing stored.
//
// ⚠️ CARTONS ONLY EXIST ON THE ACTUAL SERIES, and a 0 can be TRUE. A carton is
// known only once a packing list has been uploaded, which happens when a
// consignment SHIPS — a plan has no cartons, and an unbooked leg has none either.
// Do NOT estimate them from units: only 27% of forecast SKUs (726/2,736) have any
// packing history and 622 of 748 packed SKUs have an inconsistent `pcsPerCtn`
// (range 4–230, median 39, mean 50), so a flat divisor would put a confident
// wrong number into a warehouse capacity plan.
//
// ⚠️ THE TWO GRAND TOTALS DO NOT MATCH, and that is real data. Plan sums
// `allocatedQty` (264,349); actual sums what shipped plus what is left
// (264,948). The 599-unit difference is genuine over-shipment on three legs
// (38 +30, 57 +120, 77 +449). Do not clamp it away — an over-ship is something a
// planner needs to see, and G2 permits it by design.

const { models } = require('../../../models');
const status = require('../statuses');
const { loadAtaByShipment, effectiveAta } = require('../receipts/ataLoader');

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
            plan: emptySeries(), actual: emptySeries(), backed: emptySeries(), lines: [] };
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
    // The PLAN date: what the PO said, regardless of what later happened to it.
    const planDate = leg.eDel || leg.etdPol || null;

    const ident = {
      poNumber: leg.poNumber,
      trnNumber: order.trnNumber || null,
      supplier,
      season: seasonCode.get(master.seasonId) || null,
      mode: modeName.get(leg.modeId) || null,
      legId: leg.id,
      crd: leg.crd || null,
      planDate: planDate,
      planWeek: weekKeyOf(planDate)?.key || null,
    };

    // ── PLAN series: the whole leg, on the PO's stated date. Placed once, even
    // for legs that have since shipped — the plan does not change because
    // reality did; that divergence is what we are trying to show.
    bucket('plan', planDate, orderFacility, orderChannel, supplier, legQty, 0);

    // ── ACTUAL series, split into mutually-exclusive parts so it reconciles.
    let counted = 0;

    // shipment legs — landed ones use their derived ATA, in-flight ones the
    // shipment's own E-DEL. Both are stronger evidence than the leg's E-DEL.
    for (const j of shipLegsByLeg[leg.id] || []) {
      const ship = shipById.get(j.shipmentId) || {};
      const qty = Number(j.expectedQuantity) || 0;
      counted += qty;
      if (qty <= 0) continue;
      const eff = effectiveAta(ataMatch, ship);
      const actualDate = eff.ata || ship.eDel || ship.etaPod || ship.etdPol || null;
      const cartonsN = cartonCount(ship.bookingId, leg.id);
      const shipFacility = facName.get(ship.facilityId) || orderFacility;
      bucket('actual', actualDate, shipFacility, orderChannel, supplier, qty, cartonsN);
      // `backed` = the SUBSET of actual that rests on a real shipment, i.e. on an
      // approved booking rather than a date typed on a PO. It is the foundation
      // the forecast can be trusted on, so it is aggregated separately with the
      // same three breakdown maps. Received and In Transit both qualify — the
      // evidence is the shipment existing, not whether it has landed yet.
      bucket('backed', actualDate, shipFacility, orderChannel, supplier, qty, cartonsN);
      const wk = weekKeyOf(actualDate);
      if (wk) {
        weekAt(wk.key, wk.weekNo, wk.year).lines.push({
          ...ident,
          stage: eff.ata ? 'Received' : 'In Transit',
          dateBasis: eff.ata ? 'receipt_ata'
                    : ship.eDel ? 'shipment_e_del'
                    : ship.etaPod ? 'shipment_eta_pod' : 'shipment_etd_pol',
          shipmentId: ship.id || null,
          shipmentNumber: ship.shipmentNumber || null,
          carrierReference: ship.carrierReference || null,
          warehouse: facName.get(ship.facilityId) || orderFacility || 'Unknown',
          channel: orderChannel || 'Unassigned',
          units: qty,
          cartons: cartonsN,
          actualDate: actualDate,
          slipDays: dayDiff(planDate, actualDate),
        });
      }
    }

    // remainder not yet shipped — no better date exists, so actual == plan and
    // these rows contribute ZERO slippage. That is the honest answer: an unbooked
    // leg has not slipped, it simply has not been committed to yet.
    const rem = legQty - counted;
    if (rem > 0) {
      bucket('actual', planDate, orderFacility, orderChannel, supplier, rem, 0);
      // The remainder can be TWO different things at once, so it is split rather
      // than labelled by whichever booking happens to touch the leg: units whose
      // consignment was cancelled are BOOKED and not shipped, while the rest was
      // never committed to. Capped at `rem` so a leg that later shipped part of a
      // cancelled quantity cannot push the split past what is actually left.
      const bookedNotShipped = approvedLegs.has(leg.id)
        ? Math.min(cancelledByLeg.get(leg.id) || 0, rem)
        : 0;
      const parts = [
        bookedNotShipped > 0 && { units: bookedNotShipped, stage: 'Booked — Not Shipped' },
        rem - bookedNotShipped > 0 && {
          units: rem - bookedNotShipped,
          stage: pendingLegs.has(leg.id) ? 'Booking Pending' : 'Awaiting Booking',
        },
      ].filter(Boolean);
      const wk = weekKeyOf(planDate);
      if (wk) {
        for (const part of parts) weekAt(wk.key, wk.weekNo, wk.year).lines.push({
          ...ident,
          stage: part.stage,
          dateBasis: leg.eDel ? 'leg_e_del' : 'leg_etd_pol',
          shipmentId: null,
          shipmentNumber: null,
          carrierReference: null,
          warehouse: orderFacility || 'Unknown',
          channel: orderChannel || 'Unassigned',
          units: part.units,
          cartons: 0,
          actualDate: planDate,
          slipDays: 0,
        });
      }
    }
  }

  // sort by real chronology (year, then week); strip the private _year field.
  // `units`/`cartons`/`warehouses`/`warehouseChannels`/`suppliers` are mirrored
  // at the top level from the ACTUAL series — that is the best-known answer, and
  // it keeps the matrix cells, the drill-down and the Actual column all reading
  // the same figure. Drill-down lines sort biggest-first: the week is opened to
  // find out what is driving it.
  return [...weeks.values()]
    .sort((a, b) => a._year - b._year || a.weekNum - b.weekNum)
    .map(({ _year, ...w }) => {
      w.lines.sort((a, b) => b.units - a.units || a.poNumber.localeCompare(b.poNumber));
      return {
        ...w,
        units: w.actual.units,
        cartons: w.actual.cartons,
        warehouses: w.actual.warehouses,
        warehouseChannels: w.actual.warehouseChannels,
        suppliers: w.actual.suppliers,
      };
    });
  };

  const bySeason = { all: rollup(legs) };
  seasonsPresent.forEach((code) => {
    bySeason[code] = rollup(legs.filter((l) => seasonOfLeg(l) === code));
  });

  res.json({ seasons: seasonsPresent, bySeason });
}

module.exports = { getMainlineForecast };
