'use strict';

// SMS shipments (consignments) — the VENDOR self-serves the entry: PO(s) with
// qty & cartons, one tracking number + courier per consignment. No approval step.
//
// Guards (server-side — the form is not the enforcement point):
//   G1-SMS vendor scope: a Vendor login may only ship POs whose sms_pos
//     .supplier_id matches their own supplier. Admin/Logistics are unscoped.
//   G2-SMS overship:     Σ shipped units per PO may exceed ordered total only
//     with force_overship (409 + warnings otherwise — partial lots are normal,
//     overshipping needs an explicit decision, mirroring mainline's G2).
//   lot_number is assigned server-side (max existing lot per PO + 1) — vendors
//     never manage lots.

const M = require('./SmsModels');
const status = require('./smsService');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };
const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase().replace(/\s+/g, ' '));

// Vendor scoping: JWT carries {id, role} only — resolve the vendor's supplier_id
// via users.json (supplier NAME) → suppliers.json. Null = unscoped (staff).
async function _vendorSupplierId(user) {
  if (!user || user.role !== 'Vendor') return null;
  const [users, suppliers] = await Promise.all([M.users.read(), M.suppliers.read()]);
  const u = users.find((x) => x.id === user.id);
  const sup = u?.supplier ? suppliers.find((s) => norm(s.name) === norm(u.supplier)) : null;
  if (!sup) err('Your vendor account is not linked to a supplier — contact an administrator', 403);
  return sup.id;
}

async function _ctx() {
  const [shipments, shipmentPos, pos, poLines, trackingEvents, packingCartons, codeRows, statuses, couriers, facilities, seasons, suppliers] = await Promise.all([
    M.shipments.read(), M.shipmentPos.read(), M.pos.read(), M.poLines.read(),
    M.trackingEvents.read().catch(() => []), M.packingCartons.read().catch(() => []),
    M.courierStatusMap.read().catch(() => []),
    M.statuses.read(), M.couriers.read().catch(() => []), M.facilities.read(),
    M.seasons.read().catch(() => []), M.suppliers.read().catch(() => []),
  ]);
  return {
    shipments, shipmentPos, pos, poLines, trackingEvents, packingCartons,
    codeMap: new Map(codeRows.map((r) => [`${r.courier_id}|${r.courier_code}`, r.status_id])),
    statusNameById: new Map(statuses.map((s) => [s.id, s.name])),
    smsStatuses: statuses.filter((s) => s.module === 'sms'),
    courierName: new Map(couriers.map((cr) => [cr.id, cr.name])),
    facName: new Map(facilities.map((f) => [f.id, f.name])),
    seasonCode: new Map(seasons.map((s) => [s.id, s.code])),
    supName: new Map(suppliers.map((sp) => [sp.id, sp.name])),
    poByNumber: new Map(pos.map((p) => [p.po_number, p])),
    eventsByShipment: trackingEvents.reduce((m, e) => ((m[e.shipment_id] = m[e.shipment_id] || []).push(e), m), {}),
  };
}

function _enrich(s, c) {
  const myPos = c.shipmentPos.filter((j) => j.shipment_id === s.id)
    .sort((a, b) => (a.lot_number || 0) - (b.lot_number || 0));
  const poByNumber = new Map(c.pos.map((p) => [p.po_number, p]));
  const myCartons = (c.packingCartons || []).filter((k) => k.shipment_id === s.id);
  // Carton count per PO: the vendor's declared figure, else — when they left it
  // blank at entry — the actual distinct cartons from the uploaded shipping data.
  const actualCartonsByPo = status.packingCartonsCountByPo(myCartons);
  const cartonsForPo = (j) => (j.cartons != null ? j.cartons : (actualCartonsByPo.get(j.po_number) ?? null));
  // Season & supplier are DERIVED from the shipment's POs (normally one each;
  // distinct set joined defensively) — never stored on the shipment row (3NF).
  const seasonSet = [...new Set(myPos.map((j) => c.seasonCode.get((poByNumber.get(j.po_number) || {}).season_id)).filter(Boolean))];
  const supplierSet = [...new Set(myPos.map((j) => c.supName.get((poByNumber.get(j.po_number) || {}).supplier_id)).filter(Boolean))];
  return {
    ...s,
    courier: c.courierName.get(s.courier_id) || null,
    facility: c.facName.get(s.facility_id) || null,
    season: seasonSet.join(', ') || null,
    supplier: supplierSet.join(', ') || null,
    ...status.deriveStatus(s, c.eventsByShipment, c.codeMap, c.statusNameById),
    // shipping data (derived) — present once the vendor uploads the packing Excel
    has_shipping_data: myCartons.length > 0,
    packing_summary: myCartons.length ? status.packingSummary(myCartons) : null,
    pos: myPos.map((j) => ({
      po_number: j.po_number,
      lot_number: j.lot_number,
      units: j.units,
      cartons: cartonsForPo(j),
      trn_number: (poByNumber.get(j.po_number) || {}).trn_number || null,
      supplier_id: (poByNumber.get(j.po_number) || {}).supplier_id || null,
      supplier: c.supName.get((poByNumber.get(j.po_number) || {}).supplier_id) || null,
    })),
    // consignment totals — DERIVED from the junction, never stored
    total_units: myPos.reduce((a, j) => a + (Number(j.units) || 0), 0),
    total_cartons: myPos.reduce((a, j) => a + (Number(cartonsForPo(j)) || 0), 0),
    // newest first by actual INSTANT — FedEx stamps each scan in the scan
    // location's local timezone, so a string sort scrambles mixed offsets
    tracking_events: (c.eventsByShipment[s.id] || []).slice().sort((a, b) => Date.parse(b.event_time) - Date.parse(a.event_time)),
  };
}

async function getAll(req, res) {
  const c = await _ctx();
  res.json(c.shipments.map((s) => _enrich(s, c)));
}

async function getOne(req, res) {
  const c = await _ctx();
  const s = c.shipments.find((x) => x.id === req.params.id);
  if (!s) err('SMS shipment not found', 404);
  res.json(_enrich(s, c));
}

// shared by create/update: validate PO refs, vendor scope, overship
function _checkPos(entries, c, vendorSupplierId, { excludeShipmentId = null } = {}) {
  const seen = new Set();
  const warnings = [];
  for (const e of entries) {
    if (seen.has(e.po_number)) err(`Duplicate PO '${e.po_number}' in one consignment — combine the units`, 400);
    seen.add(e.po_number);
    const po = c.pos.find((p) => p.po_number === e.po_number);
    if (!po) err(`'${e.po_number}' is not an SMS PO`, 400);
    if (vendorSupplierId && po.supplier_id !== vendorSupplierId) {
      err(`'${e.po_number}' belongs to a different supplier — you can only ship your own POs`, 403);
    }
    const ordered = c.poLines.filter((l) => l.po_number === e.po_number)
      .reduce((a, l) => a + (Number(l.ordered_qty) || 0), 0);
    const alreadyShipped = c.shipmentPos
      .filter((j) => j.po_number === e.po_number && j.shipment_id !== excludeShipmentId)
      .reduce((a, j) => a + (Number(j.units) || 0), 0);
    if (alreadyShipped + Number(e.units) > ordered) {
      warnings.push({ po_number: e.po_number, ordered, already_shipped: alreadyShipped, requested: Number(e.units) });
    }
  }
  return warnings;
}

async function create(req, res) {
  const vendorSupplierId = await _vendorSupplierId(req.user);
  const c = await _ctx();
  const { courier_id, tracking_number, ship_date, facility_id, pos: entries, force_overbook, force_overship } = req.body;

  if (!c.courierName.has(courier_id)) err(`Unknown courier_id '${courier_id}'`, 400);
  if (tracking_number && c.shipments.some((s) => s.tracking_number === tracking_number)) {
    err(`Tracking number '${tracking_number}' already exists on another shipment`, 400);
  }

  const warnings = _checkPos(entries, c, vendorSupplierId);
  if (warnings.length && !(force_overship || force_overbook)) {
    return res.status(409).json({ overship_warning: true, warnings });
  }

  const id = String(c.shipments.reduce((mx, s) => Math.max(mx, Number(s.id) || 0), 0) + 1);
  const shipment = {
    id,
    courier_id,
    tracking_number: tracking_number || null,
    ship_date: ship_date || null,
    // destination defaults to the (single) PO's facility when not sent
    facility_id: facility_id || (c.pos.find((p) => p.po_number === entries[0].po_number) || {}).facility_id || null,
    manual_status_id: 'sms_label_created',
    created_by: req.user?.id || null,
    created_at: new Date().toISOString(),
  };

  const maxLot = (poNumber) => c.shipmentPos.filter((j) => j.po_number === poNumber)
    .reduce((mx, j) => Math.max(mx, Number(j.lot_number) || 0), 0);
  const junctions = entries.map((e) => ({
    id: `spo_${id}_${e.po_number}`,
    shipment_id: id,
    po_number: e.po_number,
    lot_number: maxLot(e.po_number) + 1,        // server-owned, per PO
    units: Number(e.units),
    cartons: e.cartons != null ? Number(e.cartons) : null,
  }));

  await M.shipments.write([...c.shipments, shipment]);
  await M.shipmentPos.write([...c.shipmentPos, ...junctions]);

  const c2 = await _ctx();
  res.status(201).json(_enrich(c2.shipments.find((s) => s.id === id), c2));
}

async function update(req, res) {
  const vendorSupplierId = await _vendorSupplierId(req.user);
  const c = await _ctx();
  const idx = c.shipments.findIndex((s) => s.id === req.params.id);
  if (idx < 0) err('SMS shipment not found', 404);
  const next = { ...c.shipments[idx] };
  const myJunctions = c.shipmentPos.filter((j) => j.shipment_id === next.id);

  // a vendor may only touch consignments that carry exclusively their POs
  if (vendorSupplierId) {
    const poByNumber = new Map(c.pos.map((p) => [p.po_number, p]));
    if (!myJunctions.every((j) => (poByNumber.get(j.po_number) || {}).supplier_id === vendorSupplierId)) {
      err('This shipment carries another supplier\'s POs', 403);
    }
  }

  if (req.body.courier_id !== undefined) {
    if (!c.courierName.has(req.body.courier_id)) err(`Unknown courier_id '${req.body.courier_id}'`, 400);
    next.courier_id = req.body.courier_id;
  }
  if (req.body.tracking_number !== undefined) {
    const tn = req.body.tracking_number || null;
    if (tn && c.shipments.some((s) => s.id !== next.id && s.tracking_number === tn)) {
      err(`Tracking number '${tn}' already exists on another shipment`, 400);
    }
    next.tracking_number = tn;
  }
  if (req.body.ship_date !== undefined) next.ship_date = req.body.ship_date || null;
  if (req.body.facility_id !== undefined) next.facility_id = req.body.facility_id || null;
  if (req.body.manual_status !== undefined && req.body.manual_status) {
    const st = c.smsStatuses.find((s) => s.name === req.body.manual_status);
    if (!st) err(`'manual_status' must be one of: ${c.smsStatuses.map((s) => s.name).join(', ')}`, 400);
    next.manual_status_id = st.id;
  }

  // per-PO corrections: units/cartons on EXISTING junction rows only
  let junctions = c.shipmentPos;
  if (Array.isArray(req.body.pos)) {
    for (const e of req.body.pos) {
      if (!myJunctions.some((j) => j.po_number === e.po_number)) {
        err(`'${e.po_number}' is not on this shipment — add/remove POs by recreating the shipment`, 400);
      }
    }
    const warnings = _checkPos(req.body.pos, c, vendorSupplierId, { excludeShipmentId: next.id });
    if (warnings.length && !req.body.force_overship) {
      return res.status(409).json({ overship_warning: true, warnings });
    }
    junctions = c.shipmentPos.map((j) => {
      const e = j.shipment_id === next.id ? req.body.pos.find((x) => x.po_number === j.po_number) : null;
      return e ? { ...j, units: Number(e.units), cartons: e.cartons != null ? Number(e.cartons) : j.cartons } : j;
    });
  }

  const shipments = [...c.shipments];
  shipments[idx] = next;
  await M.shipments.write(shipments);
  if (junctions !== c.shipmentPos) await M.shipmentPos.write(junctions);

  const c2 = await _ctx();
  res.json(_enrich(c2.shipments.find((s) => s.id === next.id), c2));
}

async function remove(req, res) {
  const vendorSupplierId = await _vendorSupplierId(req.user);
  const [shipments, shipmentPos, receipts, pos] = await Promise.all([
    M.shipments.read(), M.shipmentPos.read(), M.receipts.read().catch(() => []), M.pos.read(),
  ]);
  const s = shipments.find((x) => x.id === req.params.id);
  if (!s) err('SMS shipment not found', 404);
  if (vendorSupplierId) {
    const poByNumber = new Map(pos.map((p) => [p.po_number, p]));
    const mine = shipmentPos.filter((j) => j.shipment_id === s.id)
      .every((j) => (poByNumber.get(j.po_number) || {}).supplier_id === vendorSupplierId);
    if (!mine) err('This shipment carries another supplier\'s POs', 403);
  }
  if (receipts.some((r) => r.matched_shipment_id === s.id)) {
    err('A confirmed item receipt is matched to this shipment — unmatch it first', 400);
  }
  await M.shipments.write(shipments.filter((x) => x.id !== s.id));
  await M.shipmentPos.write(shipmentPos.filter((j) => j.shipment_id !== s.id));   // cascade junction
  const events = await M.trackingEvents.read().catch(() => []);                   // cascade tracking log
  if (events.some((e) => e.shipment_id === s.id)) {
    await M.trackingEvents.write(events.filter((e) => e.shipment_id !== s.id));
  }
  const cartons = await M.packingCartons.read().catch(() => []);                  // cascade shipping data
  if (cartons.some((k) => k.shipment_id === s.id)) {
    await M.packingCartons.write(cartons.filter((k) => k.shipment_id !== s.id));
  }
  const docs = await M.documents.read().catch(() => []);                          // cascade generated docs
  if (docs.some((d) => d.shipment_id === s.id)) {
    await M.documents.write(docs.filter((d) => d.shipment_id !== s.id));
  }
  res.status(204).send();
}

module.exports = { getAll, getOne, create, update, remove };
