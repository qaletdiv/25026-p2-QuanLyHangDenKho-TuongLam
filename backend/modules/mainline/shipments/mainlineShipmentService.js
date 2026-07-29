'use strict';

// Enrich mainline shipments for the API. A shipment is one PHYSICAL movement,
// grained on (booking, facility, mode): its shared logistics dates/status/ports/BL
// live on the header; the PO legs it carries come from the mainline_shipment_legs
// junction. Each leg is joined leg → po_number → order (facility/channel/COO) →
// TRN/supplier; CRD comes from the leg. Derived, never stored: ATA = e_del + 5.
// No courier tracking (SMS-only) — BL No. is the ocean bill of lading.

function addDays(dateStr, n) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function enrichShipments(shipments, { shipLegs = [], bookingLegs = [], packingCartons = [], legs, orders, masters, suppliers, facilities = [], channels = [], ports = [], containerTypes = [], bookings = [], modes = [], seasons = [], itemReceipts = [], itemReceiptLines = [], idToStatusName }) {
  const legById     = new Map(legs.map((l) => [l.id, l]));
  const orderByPo   = new Map(orders.map((o) => [o.po_number, o]));
  const masterByTrn = new Map(masters.map((m) => [m.trn_number, m]));
  const supName     = new Map(suppliers.map((s) => [s.id, s.name]));
  const facName     = new Map(facilities.map((f) => [f.id, f.name]));
  const chanName    = new Map(channels.map((c) => [c.id, c.name]));
  const portName    = new Map(ports.map((p) => [p.id, p.code ? `${p.name} (${p.code})` : p.name]));
  const ctName      = new Map(containerTypes.map((c) => [c.id, c.name]));
  const modeName    = new Map(modes.map((m) => [m.id, m.name]));
  const seasonCode  = new Map(seasons.map((s) => [s.id, s.code]));
  const bookingById = new Map(bookings.map((b) => [b.id, b]));

  // ── ATA source = NetSuite Item Receipts, matched to the shipment by QUANTITY and
  // SHIPPING METHOD (not just PO). A PO's received units are allocated across its
  // shipment legs FIFO by receipt date, with legs ordered by (lot, shipment) so an
  // earlier consignment (e.g. an air lot) consumes earlier receipts before a later
  // sea one. A leg's arrival = the EARLIEST receipt date at which its expected
  // quantity is met — a stray partial receipt won't set ATA early; if the full
  // quantity never arrives, the latest available receipt date is used (best effort). ──
  const qtyByReceipt = itemReceiptLines.reduce((m, l) => m.set(l.receipt_id, (m.get(l.receipt_id) || 0) + (Number(l.qty) || 0)), new Map());
  const receiptsByPo = itemReceipts.reduce((m, r) => {
    if (!r.po_number || !r.receipt_date) return m;
    (m[r.po_number] = m[r.po_number] || []).push({ date: r.receipt_date, qty: qtyByReceipt.get(r.id) || 0 });
    return m;
  }, {});
  Object.values(receiptsByPo).forEach((arr) => arr.sort((a, b) => a.date.localeCompare(b.date)));

  const legsByPoForAlloc = {};
  shipLegs.forEach((j) => {
    const po = (legById.get(j.leg_id) || {}).po_number;
    if (!po) return;
    (legsByPoForAlloc[po] = legsByPoForAlloc[po] || []).push({ shipment_id: j.shipment_id, leg_id: j.leg_id, exp: Number(j.expected_quantity) || 0, lot: Number(j.lot_number) || 0 });
  });
  const arrivalByShipLeg = new Map();   // `${shipment_id}|${leg_id}` -> arrival date (quantity-met)
  Object.entries(legsByPoForAlloc).forEach(([po, poLegs]) => {
    poLegs.sort((a, b) => a.lot - b.lot || String(a.shipment_id).localeCompare(String(b.shipment_id)));
    const receipts = (receiptsByPo[po] || []).map((r) => ({ ...r, rem: r.qty }));   // remaining qty per receipt
    for (const pl of poLegs) {
      if (!receipts.length) continue;
      let need = pl.exp, arrival = null;
      for (const r of receipts) {
        if (need <= 0) break;
        if (r.rem <= 0) continue;
        const take = Math.min(r.rem, need);
        r.rem -= take; need -= take;
        arrival = r.date;   // date this receipt (helps) satisfy the leg's quantity
      }
      arrivalByShipLeg.set(`${pl.shipment_id}|${pl.leg_id}`, arrival);
    }
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
        supplier_name:      supName.get(master.supplier_id) || null,
      };
    });
    const firstTrn = myLegs.find((l) => l.trn_number)?.trn_number || null;
    const myPos = [...new Set(myLegs.map((l) => l.po_number).filter(Boolean))];
    // ATA = the EARLIEST quantity-met arrival across this shipment's legs (see the
    // allocation above). Falls back to the manual header value until receipts sync.
    const myArrivals = myLegs.map((l) => arrivalByShipLeg.get(`${s.id}|${l.leg_id}`)).filter(Boolean).sort();
    const ataFromIr = myArrivals.length ? myArrivals[0] : null;
    return {
      ...s,
      booking_number:        booking.booking_number || null,
      status:                idToStatusName.get(s.status_id) || null,
      mode:                  modeName.get(s.mode_id) || null,
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
