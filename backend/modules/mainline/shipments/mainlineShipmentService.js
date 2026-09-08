'use strict';

// Enrich mainline shipments for the API. A shipment is one PHYSICAL movement,
// grained on (booking, facility, mode): its shared logistics dates/status/ports/BL
// live on the header; the PO legs it carries come from the mainline_shipment_legs
// junction. Each leg is joined leg → po_number → order (facility/channel/COO) →
// TRN/supplier; CRD comes from the leg. Derived, never stored: ATA = e_del + 5.
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
  const orderByPo   = new Map(orders.map((o) => [o.po_number, o]));
  const masterByTrn = new Map(masters.map((m) => [m.trn_number, m]));
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
    poByLeg: new Map(legs.map((l) => [l.id, l.po_number])),
  });

  const legsByShip = shipLegs.reduce((m, j) => { (m[j.shipment_id] = m[j.shipment_id] || []).push(j); return m; }, {});
  // cartons are the booking's per-leg actual (mainline_booking_po_legs.cartons)
  const cartonsByBookingLeg = new Map(bookingLegs.map((bl) => [`${bl.booking_id}|${bl.leg_id}`, bl.cartons]));
  // invoice value per (booking, leg) = Σ total_usd from the packing list (CI upload)
  const valueByBookingLeg = packingCartons.reduce((m, p) => {
    const k = `${p.booking_id}|${p.leg_id}`;
    m.set(k, (m.get(k) || 0) + (Number(p.total_usd) || 0));
    return m;
  }, new Map());
  // SHIPPED actuals per (booking, leg), straight off the uploaded shipping data —
  // units = Σ pcs_per_ctn, cartons = COUNT DISTINCT ctn_number. Both are the same
  // derivation the CI lines use (ciLines.js), so the PO view and the invoice agree.
  //
  // Keyed on (booking, leg) because mainline_packing_cartons carries no shipment_id.
  // That is not a lossy join: a leg has ONE destination facility (its order) and ONE
  // mode, and shipment grain is (booking, facility, mode) — so within a booking a leg
  // can only ever ride one shipment. Verified 0 ambiguous pairs of 17 on live data.
  //
  // pcs_per_ctn is per (carton × SKU) so summing is correct and order-independent;
  // this deliberately touches none of the weight columns, which ARE repeated at SKU
  // grain on this table (the mainline_packing_cartons split noted in CLAUDE.md).
  const shippedByBookingLeg = packingCartons.reduce((m, p) => {
    const k = `${p.booking_id}|${p.leg_id}`;
    const e = m.get(k) || { qty: 0, ctns: new Set() };
    e.qty += Number(p.pcs_per_ctn) || 0;
    if (p.ctn_number != null) e.ctns.add(p.ctn_number);
    m.set(k, e);
    return m;
  }, new Map());

  return shipments.map((s) => {
    const booking = bookingById.get(s.booking_id) || {};
    const myLegs = (legsByShip[s.id] || []).map((j) => {
      const leg = legById.get(j.leg_id) || {};
      const order = orderByPo.get(leg.po_number) || {};
      const master = masterByTrn.get(order.trn_number) || {};
      return {
        leg_id:             j.leg_id,
        po_number:          leg.po_number || null,
        netsuite_id:        order.netsuite_id || null,   // component-PO NS internal id
        trn_number:         order.trn_number || null,
        season:             seasonCode.get(master.season_id) || null,
        mode_id:            leg.mode_id || null,
        mode:               modeName.get(leg.mode_id) || null,
        allocation_channel: chanName.get(order.allocation_channel_id) || null,
        coo:                order.coo_country || null,
        crd:                leg.crd || null,
        lot_number:         j.lot_number ?? null,
        cartons:            cartonsByBookingLeg.get(`${s.booking_id}|${j.leg_id}`) ?? null,
        invoice_value:      valueByBookingLeg.get(`${s.booking_id}|${j.leg_id}`) ?? null,
        expected_quantity:  Number(j.expected_quantity) || 0,
        // Actuals from the shipping-data upload. NULL (not 0) when nothing has been
        // uploaded for this leg yet — a blank must never read as "shipped nothing".
        shipped_qty:        (shippedByBookingLeg.get(`${s.booking_id}|${j.leg_id}`) || {}).qty ?? null,
        shipped_cartons:    shippedByBookingLeg.has(`${s.booking_id}|${j.leg_id}`)
                              ? shippedByBookingLeg.get(`${s.booking_id}|${j.leg_id}`).ctns.size
                              : null,
        supplier_name:      supName.get(master.supplier_id) || null,
      };
    });
    const firstTrn = myLegs.find((l) => l.trn_number)?.trn_number || null;
    const myPos = [...new Set(myLegs.map((l) => l.po_number).filter(Boolean))];
    // ATA from the shared receipt attribution (see ataMatch above): the LATEST of
    // this consignment's PO receipt dates, and null unless EVERY PO has a receipt —
    // a part-received shipment has not arrived. Falls back to the manual header
    // value until receipts sync.
    const ataFromIr = (ataMatch.get(s.id) || {}).date || null;
    return {
      ...s,
      booking_number:        booking.booking_number || null,
      status:                idToStatusName.get(s.status_id) || null,
      mode:                  modeName.get(s.mode_id) || null,
      // Carrier (joined) + the DERIVED landed-cost basis it implies. Null carrier →
      // 'actual', i.e. exactly the pre-2026-08-24 behaviour, so historical shipments
      // never flip to an estimate. Derived per read; no row stores the basis.
      courier:               (courierById.get(s.courier_id) || {}).name || null,
      landed_cost_basis:     (courierById.get(s.courier_id) || {}).provides_cost_invoices === false ? 'estimate' : 'actual',
      destination_facility:  facName.get(s.facility_id) || null,
      container_type:        ctName.get(s.container_type_id) || null,
      pol_port:              portName.get(s.pol_port_id) || null,
      pod_port:              portName.get(s.pod_port_id) || null,
      supplier_name:         supName.get(booking.supplier_id) || myLegs[0]?.supplier_name || null,
      // Actual ATA (the real day received in system) — now DERIVED from NetSuite
      // Item Receipts matching the shipment's PO(s); manual header value is the
      // fallback until receipts exist. NO e_del+5 fallback (a fabricated value
      // would make every shipment look "Received").
      ata:                   ataFromIr || s.ata || null,
      ata_source:            ataFromIr ? 'netsuite' : (s.ata ? 'manual' : null),
      // Expected ATA = E-DEL + 5 (derived, never stored). E-DEL is the WIP/PO-owned
      // input; the "received-by" expectation is delivery + 5 days of DC processing.
      expected_ata:          addDays(s.e_del, 5),
      coo:                   [...new Set(myLegs.map((l) => l.coo).filter(Boolean))],
      season:                [...new Set(myLegs.map((l) => l.season).filter(Boolean))].join(', ') || null,
      crd:                   myLegs.map((l) => l.crd).filter(Boolean).sort()[0] || null,   // earliest cargo-ready
      legs:                  myLegs,
      po_numbers:            myPos,
      trn_number:            firstTrn,
      total_expected_quantity: myLegs.reduce((a, l) => a + l.expected_quantity, 0),
    };
  });
}

module.exports = { enrichShipments };
