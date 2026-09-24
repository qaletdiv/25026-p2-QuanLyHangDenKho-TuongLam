'use strict';

// Landed Costs — Phase 1 (SMS estimates + posting). Freight & duty are DERIVED
// from the commercial-invoice value (Σ pcs × unitPrice over packing cartons)
// times the editable module rate, then apportioned per-PO by CI-value share.
// "Post" snapshots the estimate into landed_costs (estimate is final — a later
// courier bill does not change it). NOTHING is written to sms_* tables.

const M = require('./LandedCostModels');
const svc = require('./landedCostService');
const ns = require('./netsuiteLandedCost');
const xlsx = require('./landedCostExport');            // pure: rows → workbook
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
    commPctBySupplier: new Map(commissions.map((cm) => [String(cm.supplierId), Number(cm.commissionPct) || 0])),
    poByNumber: new Map(pos.map((p) => [p.poNumber, p])),
    supName: new Map(suppliers.map((s) => [s.id, s.name])),
    facName: new Map(facilities.map((f) => [f.id, f.name])),
    courierName: new Map(couriers.map((cr) => [cr.id, cr.name])),
    // Sea / Air / Courier — the shipment's actual mode, which the NS push maps to
    // custbody16. Null on a vendor-entered parcel (falls back to COURIER there).
    modeName: new Map(modes.map((m) => [m.id, m.name])),
    seasonCode: new Map(seasons.map((s) => [s.id, s.code])),
    cartonsByShipment: cartons.reduce((m, c) => ((m[c.shipmentId] = m[c.shipmentId] || []).push(c), m), {}),
    postedBySms: new Map(posted.filter((p) => p.module === 'sms').map((p) => [p.shipmentId, p])),
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
  const poValues = svc.ciValueByPo(myCartons);                 // Map<po, ciValue>
  const ciValue = svc.round2([...poValues.values()].reduce((a, v) => a + v, 0));
  const myPos = c.junctions.filter((j) => j.shipmentId === s.id).map((j) => j.poNumber);

  const estimate = svc.estimate(ciValue, c.smsRate);

  // BASIS (2026-08-07). A BOOKED SMS consignment behaves like mainline: freight and
  // duty are ACTUALS off the broker/courier bill, typed on the shipment — no rate,
  // no estimate. An unbooked (vendor-entered) consignment keeps the CI × rate
  // estimate. Both are DERIVED here; which one a posted row used is recoverable
  // from the snapshot (rate null ⟺ actual).
  const isBooked = !!s.bookingId;
  const actual = isBooked
    ? { freight: s.freight != null ? Number(s.freight) : null, duty: s.duty != null ? Number(s.duty) : null }
    : null;
  const hasActuals = isBooked && actual.freight != null && actual.duty != null;
  // booked but the bill hasn't arrived — NOT postable (would post $0)
  const awaitingActual = isBooked && !hasActuals;

  // Commission — per-supplier % of each PO's CI value (e.g. Pratibha 1.5%). SMS
  // path only; computed inline here (no shared helper). A PO with no commission
  // rate for its supplier contributes 0. The total is frozen at post time (like
  // freight/duty) and re-split across the commission-eligible POs at read.
  const entries = [...poValues.entries()];                       // [ [po, ciValue], ... ]
  const commPct = (po) => c.commPctBySupplier.get(String((c.poByNumber.get(po) || {}).supplierId)) || 0;
  const commWeights = entries.map(([po, val]) => (commPct(po) ? val : 0));   // only eligible POs weighted
  const commissionEstimate = svc.round2(entries.reduce((a, [po, val]) => a + val * commPct(po) / 100, 0));

  const post = c.postedBySms.get(s.id) || null;

  // The EFFECTIVE amounts drive the per-PO split: posted snapshot if posted, else
  // the live basis — ACTUALS for a booked consignment (0 until the bill is entered),
  // the rate estimate for an unbooked one. Commission is a % of goods value either
  // way, so it is unaffected by the booking.
  const live = isBooked
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

  const supplierSet = [...new Set(myPos.map((po) => c.supName.get((c.poByNumber.get(po) || {}).supplierId)).filter(Boolean))];
  const seasonSet = [...new Set(myPos.map((po) => c.seasonCode.get((c.poByNumber.get(po) || {}).seasonId)).filter(Boolean))];

  // Per-PO Item Receipt match (target of the landed-cost push): resolved IR +
  // whether the shipment↔IR link has been human-confirmed (matchedShipmentId).
  const match = resolveForShipment(s.id, myPos, {
    junctions: c.junctions, cartons: c.cartons, receipts: c.receipts, receiptLines: c.receiptLines,
    shipments: c.shipments, rejections: c.rejections,
  }).map((r) => ({
    poNumber: r.poNumber,
    receiptId: r.target?.receiptId || null,                    // sms_item_receipts.id (for confirm)
    netsuiteIrId: r.target?.netsuiteIrId || null,            // internal id — push target
    netsuiteIrTranid: r.target?.netsuiteIrTranid || null,    // IR document number (IR65377) — for display/reconcile
    receiptDate: r.target?.receiptDate || null,
    receiptQty: r.target?.receiptQty ?? null,
    shippedPcs: r.target?.shippedPcs ?? null,
    method: r.target?.method || 'unmatched',
    confidence: r.target?.confidence || 'low',
    confirmed: !!r.target?.confirmed,
  }));
  const irResolved = match.length > 0 && match.every((m) => m.netsuiteIrId);
  const matched = match.length > 0 && match.every((m) => m.confirmed);

  return {
    module: 'sms',
    shipmentId: s.id,
    trackingNumber: s.trackingNumber || null,
    shipDate: s.shipDate || null,
    shipMonth: monthOf(s.shipDate),
    supplier: supplierSet.join(', ') || null,
    season: seasonSet.join(', ') || null,
    facility: c.facName.get(s.facilityId) || null,
    courier: c.courierName.get(s.courierId) || null,
    mode: c.modeName.get(s.modeId) || null,
    pos: myPos,
    hasShippingData: myCartons.length > 0,
    ciValue,
    // basis (derived): 'actual' for a booked consignment, 'estimate' otherwise
    isBooked,
    bookingId: s.bookingId || null,
    basis: isBooked ? 'actual' : 'estimate',
    actual,                          // {freight, duty} off the bill — null when unbooked
    hasActuals,
    awaitingActual,                 // booked, bill not yet entered → not postable
    customsEntryNumber: s.customsEntryNumber || null,
    estimate,                        // live estimate from current rate (incl. commission total)
    commission,                      // effective commission total (posted snapshot or estimate)
    posted: post,                    // null until posted
    split,                           // per-PO split of the effective amounts (incl. commission)
    match,                           // per-PO Item Receipt match (for confirm + push)
    irResolved,                     // every PO has a target IR
    matched,                         // every PO's IR match is confirmed
    pushEnabled: c.pushEnabled,     // server arm switch
    pushAllowed: c.pushAllow.size === 0 ? true : c.pushAllow.has(String(s.id)),  // empty list = all allowed
  };
}

async function getSms(req, res) {
  const c = await _smsCtx();
  const rows = c.shipments.map((s) => _row(s, c))
    .sort((a, b) => String(b.shipDate || '').localeCompare(String(a.shipDate || '')));
  res.json({ rate: c.smsRate, rows });
}

// Shared push: GATES (arm switch → allowlist → resolved+confirmed match) then
// PATCH each PO's Item Receipt from the row's already-resolved match. Throws on a
// closed gate (nothing sent). Returns [{poNumber, internal_id, status}].
async function pushToNetsuite(s, row) {
  if (!row.pushEnabled) err('NetSuite push is DISABLED. Set LANDED_COST_NS_PUSH=enabled on the server to arm it.', 403);
  if (!row.pushAllowed) err(`Shipment ${s.id} is not on the landed-cost push allowlist (LANDED_COST_PUSH_ALLOWLIST).`, 403);
  const unresolved = row.match.filter((m) => !m.netsuiteIrId).map((m) => m.poNumber);
  if (unresolved.length) err(`No Item Receipt found for: ${unresolved.join(', ')} — sync receipts first.`, 422);
  const unconfirmed = row.match.filter((m) => !m.confirmed).map((m) => m.poNumber);
  if (unconfirmed.length) err(`Confirm the IR match first for: ${unconfirmed.join(', ')}.`, 422);

  const irByPo = new Map(row.match.map((m) => [m.poNumber, m.netsuiteIrId]));
  const payloads = ns.buildPayloads({
    module: 'sms', trackingNumber: row.trackingNumber, courier: row.courier,
    customsEntryNumber: row.customsEntryNumber,   // booked consignments carry a real entry #
    mode: row.mode,                                   // → custbody16; null (unbooked) = COURIER
    split: row.split,
  });
  const pushed = [];
  for (const p of payloads) pushed.push({ poNumber: p.poNumber, internal_id: irByPo.get(p.poNumber), ...(await ns.pushOne(irByPo.get(p.poNumber), p.body)) });
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
  if (!row.hasShippingData) err('Upload shipping data first — landed cost needs the commercial-invoice value', 400);
  // A booked consignment posts ACTUALS; an unbooked one posts the rate estimate.
  if (row.isBooked) {
    if (row.awaitingActual) {
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
    shipmentId: s.id,
    invoiceValue: row.ciValue,
    freightPct: row.isBooked ? null : row.estimate.freightPct,
    dutyPct: row.isBooked ? null : row.estimate.dutyPct,
    freight: row.isBooked ? row.actual.freight : row.estimate.freight,
    duty: row.isBooked ? row.actual.duty : row.estimate.duty,
    commission: row.commission,   // frozen commission total (per-supplier %, e.g. Pratibha)
    postedBy: req.user?.id || null,
    postedAt: now,
    netsuitePushedAt: now,   // atomic "when pushed" fact (null = posted, not pushed)
  };
  // The pushed IR per PO is DERIVED at read from the matched receipts
  // (sms_item_receipts.matchedShipmentId) — not stored here (3NF: no repeating
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
  const matchByPo = new Map(row.match.map((m) => [m.poNumber, m]));
  const payloads = ns.buildPayloads({
    module: 'sms',
    trackingNumber: row.trackingNumber,
    courier: row.courier,
    customsEntryNumber: row.customsEntryNumber,   // booked consignments carry a real entry #
    mode: row.mode,                                   // → custbody16; null (unbooked) = COURIER
    split: row.split,
  }).map((p) => ({ ...p, target_receipt: matchByPo.get(p.poNumber) || null }));

  res.json({
    module: 'sms',
    shipmentId: s.id,
    source: row.posted ? 'posted' : 'estimate',   // amounts come from posted snapshot if posted
    ciValue: row.ciValue,
    pushEnabled: row.pushEnabled,
    pushAllowed: row.pushAllowed,
    target: ns.targetDescriptor(),
    payloads,
    // POs whose target IR could not be resolved — a push cannot proceed for these
    unresolved: payloads.filter((p) => !p.target_receipt || !p.target_receipt.netsuiteIrId).map((p) => p.poNumber),
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
  res.json({ shipmentId: s.id, pushed });
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
  // PO → supplier resolves via po_orders.trnNumber → po_masters.supplierId
  // (mainline po_orders carry no supplier; it lives at the master level).
  const supByTrn = new Map(poMasters.map((m) => [m.trnNumber, m.supplierId]));
  return {
    mlShipments: shipments, mlShipmentLegs: shipmentLegs, mlPackingCartons: cartons,
    mlReceipts: receipts, mlReceiptLines: receiptLines, mlRejections: rejections, posted,
    poByLeg: new Map(poLegs.map((l) => [l.id, l.poNumber])),
    supplierByPo: new Map(poOrders.map((o) => [o.poNumber, supByTrn.get(o.trnNumber) || null])),
    // per-supplier commission % (e.g. Pratibha 1.5%) — mainline's OWN table
    commPctBySupplier: new Map(commissions.map((cm) => [String(cm.supplierId), Number(cm.commissionPct) || 0])),
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
    // shipment-level snapshots (no poNumber) that still mark all the shipment's POs posted
    postedByMlPo: new Map(posted.filter((p) => p.module === 'mainline' && p.poNumber).map((p) => [`${p.shipmentId}|${p.poNumber}`, p])),
    postedByMlShip: new Map(posted.filter((p) => p.module === 'mainline' && !p.poNumber).map((p) => [p.shipmentId, p])),
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
  const legIds = new Set(c.mlShipmentLegs.filter((x) => x.shipmentId === s.id).map((x) => x.legId));
  const myPos = [...new Set([...legIds].map((lid) => c.poByLeg.get(lid)).filter(Boolean))];

  // CI value per PO from this shipment's packing cartons (Σ pcs × unitPrice / totalUsd).
  // Scope on BOOKING + leg, never the leg alone: a leg is (poNumber + mode + crd), so
  // the SAME leg is re-booked for every lot of that PO (leg 77 = PO04728 sits on bookings
  // 4, 6, 8, 9). Filtering on legId only summed EVERY lot's cartons into EVERY shipment
  // carrying that PO — inflating the CI value and, because the per-PO freight/duty split
  // is a CI-value share, mis-apportioning the amounts that get pushed to the Item Receipt.
  const myCartons = c.mlPackingCartons.filter((k) => k.bookingId === s.bookingId && legIds.has(k.legId));
  const poValues = new Map();
  myCartons.forEach((k) => {
    const po = c.poByLeg.get(k.legId);
    if (!po) return;
    const v = Number(k.totalUsd) || (Number(k.pcsPerCtn) || 0) * (Number(k.unitPrice) || 0);
    poValues.set(po, svc.round2((poValues.get(po) || 0) + v));
  });
  const ciValue = svc.round2([...poValues.values()].reduce((a, v) => a + v, 0));
  const hasShippingData = myCartons.length > 0;

  const enteredFreight = s.freight != null ? Number(s.freight) : null;
  const enteredDuty = s.duty != null ? Number(s.duty) : null;

  // ── BASIS (2026-08-24), keyed on the CARRIER ────────────────────────────────
  // Shipped with FedEx/DHL → finance never receives a separate freight & duty
  // invoice, so there is nothing to trace and the landed cost is ESTIMATED as
  // CI value × landed_cost_rates(module='mainline'). Shipped with a forwarder →
  // it does invoice both separately, so the typed actuals are used.
  //
  // A shipment with NO carrier resolves to 'actual' — that is every row created
  // before this change, so their figures and their posted snapshots are untouched.
  // The rule is DERIVED here per read; nothing stores a basis column.
  const courier = c.courierById.get(s.courierId) || null;
  const isEstimate = !!courier && courier.providesCostInvoices === false;
  const estimate = svc.estimate(ciValue, c.mlRate);

  // On the estimate basis the rate figure IS the answer — typed amounts are refused
  // upstream (mainlineShipmentController.update), so there is no second truth to
  // reconcile here, and `hasAmounts` is satisfied by the estimate itself.
  const hasAmounts = isEstimate
    ? !!c.mlRate && hasShippingData          // needs a rate AND a CI value to estimate from
    : enteredFreight != null && enteredDuty != null;
  // Forwarder shipment whose invoices have not arrived → not postable (would post $0).
  const awaitingActual = !isEstimate && !hasAmounts;

  // Commission — per-supplier % of each PO's CI value (e.g. Pratibha 1.5%). Mainline
  // path only; computed inline here (no shared helper). Independent of the entered
  // freight/duty (it is a % of CI). Frozen per PO in the snapshot on Post.
  const commPct = (po) => c.commPctBySupplier.get(String(c.supplierByPo.get(po))) || 0;

  // Per-PO split of the LIVE totals for this basis: the CI × rate estimate for a
  // FedEx/DHL shipment, the typed actuals for a forwarder one. Posting is PER PO:
  // a posted PO overrides its share with the snapshot; the rest stay derived.
  const live = isEstimate
    ? { freight: estimate.freight, duty: estimate.duty }
    : { freight: enteredFreight || 0, duty: enteredDuty || 0 };
  const enteredSplit = svc.splitByPo(poValues, live.freight, live.duty);
  const match = resolveMainlineReceipts(s.id, myPos, c);
  const split = enteredSplit.map((sp) => {
    const rec = c.postedByMlPo.get(`${s.id}|${sp.poNumber}`) || c.postedByMlShip.get(s.id) || null;
    const perPo = rec && rec.poNumber;   // a per-PO snapshot carries its own amounts
    const liveCommission = svc.round2((sp.ciValue || 0) * commPct(sp.poNumber) / 100);
    return {
      poNumber: sp.poNumber,
      ciValue: sp.ciValue,
      freight: perPo ? rec.freight : sp.freight,
      duty: perPo ? rec.duty : sp.duty,
      commission: perPo && rec.commission != null ? Number(rec.commission) : liveCommission,
      posted: rec ? { id: rec.id, postedAt: rec.postedAt, netsuitePushedAt: rec.netsuitePushedAt } : null,
    };
  });
  const freight = svc.round2(split.reduce((a, x) => a + (x.freight || 0), 0));
  const duty = svc.round2(split.reduce((a, x) => a + (x.duty || 0), 0));
  const commission = svc.round2(split.reduce((a, x) => a + (x.commission || 0), 0));
  const postedCount = split.filter((x) => x.posted).length;

  const irResolved = match.length > 0 && match.every((m) => m.netsuiteIrId);
  const matched = match.length > 0 && match.every((m) => m.confirmed);

  return {
    module: 'mainline',
    shipmentId: s.id,
    shipmentNumber: s.shipmentNumber || null,
    shipDate: s.ata || s.etaPod || null,
    shipMonth: monthOf(s.ata || s.etaPod),
    mode: c.modeName.get(s.modeId) || null,
    facility: c.facName.get(s.facilityId) || null,
    // customs entry number is now its OWN field on the shipment (not the BL number)
    customsEntryNumber: s.customsEntryNumber || null,
    // carrier + the basis it implies (both DERIVED; no basis column is stored —
    // freightPct NULL on the posted snapshot is what records "these were actuals")
    courier: courier ? courier.name : null,
    courierId: s.courierId || null,
    carrierReference: s.carrierReference || null,
    basis: isEstimate ? 'estimate' : 'actual',
    isEstimate,
    estimate,                        // live CI × rate figure (freightPct/dutyPct included)
    awaitingActual,                 // forwarder shipment, invoices not in yet → not postable
    pos: myPos,
    hasShippingData,
    ciValue,
    enteredFreight, enteredDuty, hasAmounts,
    freight, duty, commission,
    postedCount, allPosted: split.length > 0 && postedCount === split.length,
    split,
    match,
    irResolved, matched,
    pushEnabled: c.pushEnabled,
    pushAllowed: c.pushAllow.size === 0 ? true : c.pushAllow.has(String(s.id)),
  };
}

async function getMainline(req, res) {
  const c = await _mainlineCtx();
  const rows = c.mlShipments.map((s) => _mlRow(s, c))
    .sort((a, b) => String(b.shipDate || '').localeCompare(String(a.shipDate || '')));
  res.json({ rows });
}

// ─── Excel export ────────────────────────────────────────────────────────────
// Finance and Production pull the cost book into a spreadsheet at month end. Built
// from the SAME rows the page renders, so the file cannot disagree with the screen,
// and streamed rather than written to disk (nothing to clean up, no stale copy).
// `?month=YYYY-MM` mirrors the page's own filter; omitted or `all` exports
// everything, `unscheduled` the rows with no ship date (SMS drafts).
function _filterMonth(rows, month) {
  if (!month || month === 'all') return rows;
  if (month === 'unscheduled') return rows.filter((r) => !r.shipMonth);
  return rows.filter((r) => r.shipMonth === month);
}

async function _sendExport(res, module, rows, month) {
  const buf = await xlsx.build(module, rows);
  const scope = !month || month === 'all' ? 'all' : month;
  const name = `landed-costs_${module}_${scope}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(Buffer.from(buf));
}

async function exportSms(req, res) {
  const c = await _smsCtx();
  const rows = c.shipments.map((s) => _row(s, c))
    .sort((a, b) => String(b.shipDate || '').localeCompare(String(a.shipDate || '')));
  await _sendExport(res, 'sms', _filterMonth(rows, req.query.month), req.query.month);
}

async function exportMainline(req, res) {
  const c = await _mainlineCtx();
  const rows = c.mlShipments.map((s) => _mlRow(s, c))
    .sort((a, b) => String(b.shipDate || '').localeCompare(String(a.shipDate || '')));
  await _sendExport(res, 'mainline', _filterMonth(rows, req.query.month), req.query.month);
}

// Push ONE PO's landed cost to its Item Receipt (posting is per PO now).
async function pushMainlineOne(s, row, poNumber) {
  if (!row.pushEnabled) err('NetSuite push is DISABLED. Set LANDED_COST_NS_PUSH=enabled on the server to arm it.', 403);
  if (!row.pushAllowed) err(`Shipment ${s.id} is not on the landed-cost push allowlist.`, 403);
  const m = row.match.find((x) => x.poNumber === poNumber);
  if (!m || !m.netsuiteIrId) err(`No Item Receipt found for ${poNumber}.`, 422);
  if (!m.confirmed) err(`Confirm the IR match first for ${poNumber}.`, 422);
  const sp = row.split.find((x) => x.poNumber === poNumber);
  const [payload] = ns.buildPayloads({ module: 'mainline', customsEntryNumber: row.customsEntryNumber, mode: row.mode, split: [sp] });
  return [{ poNumber: poNumber, internal_id: m.netsuiteIrId, ...(await ns.pushOne(m.netsuiteIrId, payload.body)) }];
}

// POST /landed-costs/mainline/:shipmentId/post { poNumber } — commit ONE PO's landed
// cost to NetSuite. Each PO on a shipment is posted separately (its own IR + snapshot).
async function postMainline(req, res) {
  const c = await _mainlineCtx();
  const s = c.mlShipments.find((x) => x.id === req.params.shipmentId);
  if (!s) err('Mainline shipment not found', 404);
  const poNumber = req.body && req.body.poNumber;
  if (!poNumber) err("'poNumber' is required — post each PO separately", 400);
  const row = _mlRow(s, c);
  const sp = row.split.find((x) => x.poNumber === poNumber);
  if (!sp) err(`PO ${poNumber} is not on shipment ${s.id}`, 404);
  if (sp.posted) err(`Landed cost already posted for ${poNumber} — unpost first to re-post`, 409);
  if (!row.hasShippingData) err('Upload packing data first — the CI value is needed for the per-PO split', 400);
  if (row.isEstimate && !row.hasAmounts) {
    err('No mainline landed-cost rate configured — set one in Settings → Landed Cost Rates', 400);
  }
  if (row.awaitingActual) err('Enter freight and duty on the shipment first', 400);

  const pushed = await pushMainlineOne(s, row, poNumber);
  const now = new Date().toISOString();
  const record = {
    id: `lc_ml_${s.id}_${poNumber}`, module: 'mainline', shipmentId: s.id, poNumber: poNumber,
    invoiceValue: sp.ciValue,
    // Snapshot the basis actually used, exactly as the SMS path does: the rate pcts
    // are NULL for typed actuals, and that absence IS the record of which basis ran.
    // No `basis` column — it stays derivable from the snapshot.
    freightPct: row.isEstimate ? row.estimate.freightPct : null,
    dutyPct: row.isEstimate ? row.estimate.dutyPct : null,
    freight: sp.freight, duty: sp.duty, commission: sp.commission,   // commission frozen per PO
    postedBy: req.user?.id || null, postedAt: now, netsuitePushedAt: now,
  };
  await M.landedCosts.write([...c.posted, record]);
  res.status(201).json({ ...record, pushed });
}

async function netsuitePreviewMainline(req, res) {
  const c = await _mainlineCtx();
  const s = c.mlShipments.find((x) => x.id === req.params.shipmentId);
  if (!s) err('Mainline shipment not found', 404);
  const row = _mlRow(s, c);
  const matchByPo = new Map(row.match.map((m) => [m.poNumber, m]));
  const payloads = ns.buildPayloads({ module: 'mainline', customsEntryNumber: row.customsEntryNumber, mode: row.mode, split: row.split })
    .map((p) => ({ ...p, target_receipt: matchByPo.get(p.poNumber) || null }));
  res.json({
    module: 'mainline', shipmentId: s.id, source: row.postedCount > 0 ? 'posted' : 'entered',
    ciValue: row.ciValue, pushEnabled: row.pushEnabled, pushAllowed: row.pushAllowed,
    target: ns.targetDescriptor(), payloads,
    unresolved: payloads.filter((p) => !p.target_receipt || !p.target_receipt.netsuiteIrId).map((p) => p.poNumber),
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
    if (m.netsuiteIrId && m.confirmed) pushed.push(...await pushMainlineOne(s, row, m.poNumber));
  }
  if (!pushed.length) err('No confirmed IR match to push — confirm the IR match first', 400);
  res.json({ shipmentId: s.id, pushed });
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
  exportSms, exportMainline,
  unpost,
};
