'use strict';

// Enrich mainline shipments for the API. A shipment is one PHYSICAL movement,
// grained on (booking, facility, mode): its shared logistics dates/status/ports/BL
// live on the header; the PO legs it carries come from the mainline_shipment_legs
// junction. Each leg is joined leg → poNumber → order (facility/channel/COO) →
// TRN/supplier; CRD comes from the leg. Derived, never stored: ATA = eDel + 5.
// No courier tracking (SMS-only) — BL No. is the ocean bill of lading.

const { ataByShipment } = require('../receipts/mainlineReceiptMatch');

function addDays(dateStr, n) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function enrichShipments(shipments, { shipLegs = [], bookingLegs = [], packingCartons = [], legs, orders, masters, suppliers, facilities = [], channels = [], ports = [], containerTypes = [], bookings = [], modes = [], seasons = [], couriers = [], itemReceipts = [], itemReceiptLines = [], receiptRejections = [], allShipments = [], idToStatusName }) {
  const legById     = new Map(legs.map((l) => [l.id, l]));
  const orderByPo   = new Map(orders.map((o) => [o.poNumber, o]));
  const masterByTrn = new Map(masters.map((m) => [m.trnNumber, m]));
  const supName     = new Map(suppliers.map((s) => [s.id, s.name]));
  // Carrier: name for display, plus the flag the Landed Costs page keys its basis on
  // (a carrier that does not invoice freight & duty separately → estimate from CI).
  const courierById = new Map(couriers.map((cr) => [cr.id, cr]));
  const facName     = new Map(facilities.map((f) => [f.id, f.name]));
  const chanName    = new Map(channels.map((c) => [c.id, c.name]));
  const portName    = new Map(ports.map((p) => [p.id, p.code ? `${p.name} (${p.code})` : p.name]));
  const ctName      = new Map(containerTypes.map((c) => [c.id, c.name]));
  const modeName    = new Map(modes.map((m) => [m.id, m.name]));
  const seasonCode  = new Map(seasons.map((s) => [s.id, s.code]));
  const bookingById = new Map(bookings.map((b) => [b.id, b]));

  // ── ATA source = NetSuite Item Receipts, attributed to the shipment by the ONE
  // shared resolver (modules/mainline/receipts/mainlineReceiptMatch): human
  // confirmation → quantity → sequence, one IR per (shipment, PO).
  //
  // This replaced a local date-FIFO allocation that asked "when had enough units
  // arrived for this PO" rather than "which receipt is this consignment's". The two
  // disagreed on 12 of 17 shipment-legs, and it was not a rounding difference: for
  // SHP-7, FIFO consumed PO04770's oldest receipt (3,132 units on 2026-06-26)
  // because it alone covered the leg's 1,271, giving an ATA twelve days before the
  // vessel reached the destination port. Landed Costs, matching on quantity, had
  // the right answer all along — so ATA now comes from the same place, and a match
  // corrected on the Landed Costs page moves the ATA too. ──
  // NB: `allShipments`, not the (possibly vendor-filtered) `shipments` argument.
  // The matcher is COMPETITIVE — an IR consumed by one consignment is unavailable
  // to the next — so every shipment carrying a PO has to be in the pool or a
  // vendor's ATA could differ from staff's for the same shipment.
  const ataMatch = ataByShipment({
    mlShipments: allShipments.length ? allShipments : shipments,
    mlShipmentLegs: shipLegs,
    mlReceipts: itemReceipts,
    mlReceiptLines: itemReceiptLines,
    mlRejections: receiptRejections,
    poByLeg: new Map(legs.map((l) => [l.id, l.poNumber])),
  });

  const legsByShip = shipLegs.reduce((m, j) => { (m[j.shipmentId] = m[j.shipmentId] || []).push(j); return m; }, {});
  // cartons are the booking's per-leg actual (mainline_booking_po_legs.cartons)
  const cartonsByBookingLeg = new Map(bookingLegs.map((bl) => [`${bl.bookingId}|${bl.legId}`, bl.cartons]));
  // invoice value per (booking, leg) = Σ totalUsd from the packing list (CI upload)
  const valueByBookingLeg = packingCartons.reduce((m, p) => {
    const k = `${p.bookingId}|${p.legId}`;
    m.set(k, (m.get(k) || 0) + (Number(p.totalUsd) || 0));
    return m;
  }, new Map());
  // SHIPPED actuals per (booking, leg), straight off the uploaded shipping data —
  // units = Σ pcsPerCtn, cartons = COUNT DISTINCT ctnNumber. Both are the same
  // derivation the CI lines use (ciLines.js), so the PO view and the invoice agree.
  //
  // Keyed on (booking, leg) because mainline_packing_cartons carries no shipmentId.
  // That is not a lossy join: a leg has ONE destination facility (its order) and ONE
  // mode, and shipment grain is (booking, facility, mode) — so within a booking a leg
  // can only ever ride one shipment. Verified 0 ambiguous pairs of 17 on live data.
  //
  // pcsPerCtn is per (carton × SKU) so summing is correct and order-independent;
  // this deliberately touches none of the weight columns, which ARE repeated at SKU
  // grain on this table (the mainline_packing_cartons split noted in CLAUDE.md).
  const shippedByBookingLeg = packingCartons.reduce((m, p) => {
    const k = `${p.bookingId}|${p.legId}`;
    const e = m.get(k) || { qty: 0, ctns: new Set() };
    e.qty += Number(p.pcsPerCtn) || 0;
    if (p.ctnNumber != null) e.ctns.add(p.ctnNumber);
    m.set(k, e);
    return m;
  }, new Map());

  return shipments.map((s) => {
    const booking = bookingById.get(s.bookingId) || {};
    const myLegs = (legsByShip[s.id] || []).map((j) => {
      const leg = legById.get(j.legId) || {};
      const order = orderByPo.get(leg.poNumber) || {};
      const master = masterByTrn.get(order.trnNumber) || {};
      return {
        legId:             j.legId,
        poNumber:          leg.poNumber || null,
        netsuiteId:        order.netsuiteId || null,   // component-PO NS internal id
        trnNumber:         order.trnNumber || null,
        season:             seasonCode.get(master.seasonId) || null,
        modeId:            leg.modeId || null,
        mode:               modeName.get(leg.modeId) || null,
        allocationChannel: chanName.get(order.allocationChannelId) || null,
        coo:                order.cooCountry || null,
        crd:                leg.crd || null,
        lotNumber:         j.lotNumber ?? null,
        cartons:            cartonsByBookingLeg.get(`${s.bookingId}|${j.legId}`) ?? null,
        invoiceValue:      valueByBookingLeg.get(`${s.bookingId}|${j.legId}`) ?? null,
        expectedQuantity:  Number(j.expectedQuantity) || 0,
        // Actuals from the shipping-data upload. NULL (not 0) when nothing has been
        // uploaded for this leg yet — a blank must never read as "shipped nothing".
        shippedQty:        (shippedByBookingLeg.get(`${s.bookingId}|${j.legId}`) || {}).qty ?? null,
        shippedCartons:    shippedByBookingLeg.has(`${s.bookingId}|${j.legId}`)
                              ? shippedByBookingLeg.get(`${s.bookingId}|${j.legId}`).ctns.size
                              : null,
        supplierName:      supName.get(master.supplierId) || null,
      };
    });
    const firstTrn = myLegs.find((l) => l.trnNumber)?.trnNumber || null;
    const myPos = [...new Set(myLegs.map((l) => l.poNumber).filter(Boolean))];
    // ATA from the shared receipt attribution (see ataMatch above): the LATEST of
    // this consignment's PO receipt dates, and null unless EVERY PO has a receipt —
    // a part-received shipment has not arrived. Falls back to the manual header
    // value until receipts sync.
    const ataFromIr = (ataMatch.get(s.id) || {}).date || null;
    return {
      ...s,
      bookingNumber:        booking.bookingNumber || null,
      status:                idToStatusName.get(s.statusId) || null,
      mode:                  modeName.get(s.modeId) || null,
      // Carrier (joined) + the DERIVED landed-cost basis it implies. Null carrier →
      // 'actual', i.e. exactly the pre-2026-08-24 behaviour, so historical shipments
      // never flip to an estimate. Derived per read; no row stores the basis.
      courier:               (courierById.get(s.courierId) || {}).name || null,
      landedCostBasis:     (courierById.get(s.courierId) || {}).providesCostInvoices === false ? 'estimate' : 'actual',
      destinationFacility:  facName.get(s.facilityId) || null,
      containerType:        ctName.get(s.containerTypeId) || null,
      polPort:              portName.get(s.polPortId) || null,
      podPort:              portName.get(s.podPortId) || null,
      supplierName:         supName.get(booking.supplierId) || myLegs[0]?.supplierName || null,
      // Actual ATA (the real day received in system) — now DERIVED from NetSuite
      // Item Receipts matching the shipment's PO(s); manual header value is the
      // fallback until receipts exist. NO eDel+5 fallback (a fabricated value
      // would make every shipment look "Received").
      ata:                   ataFromIr || s.ata || null,
      ataSource:            ataFromIr ? 'netsuite' : (s.ata ? 'manual' : null),
      // Expected ATA = E-DEL + 5 (derived, never stored). E-DEL is the WIP/PO-owned
      // input; the "received-by" expectation is delivery + 5 days of DC processing.
      expectedAta:          addDays(s.eDel, 5),
      coo:                   [...new Set(myLegs.map((l) => l.coo).filter(Boolean))],
      season:                [...new Set(myLegs.map((l) => l.season).filter(Boolean))].join(', ') || null,
      crd:                   myLegs.map((l) => l.crd).filter(Boolean).sort()[0] || null,   // earliest cargo-ready
      legs:                  myLegs,
      poNumbers:            myPos,
      trnNumber:            firstTrn,
      totalExpectedQuantity: myLegs.reduce((a, l) => a + l.expectedQuantity, 0),
    };
  });
}

module.exports = { enrichShipments };
