'use strict';

// Landed Costs — Phase 1 (SMS estimates + posting). Freight & duty are DERIVED
// from the commercial-invoice value (Σ pcs × unit_price over packing cartons)
// times the editable module rate, then apportioned per-PO by CI-value share.
// "Post" snapshots the estimate into landed_costs (estimate is final — a later
// courier bill does not change it). NOTHING is written to sms_* tables.

const M = require('./LandedCostModels');
const svc = require('./landedCostService');
const ns = require('./netsuiteLandedCost');
const { resolveForShipment } = require('../sms/receiptMatch');   // pure helper (no SMS writes)

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };
const monthOf = (isoDate) => (isoDate && /^\d{4}-\d{2}/.test(isoDate) ? isoDate.slice(0, 7) : null);

// ─── Rates (master data) ─────────────────────────────────────────────────────
async function getRates(req, res) {
  res.json(await M.rates.read().catch(() => []));
}
async function putRates(req, res) {
  // whole-table replace (mirrors the master-data editors); ids/modules validated
  await M.rates.write(req.body);
  res.json(await M.rates.read().catch(() => []));
}

// ─── Commission rates (per-supplier % of CI; SMS + mainline kept SEPARATE) ────
// e.g. Pratibha (supplier 9) = 1.5%. Whole-table replace, one endpoint per module
// so the two paths never share a table (per Lam, 2026-07-30).
async function getSmsCommissions(req, res) { res.json(await M.smsCommissions.read().catch(() => [])); }
async function putSmsCommissions(req, res) { await M.smsCommissions.write(req.body); res.json(await M.smsCommissions.read().catch(() => [])); }
async function getMlCommissions(req, res)  { res.json(await M.mlCommissions.read().catch(() => [])); }
async function putMlCommissions(req, res)  { await M.mlCommissions.write(req.body); res.json(await M.mlCommissions.read().catch(() => [])); }

// ─── SMS landed-cost read model ──────────────────────────────────────────────
async function _smsCtx() {
  const [shipments, junctions, pos, cartons, rates, posted, suppliers, facilities, seasons, couriers, modes, receipts, receiptLines, commissions, rejections] = await Promise.all([
    M.smsShipments.read().catch(() => []), M.smsShipmentPos.read().catch(() => []),
    M.smsPos.read().catch(() => []), M.packingCartons.read().catch(() => []),
    M.rates.read().catch(() => []), M.landedCosts.read().catch(() => []),
    M.suppliers.read().catch(() => []), M.facilities.read().catch(() => []), M.seasons.read().catch(() => []),
    M.couriers.read().catch(() => []), M.modes.read().catch(() => []),
    M.smsReceipts.read().catch(() => []), M.smsReceiptLines.read().catch(() => []),
    M.smsCommissions.read().catch(() => []),
    M.smsRejections.read().catch(() => []),
  ]);
  return {
    shipments, junctions, pos, cartons, posted, receipts, receiptLines, rejections,
    smsRate: rates.find((r) => r.module === 'sms') || null,
    // per-supplier commission % (e.g. Pratibha 1.5%) — SMS's OWN table
    commPctBySupplier: new Map(commissions.map((cm) => [String(cm.supplier_id), Number(cm.commission_pct) || 0])),
    poByNumber: new Map(pos.map((p) => [p.po_number, p])),
    supName: new Map(suppliers.map((s) => [s.id, s.name])),
    facName: new Map(facilities.map((f) => [f.id, f.name])),
    courierName: new Map(couriers.map((cr) => [cr.id, cr.name])),
    // Sea / Air / Courier — the shipment's actual mode, which the NS push maps to
    // custbody16. Null on a vendor-entered parcel (falls back to COURIER there).
    modeName: new Map(modes.map((m) => [m.id, m.name])),
    seasonCode: new Map(seasons.map((s) => [s.id, s.code])),
    cartonsByShipment: cartons.reduce((m, c) => ((m[c.shipment_id] = m[c.shipment_id] || []).push(c), m), {}),
    postedBySms: new Map(posted.filter((p) => p.module === 'sms').map((p) => [p.shipment_id, p])),
    // push gating exposed to the UI so it can enable/disable the Post button
    pushEnabled: ns.pushEnabled(),
    // Optional narrowing list. EMPTY = allow all (the normal production mode);
    // set it only to restrict pushes to specific shipments (e.g. a sandbox test).
    pushAllow: new Set((process.env.LANDED_COST_PUSH_ALLOWLIST || '').split(',').map((x) => x.trim()).filter(Boolean)),
  };
}

// derive one shipment's landed-cost row (estimate + effective per-PO split + posted snapshot)
function _row(s, c) {
  const myCartons = c.cartonsByShipment[s.id] || [];
  const poValues = svc.ciValueByPo(myCartons);                 // Map<po, ci_value>
  const ci_value = svc.round2([...poValues.values()].reduce((a, v) => a + v, 0));
  const myPos = c.junctions.filter((j) => j.shipment_id === s.id).map((j) => j.po_number);

  const estimate = svc.estimate(ci_value, c.smsRate);

  // BASIS (2026-08-07). A BOOKED SMS consignment behaves like mainline: freight and
  // duty are ACTUALS off the broker/courier bill, typed on the shipment — no rate,
  // no estimate. An unbooked (vendor-entered) consignment keeps the CI × rate
  // estimate. Both are DERIVED here; which one a posted row used is recoverable
  // from the snapshot (rate null ⟺ actual).
  const is_booked = !!s.booking_id;
  const actual = is_booked
    ? { freight: s.freight != null ? Number(s.freight) : null, duty: s.duty != null ? Number(s.duty) : null }
    : null;
  const has_actuals = is_booked && actual.freight != null && actual.duty != null;
  // booked but the bill hasn't arrived — NOT postable (would post $0)
  const awaiting_actual = is_booked && !has_actuals;

  // Commission — per-supplier % of each PO's CI value (e.g. Pratibha 1.5%). SMS
  // path only; computed inline here (no shared helper). A PO with no commission
  // rate for its supplier contributes 0. The total is frozen at post time (like
  // freight/duty) and re-split across the commission-eligible POs at read.
  const entries = [...poValues.entries()];                       // [ [po, ci_value], ... ]
  const commPct = (po) => c.commPctBySupplier.get(String((c.poByNumber.get(po) || {}).supplier_id)) || 0;
  const commWeights = entries.map(([po, val]) => (commPct(po) ? val : 0));   // only eligible POs weighted
  const commissionEstimate = svc.round2(entries.reduce((a, [po, val]) => a + val * commPct(po) / 100, 0));

  const post = c.postedBySms.get(s.id) || null;

  // The EFFECTIVE amounts drive the per-PO split: posted snapshot if posted, else
  // the live basis — ACTUALS for a booked consignment (0 until the bill is entered),
  // the rate estimate for an unbooked one. Commission is a % of goods value either
  // way, so it is unaffected by the booking.
  const live = is_booked
    ? { freight: actual.freight || 0, duty: actual.duty || 0 }
    : { freight: estimate.freight, duty: estimate.duty };
  const eff = post
    ? { freight: post.freight, duty: post.duty, commission: post.commission != null ? Number(post.commission) : commissionEstimate }
    : { freight: live.freight, duty: live.duty, commission: commissionEstimate };
  const commParts = svc.splitByValue(eff.commission, commWeights);
  const split = svc.splitByPo(poValues, eff.freight, eff.duty)
    .map((sp, i) => ({ ...sp, commission: commParts[i] }));
  const commission = svc.round2(split.reduce((a, x) => a + (x.commission || 0), 0));
  estimate.commission = commissionEstimate;

  const supplierSet = [...new Set(myPos.map((po) => c.supName.get((c.poByNumber.get(po) || {}).supplier_id)).filter(Boolean))];
  const seasonSet = [...new Set(myPos.map((po) => c.seasonCode.get((c.poByNumber.get(po) || {}).season_id)).filter(Boolean))];

  // Per-PO Item Receipt match (target of the landed-cost push): resolved IR +
  // whether the shipment↔IR link has been human-confirmed (matched_shipment_id).
  const match = resolveForShipment(s.id, myPos, {
    junctions: c.junctions, cartons: c.cartons, receipts: c.receipts, receiptLines: c.receiptLines,
    shipments: c.shipments, rejections: c.rejections,
  }).map((r) => ({
    po_number: r.po_number,
    receipt_id: r.target?.receipt_id || null,                    // sms_item_receipts.id (for confirm)
    netsuite_ir_id: r.target?.netsuite_ir_id || null,            // internal id — push target
    netsuite_ir_tranid: r.target?.netsuite_ir_tranid || null,    // IR document number (IR65377) — for display/reconcile
    receipt_date: r.target?.receipt_date || null,
    receipt_qty: r.target?.receipt_qty ?? null,
    shipped_pcs: r.target?.shipped_pcs ?? null,
    method: r.target?.method || 'unmatched',
    confidence: r.target?.confidence || 'low',
    confirmed: !!r.target?.confirmed,
  }));
  const ir_resolved = match.length > 0 && match.every((m) => m.netsuite_ir_id);
  const matched = match.length > 0 && match.every((m) => m.confirmed);

  return {
    module: 'sms',
    shipment_id: s.id,
    tracking_number: s.tracking_number || null,
    ship_date: s.ship_date || null,
    ship_month: monthOf(s.ship_date),
    supplier: supplierSet.join(', ') || null,
    season: seasonSet.join(', ') || null,
    facility: c.facName.get(s.facility_id) || null,
    courier: c.courierName.get(s.courier_id) || null,
    mode: c.modeName.get(s.mode_id) || null,
    pos: myPos,
    has_shipping_data: myCartons.length > 0,
    ci_value,
    // basis (derived): 'actual' for a booked consignment, 'estimate' otherwise
    is_booked,
    booking_id: s.booking_id || null,
    basis: is_booked ? 'actual' : 'estimate',
    actual,                          // {freight, duty} off the bill — null when unbooked
    has_actuals,
    awaiting_actual,                 // booked, bill not yet entered → not postable
    customs_entry_number: s.customs_entry_number || null,
    estimate,                        // live estimate from current rate (incl. commission total)
    commission,                      // effective commission total (posted snapshot or estimate)
    posted: post,                    // null until posted
    split,                           // per-PO split of the effective amounts (incl. commission)
    match,                           // per-PO Item Receipt match (for confirm + push)
    ir_resolved,                     // every PO has a target IR
    matched,                         // every PO's IR match is confirmed
    push_enabled: c.pushEnabled,     // server arm switch
    push_allowed: c.pushAllow.size === 0 ? true : c.pushAllow.has(String(s.id)),  // empty list = all allowed
  };
}

async function getSms(req, res) {
  const c = await _smsCtx();
  const rows = c.shipments.map((s) => _row(s, c))
    .sort((a, b) => String(b.ship_date || '').localeCompare(String(a.ship_date || '')));
  res.json({ rate: c.smsRate, rows });
}

// Shared push: GATES (arm switch → allowlist → resolved+confirmed match) then
// PATCH each PO's Item Receipt from the row's already-resolved match. Throws on a
// closed gate (nothing sent). Returns [{po_number, internal_id, status}].
async function pushToNetsuite(s, row) {
  if (!row.push_enabled) err('NetSuite push is DISABLED. Set LANDED_COST_NS_PUSH=enabled on the server to arm it.', 403);
  if (!row.push_allowed) err(`Shipment ${s.id} is not on the landed-cost push allowlist (LANDED_COST_PUSH_ALLOWLIST).`, 403);
  const unresolved = row.match.filter((m) => !m.netsuite_ir_id).map((m) => m.po_number);
  if (unresolved.length) err(`No Item Receipt found for: ${unresolved.join(', ')} — sync receipts first.`, 422);
  const unconfirmed = row.match.filter((m) => !m.confirmed).map((m) => m.po_number);
  if (unconfirmed.length) err(`Confirm the IR match first for: ${unconfirmed.join(', ')}.`, 422);

  const irByPo = new Map(row.match.map((m) => [m.po_number, m.netsuite_ir_id]));
  const payloads = ns.buildPayloads({
    module: 'sms', tracking_number: row.tracking_number, courier: row.courier,
    customs_entry_number: row.customs_entry_number,   // booked consignments carry a real entry #
    mode: row.mode,                                   // → custbody16; null (unbooked) = COURIER
    split: row.split,
  });
  const pushed = [];
  for (const p of payloads) pushed.push({ po_number: p.po_number, internal_id: irByPo.get(p.po_number), ...(await ns.pushOne(irByPo.get(p.po_number), p.body)) });
  return pushed;
}

// POST /landed-costs/sms/:shipmentId/post — for SMS, Post COMMITS to NetSuite:
// it PATCHes the freight/duty onto the matched Item Receipt(s) and, only if that
// succeeds, snapshots the estimate locally (so a "posted" row always reflects a
// successful NetSuite write). Requires a confirmed IR match for every PO.
async function postSms(req, res) {
  const c = await _smsCtx();
  const s = c.shipments.find((x) => x.id === req.params.shipmentId);
  if (!s) err('SMS shipment not found', 404);
  if (c.postedBySms.has(s.id)) err('Landed cost already posted for this shipment — unpost first to re-post', 409);

  const row = _row(s, c);
  if (!row.has_shipping_data) err('Upload shipping data first — landed cost needs the commercial-invoice value', 400);
  // A booked consignment posts ACTUALS; an unbooked one posts the rate estimate.
  if (row.is_booked) {
    if (row.awaiting_actual) {
      err('Enter the actual freight and duty from the bill on the shipment before posting this booked consignment', 422);
    }
  } else if (!c.smsRate) {
    err('No SMS landed-cost rate configured — set one in Settings → Landed Cost Rates', 400);
  }

  // push FIRST — if NetSuite rejects, persist nothing (posted ⟺ pushed).
  const pushed = await pushToNetsuite(s, row);

  const now = new Date().toISOString();
  // Snapshot the basis actually used. Rate pcts are NULL for a booked consignment —
  // that absence IS the record of "these were actuals off the bill", so no extra
  // column is needed to tell the two apart later.
  const record = {
    id: `lc_sms_${s.id}`,
    module: 'sms',
    shipment_id: s.id,
    invoice_value: row.ci_value,
    freight_pct: row.is_booked ? null : row.estimate.freight_pct,
    duty_pct: row.is_booked ? null : row.estimate.duty_pct,
    freight: row.is_booked ? row.actual.freight : row.estimate.freight,
    duty: row.is_booked ? row.actual.duty : row.estimate.duty,
    commission: row.commission,   // frozen commission total (per-supplier %, e.g. Pratibha)
    posted_by: req.user?.id || null,
    posted_at: now,
    netsuite_pushed_at: now,   // atomic "when pushed" fact (null = posted, not pushed)
  };
  // The pushed IR per PO is DERIVED at read from the matched receipts
  // (sms_item_receipts.matched_shipment_id) — not stored here (3NF: no repeating
  // group, no stored-derived). `pushed` is returned transiently for the client toast.
  await M.landedCosts.write([...c.posted, record]);
  res.status(201).json({ ...record, pushed });
}

// GET /landed-costs/sms/:shipmentId/netsuite-preview — the exact Item-Receipt
// payloads that WOULD be pushed (one per PO). Sends NOTHING; preview only.
async function netsuitePreviewSms(req, res) {
  const c = await _smsCtx();
  const s = c.shipments.find((x) => x.id === req.params.shipmentId);
  if (!s) err('SMS shipment not found', 404);
  const row = _row(s, c);

  // The target IR per PO is already resolved on the row (row.match). One IR per PO;
  // a PO may have several IRs (one per received lot) so the match ties this
  // shipment's lot to its IR (quantity → sequence; confirmed wins).
  const matchByPo = new Map(row.match.map((m) => [m.po_number, m]));
  const payloads = ns.buildPayloads({
    module: 'sms',
    tracking_number: row.tracking_number,
    courier: row.courier,
    customs_entry_number: row.customs_entry_number,   // booked consignments carry a real entry #
    mode: row.mode,                                   // → custbody16; null (unbooked) = COURIER
    split: row.split,
  }).map((p) => ({ ...p, target_receipt: matchByPo.get(p.po_number) || null }));

  res.json({
    module: 'sms',
    shipment_id: s.id,
    source: row.posted ? 'posted' : 'estimate',   // amounts come from posted snapshot if posted
    ci_value: row.ci_value,
    push_enabled: row.push_enabled,
    push_allowed: row.push_allowed,
    target: ns.targetDescriptor(),
    payloads,
    // POs whose target IR could not be resolved — a push cannot proceed for these
    unresolved: payloads.filter((p) => !p.target_receipt || !p.target_receipt.netsuite_ir_id).map((p) => p.po_number),
  });
}

// POST /landed-costs/sms/:shipmentId/netsuite-push — standalone (re-)push of an
// ALREADY-posted landed cost. postSms already pushes on first Post; this covers a
// manual re-push (e.g. after a NetSuite hiccup). Same gates via pushToNetsuite.
async function netsuitePushSms(req, res) {
  const c = await _smsCtx();
  const s = c.shipments.find((x) => x.id === req.params.shipmentId);
  if (!s) err('SMS shipment not found', 404);
  const row = _row(s, c);
  if (!row.posted) err('Post the landed cost before pushing to NetSuite', 400);
  const pushed = await pushToNetsuite(s, row);
  res.json({ shipment_id: s.id, pushed });
}

// ─── MAINLINE landed-cost read model ─────────────────────────────────────────
// Freight & duty are entered on the SHIPMENT (mainline_shipments.freight/duty);
// here they are split per PO by CI-value share and matched to each PO's Item
// Receipt. The Landed Cost page is READ-ONLY for amounts — it only matches the IR
// and posts (which pushes to NetSuite). Everything is derived at read; posting
// snapshots into landed_costs (module='mainline').
async function _mainlineCtx() {
  const [shipments, shipmentLegs, poLegs, poOrders, cartons, receipts, receiptLines, posted, facilities, modes, poMasters, commissions, rejections, couriers, rates] = await Promise.all([
    M.mlShipments.read().catch(() => []), M.mlShipmentLegs.read().catch(() => []), M.mlPoLegs.read().catch(() => []),
    M.poOrders.read().catch(() => []), M.mlPackingCartons.read().catch(() => []),
    M.mlReceipts.read().catch(() => []), M.mlReceiptLines.read().catch(() => []),
    M.landedCosts.read().catch(() => []), M.facilities.read().catch(() => []), M.modes.read().catch(() => []),
    M.poMasters.read().catch(() => []), M.mlCommissions.read().catch(() => []),
    M.mlRejections.read().catch(() => []),
    M.couriers.read().catch(() => []), M.rates.read().catch(() => []),
  ]);
  // PO → supplier resolves via po_orders.trn_number → po_masters.supplier_id
  // (mainline po_orders carry no supplier; it lives at the master level).
  const supByTrn = new Map(poMasters.map((m) => [m.trn_number, m.supplier_id]));
  return {
    mlShipments: shipments, mlShipmentLegs: shipmentLegs, mlPackingCartons: cartons,
    mlReceipts: receipts, mlReceiptLines: receiptLines, mlRejections: rejections, posted,
    poByLeg: new Map(poLegs.map((l) => [l.id, l.po_number])),
    supplierByPo: new Map(poOrders.map((o) => [o.po_number, supByTrn.get(o.trn_number) || null])),
    // per-supplier commission % (e.g. Pratibha 1.5%) — mainline's OWN table
    commPctBySupplier: new Map(commissions.map((cm) => [String(cm.supplier_id), Number(cm.commission_pct) || 0])),
    facName: new Map(facilities.map((f) => [f.id, f.name])),
    modeName: new Map(modes.map((m) => [m.id, m.name])),
    // Carrier drives the mainline BASIS (2026-08-24). A carrier that does not invoice
    // freight & duty separately (FedEx/DHL) leaves finance nothing to trace, so the
    // landed cost is ESTIMATED from the commercial-invoice value; a forwarder (Ceva)
    // does invoice them, so the typed actuals are used. SMS is untouched — it keeps
    // its own booked/unbooked rule and its own path.
    courierById: new Map(couriers.map((cr) => [cr.id, cr])),
    mlRate: rates.find((r) => r.module === 'mainline') || null,
    // per-PO posted snapshots (new model: one landed_cost per shipment+PO) + legacy
    // shipment-level snapshots (no po_number) that still mark all the shipment's POs posted
    postedByMlPo: new Map(posted.filter((p) => p.module === 'mainline' && p.po_number).map((p) => [`${p.shipment_id}|${p.po_number}`, p])),
    postedByMlShip: new Map(posted.filter((p) => p.module === 'mainline' && !p.po_number).map((p) => [p.shipment_id, p])),
    pushEnabled: ns.pushEnabled(),
    pushAllow: new Set((process.env.LANDED_COST_PUSH_ALLOWLIST || '').split(',').map((x) => x.trim()).filter(Boolean)),
  };
}

// Resolve the target IR per PO for a mainline shipment. Moved to
// modules/mainline/receipts/mainlineReceiptMatch.js so the ATA derivation in
// mainlineShipmentService uses the SAME attribution instead of its own date-FIFO
// (which disagreed on 12 of 17 shipment-legs). Behaviour here is unchanged.
const { resolveMainlineReceipts } = require('../mainline/receipts/mainlineReceiptMatch');

function _mlRow(s, c) {
  const legIds = new Set(c.mlShipmentLegs.filter((x) => x.shipment_id === s.id).map((x) => x.leg_id));
  const myPos = [...new Set([...legIds].map((lid) => c.poByLeg.get(lid)).filter(Boolean))];

  // CI value per PO from this shipment's packing cartons (Σ pcs × unit_price / total_usd).
  // Scope on BOOKING + leg, never the leg alone: a leg is (po_number + mode + crd), so
  // the SAME leg is re-booked for every lot of that PO (leg 77 = PO04728 sits on bookings
  // 4, 6, 8, 9). Filtering on leg_id only summed EVERY lot's cartons into EVERY shipment
  // carrying that PO — inflating the CI value and, because the per-PO freight/duty split
  // is a CI-value share, mis-apportioning the amounts that get pushed to the Item Receipt.
  const myCartons = c.mlPackingCartons.filter((k) => k.booking_id === s.booking_id && legIds.has(k.leg_id));
  const poValues = new Map();
  myCartons.forEach((k) => {
    const po = c.poByLeg.get(k.leg_id);
    if (!po) return;
    const v = Number(k.total_usd) || (Number(k.pcs_per_ctn) || 0) * (Number(k.unit_price) || 0);
    poValues.set(po, svc.round2((poValues.get(po) || 0) + v));
  });
  const ci_value = svc.round2([...poValues.values()].reduce((a, v) => a + v, 0));
  const has_shipping_data = myCartons.length > 0;

  const entered_freight = s.freight != null ? Number(s.freight) : null;
  const entered_duty = s.duty != null ? Number(s.duty) : null;

  // ── BASIS (2026-08-24), keyed on the CARRIER ────────────────────────────────
  // Shipped with FedEx/DHL → finance never receives a separate freight & duty
  // invoice, so there is nothing to trace and the landed cost is ESTIMATED as
  // CI value × landed_cost_rates(module='mainline'). Shipped with a forwarder →
  // it does invoice both separately, so the typed actuals are used.
  //
  // A shipment with NO carrier resolves to 'actual' — that is every row created
  // before this change, so their figures and their posted snapshots are untouched.
  // The rule is DERIVED here per read; nothing stores a basis column.
  const courier = c.courierById.get(s.courier_id) || null;
  const is_estimate = !!courier && courier.provides_cost_invoices === false;
  const estimate = svc.estimate(ci_value, c.mlRate);

  // On the estimate basis the rate figure IS the answer — typed amounts are refused
  // upstream (mainlineShipmentController.update), so there is no second truth to
  // reconcile here, and `has_amounts` is satisfied by the estimate itself.
  const has_amounts = is_estimate
    ? !!c.mlRate && has_shipping_data          // needs a rate AND a CI value to estimate from
    : entered_freight != null && entered_duty != null;
  // Forwarder shipment whose invoices have not arrived → not postable (would post $0).
  const awaiting_actual = !is_estimate && !has_amounts;

  // Commission — per-supplier % of each PO's CI value (e.g. Pratibha 1.5%). Mainline
  // path only; computed inline here (no shared helper). Independent of the entered
  // freight/duty (it is a % of CI). Frozen per PO in the snapshot on Post.
  const commPct = (po) => c.commPctBySupplier.get(String(c.supplierByPo.get(po))) || 0;

  // Per-PO split of the LIVE totals for this basis: the CI × rate estimate for a
  // FedEx/DHL shipment, the typed actuals for a forwarder one. Posting is PER PO:
  // a posted PO overrides its share with the snapshot; the rest stay derived.
  const live = is_estimate
    ? { freight: estimate.freight, duty: estimate.duty }
    : { freight: entered_freight || 0, duty: entered_duty || 0 };
  const enteredSplit = svc.splitByPo(poValues, live.freight, live.duty);
  const match = resolveMainlineReceipts(s.id, myPos, c);
  const split = enteredSplit.map((sp) => {
    const rec = c.postedByMlPo.get(`${s.id}|${sp.po_number}`) || c.postedByMlShip.get(s.id) || null;
    const perPo = rec && rec.po_number;   // a per-PO snapshot carries its own amounts
    const liveCommission = svc.round2((sp.ci_value || 0) * commPct(sp.po_number) / 100);
    return {
      po_number: sp.po_number,
      ci_value: sp.ci_value,
      freight: perPo ? rec.freight : sp.freight,
      duty: perPo ? rec.duty : sp.duty,
      commission: perPo && rec.commission != null ? Number(rec.commission) : liveCommission,
      posted: rec ? { id: rec.id, posted_at: rec.posted_at, netsuite_pushed_at: rec.netsuite_pushed_at } : null,
    };
  });
  const freight = svc.round2(split.reduce((a, x) => a + (x.freight || 0), 0));
  const duty = svc.round2(split.reduce((a, x) => a + (x.duty || 0), 0));
  const commission = svc.round2(split.reduce((a, x) => a + (x.commission || 0), 0));
  const posted_count = split.filter((x) => x.posted).length;

  const ir_resolved = match.length > 0 && match.every((m) => m.netsuite_ir_id);
  const matched = match.length > 0 && match.every((m) => m.confirmed);

  return {
    module: 'mainline',
    shipment_id: s.id,
    shipment_number: s.shipment_number || null,
    ship_date: s.ata || s.eta_pod || null,
    ship_month: monthOf(s.ata || s.eta_pod),
    mode: c.modeName.get(s.mode_id) || null,
    facility: c.facName.get(s.facility_id) || null,
    // customs entry number is now its OWN field on the shipment (not the BL number)
    customs_entry_number: s.customs_entry_number || null,
    // carrier + the basis it implies (both DERIVED; no basis column is stored —
    // freight_pct NULL on the posted snapshot is what records "these were actuals")
    courier: courier ? courier.name : null,
    courier_id: s.courier_id || null,
    carrier_reference: s.carrier_reference || null,
    basis: is_estimate ? 'estimate' : 'actual',
    is_estimate,
    estimate,                        // live CI × rate figure (freight_pct/duty_pct included)
    awaiting_actual,                 // forwarder shipment, invoices not in yet → not postable
    pos: myPos,
    has_shipping_data,
    ci_value,
    entered_freight, entered_duty, has_amounts,
    freight, duty, commission,
    posted_count, all_posted: split.length > 0 && posted_count === split.length,
    split,
    match,
    ir_resolved, matched,
    push_enabled: c.pushEnabled,
    push_allowed: c.pushAllow.size === 0 ? true : c.pushAllow.has(String(s.id)),
  };
}

async function getMainline(req, res) {
  const c = await _mainlineCtx();
  const rows = c.mlShipments.map((s) => _mlRow(s, c))
    .sort((a, b) => String(b.ship_date || '').localeCompare(String(a.ship_date || '')));
  res.json({ rows });
}

// Push ONE PO's landed cost to its Item Receipt (posting is per PO now).
async function pushMainlineOne(s, row, poNumber) {
  if (!row.push_enabled) err('NetSuite push is DISABLED. Set LANDED_COST_NS_PUSH=enabled on the server to arm it.', 403);
  if (!row.push_allowed) err(`Shipment ${s.id} is not on the landed-cost push allowlist.`, 403);
  const m = row.match.find((x) => x.po_number === poNumber);
  if (!m || !m.netsuite_ir_id) err(`No Item Receipt found for ${poNumber}.`, 422);
  if (!m.confirmed) err(`Confirm the IR match first for ${poNumber}.`, 422);
  const sp = row.split.find((x) => x.po_number === poNumber);
  const [payload] = ns.buildPayloads({ module: 'mainline', customs_entry_number: row.customs_entry_number, mode: row.mode, split: [sp] });
  return [{ po_number: poNumber, internal_id: m.netsuite_ir_id, ...(await ns.pushOne(m.netsuite_ir_id, payload.body)) }];
}

// POST /landed-costs/mainline/:shipmentId/post { po_number } — commit ONE PO's landed
// cost to NetSuite. Each PO on a shipment is posted separately (its own IR + snapshot).
async function postMainline(req, res) {
  const c = await _mainlineCtx();
  const s = c.mlShipments.find((x) => x.id === req.params.shipmentId);
  if (!s) err('Mainline shipment not found', 404);
  const poNumber = req.body && req.body.po_number;
  if (!poNumber) err("'po_number' is required — post each PO separately", 400);
  const row = _mlRow(s, c);
  const sp = row.split.find((x) => x.po_number === poNumber);
  if (!sp) err(`PO ${poNumber} is not on shipment ${s.id}`, 404);
  if (sp.posted) err(`Landed cost already posted for ${poNumber} — unpost first to re-post`, 409);
  if (!row.has_shipping_data) err('Upload packing data first — the CI value is needed for the per-PO split', 400);
  if (row.is_estimate && !row.has_amounts) {
    err('No mainline landed-cost rate configured — set one in Settings → Landed Cost Rates', 400);
  }
  if (row.awaiting_actual) err('Enter freight and duty on the shipment first', 400);

  const pushed = await pushMainlineOne(s, row, poNumber);
  const now = new Date().toISOString();
  const record = {
    id: `lc_ml_${s.id}_${poNumber}`, module: 'mainline', shipment_id: s.id, po_number: poNumber,
    invoice_value: sp.ci_value,
    // Snapshot the basis actually used, exactly as the SMS path does: the rate pcts
    // are NULL for typed actuals, and that absence IS the record of which basis ran.
    // No `basis` column — it stays derivable from the snapshot.
    freight_pct: row.is_estimate ? row.estimate.freight_pct : null,
    duty_pct: row.is_estimate ? row.estimate.duty_pct : null,
    freight: sp.freight, duty: sp.duty, commission: sp.commission,   // commission frozen per PO
    posted_by: req.user?.id || null, posted_at: now, netsuite_pushed_at: now,
  };
  await M.landedCosts.write([...c.posted, record]);
  res.status(201).json({ ...record, pushed });
}

async function netsuitePreviewMainline(req, res) {
  const c = await _mainlineCtx();
  const s = c.mlShipments.find((x) => x.id === req.params.shipmentId);
  if (!s) err('Mainline shipment not found', 404);
  const row = _mlRow(s, c);
  const matchByPo = new Map(row.match.map((m) => [m.po_number, m]));
  const payloads = ns.buildPayloads({ module: 'mainline', customs_entry_number: row.customs_entry_number, mode: row.mode, split: row.split })
    .map((p) => ({ ...p, target_receipt: matchByPo.get(p.po_number) || null }));
  res.json({
    module: 'mainline', shipment_id: s.id, source: row.posted_count > 0 ? 'posted' : 'entered',
    ci_value: row.ci_value, push_enabled: row.push_enabled, push_allowed: row.push_allowed,
    target: ns.targetDescriptor(), payloads,
    unresolved: payloads.filter((p) => !p.target_receipt || !p.target_receipt.netsuite_ir_id).map((p) => p.po_number),
  });
}

async function netsuitePushMainline(req, res) {
  const c = await _mainlineCtx();
  const s = c.mlShipments.find((x) => x.id === req.params.shipmentId);
  if (!s) err('Mainline shipment not found', 404);
  const row = _mlRow(s, c);
  // manual re-push: push every PO whose IR match is confirmed (per PO, one IR each)
  const pushed = [];
  for (const m of row.match) {
    if (m.netsuite_ir_id && m.confirmed) pushed.push(...await pushMainlineOne(s, row, m.po_number));
  }
  if (!pushed.length) err('No confirmed IR match to push — confirm the IR match first', 400);
  res.json({ shipment_id: s.id, pushed });
}

// DELETE /landed-costs/:id — unpost (corrections). Removes the snapshot only.
async function unpost(req, res) {
  const all = await M.landedCosts.read().catch(() => []);
  const next = all.filter((p) => p.id !== req.params.id);
  if (next.length === all.length) err('Landed cost record not found', 404);
  await M.landedCosts.write(next);
  res.status(204).end();
}

module.exports = {
  getRates, putRates,
  getSmsCommissions, putSmsCommissions, getMlCommissions, putMlCommissions,
  getSms, postSms, netsuitePreviewSms, netsuitePushSms,
  getMainline, postMainline, netsuitePreviewMainline, netsuitePushMainline,
  unpost,
};
