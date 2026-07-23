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

// ─── SMS landed-cost read model ──────────────────────────────────────────────
async function _smsCtx() {
  const [shipments, junctions, pos, cartons, rates, posted, suppliers, facilities, seasons, couriers, receipts, receiptLines] = await Promise.all([
    M.smsShipments.read().catch(() => []), M.smsShipmentPos.read().catch(() => []),
    M.smsPos.read().catch(() => []), M.packingCartons.read().catch(() => []),
    M.rates.read().catch(() => []), M.landedCosts.read().catch(() => []),
    M.suppliers.read().catch(() => []), M.facilities.read().catch(() => []), M.seasons.read().catch(() => []),
    M.couriers.read().catch(() => []),
    M.smsReceipts.read().catch(() => []), M.smsReceiptLines.read().catch(() => []),
  ]);
  return {
    shipments, junctions, pos, cartons, posted, receipts, receiptLines,
    smsRate: rates.find((r) => r.module === 'sms') || null,
    poByNumber: new Map(pos.map((p) => [p.po_number, p])),
    supName: new Map(suppliers.map((s) => [s.id, s.name])),
    facName: new Map(facilities.map((f) => [f.id, f.name])),
    courierName: new Map(couriers.map((cr) => [cr.id, cr.name])),
    seasonCode: new Map(seasons.map((s) => [s.id, s.code])),
    cartonsByShipment: cartons.reduce((m, c) => ((m[c.shipment_id] = m[c.shipment_id] || []).push(c), m), {}),
    postedBySms: new Map(posted.filter((p) => p.module === 'sms').map((p) => [p.shipment_id, p])),
    // push gating exposed to the UI so it can enable/disable the Post button
    pushEnabled: ns.pushEnabled(),
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
  const post = c.postedBySms.get(s.id) || null;

  // the EFFECTIVE amounts drive the per-PO split: posted snapshot if posted, else live estimate
  const eff = post ? { freight: post.freight, duty: post.duty } : { freight: estimate.freight, duty: estimate.duty };
  const split = svc.splitByPo(poValues, eff.freight, eff.duty);

  const supplierSet = [...new Set(myPos.map((po) => c.supName.get((c.poByNumber.get(po) || {}).supplier_id)).filter(Boolean))];
  const seasonSet = [...new Set(myPos.map((po) => c.seasonCode.get((c.poByNumber.get(po) || {}).season_id)).filter(Boolean))];

  // Per-PO Item Receipt match (target of the landed-cost push): resolved IR +
  // whether the shipment↔IR link has been human-confirmed (matched_shipment_id).
  const match = resolveForShipment(s.id, myPos, {
    junctions: c.junctions, cartons: c.cartons, receipts: c.receipts, receiptLines: c.receiptLines, shipments: c.shipments,
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
    pos: myPos,
    has_shipping_data: myCartons.length > 0,
    ci_value,
    estimate,                        // live estimate from current rate
    posted: post,                    // null until posted
    split,                           // per-PO split of the effective amounts
    match,                           // per-PO Item Receipt match (for confirm + push)
    ir_resolved,                     // every PO has a target IR
    matched,                         // every PO's IR match is confirmed
    push_enabled: c.pushEnabled,     // server arm switch
    push_allowed: c.pushAllow.has(String(s.id)),  // this shipment is on the allowlist
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
  const payloads = ns.buildPayloads({ module: 'sms', tracking_number: row.tracking_number, courier: row.courier, split: row.split });
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
  if (!c.smsRate) err('No SMS landed-cost rate configured — set one in Settings → Landed Cost Rates', 400);

  const row = _row(s, c);
  if (!row.has_shipping_data) err('Upload shipping data first — landed cost needs the commercial-invoice value', 400);

  // push FIRST — if NetSuite rejects, persist nothing (posted ⟺ pushed).
  const pushed = await pushToNetsuite(s, row);

  const now = new Date().toISOString();
  const record = {
    id: `lc_sms_${s.id}`,
    module: 'sms',
    shipment_id: s.id,
    invoice_value: row.ci_value,
    freight_pct: row.estimate.freight_pct,
    duty_pct: row.estimate.duty_pct,
    freight: row.estimate.freight,
    duty: row.estimate.duty,
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

// DELETE /landed-costs/:id — unpost (corrections). Removes the snapshot only.
async function unpost(req, res) {
  const all = await M.landedCosts.read().catch(() => []);
  const next = all.filter((p) => p.id !== req.params.id);
  if (next.length === all.length) err('Landed cost record not found', 404);
  await M.landedCosts.write(next);
  res.status(204).end();
}

module.exports = { getRates, putRates, getSms, postSms, unpost, netsuitePreviewSms, netsuitePushSms };
