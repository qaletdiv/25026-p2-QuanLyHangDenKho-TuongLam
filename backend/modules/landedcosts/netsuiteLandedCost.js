'use strict';

// Landed Costs → NetSuite Item Receipt mapping (Phase 2).
//
// SAFETY: this module BUILDS the payloads and PREVIEWS them. The live write is
// gated behind LANDED_COST_NS_PUSH === 'enabled' (default OFF) AND there is no
// push button in the UI — preview only. We are on PRODUCTION NetSuite; nothing
// posts unless the flag is deliberately armed (ideally only against a sandbox).
//
// The NetSuite record is the ITEM RECEIPT — ONE per PO (memo = PO number). Our
// per-PO split (freight/duty apportioned by CI-value share) maps to the IR's REST
// body + the landedCosts SUBLIST. Verified against IR 33552513 (2026-07-22):
//
//   memo                              = PO number
//   custbody_tt_customs_entry_number  = customs entry # (mainline)
//                                       | "<courier> <tracking#>" e.g. "FedEx 8742…" (SMS)
//   custbody16 (shipping method)      = { id } into custom LIST customlist718 —
//                                       mapped from the shipment's MODE for BOTH
//                                       modules: SEA (1) / AIR (2) / COURIER (6).
//                                       SMS falls back to COURIER when no mode is
//                                       set, which is every vendor-entered parcel.
//   landedCostMethod                  = { id: 'VALUE' }   (allocate by value; the
//                                       record ships defaulted to 'WEIGHT')
//   landedCosts.items[]              = one line per cost category with `amount`:
//                                       category id 2 = Duty, id 5 = Freight
//                                       (confirmed against the account's costcategory
//                                       table; costcategory id 6 is the retired
//                                       "Freight (old)").
//
// NOTE: the REST Record API represents landed cost as the `landedCosts` sublist —
// NOT flat `landedcostamountN` body fields (those are undefined on the REST record).
// NOTE: custbody16 is a custom LIST (customlist718: SEA=1, AIR=2, TRUCK=4,
// COURIER=6, EXPRESS=107, …), so it takes the option's INTERNAL ID, not a string.
//
// SMS used to tag COURIER unconditionally (per Lam, verified 2026-07-22). That held
// while SMS was courier-only, but SMS BOOKINGS (2026-08-07) introduced consignments
// that clear customs formally and can move by Ceva sea/air — those were still being
// posted as COURIER. Since 2026-08-24 the booking states its carrier AND mode, the
// mode rides onto the shipment at approve, and this maps it. No mode (every
// vendor-entered parcel) still means COURIER, so the original flow is unchanged.

// Cost-category internal ids (overridable via env if the account differs).
const CATEGORY_DUTY = process.env.NS_LC_CATEGORY_DUTY || '2';
const CATEGORY_FREIGHT = process.env.NS_LC_CATEGORY_FREIGHT || '5';
// Commission → landedcostamount7 → cost category id 7 (same amountN→categoryN
// convention as duty/freight). Only emitted when a split row carries commission
// (i.e. the PO's supplier has a commission rate, e.g. Pratibha 1.5%). Confirm
// against the account's costcategory table like the others were.
const CATEGORY_COMMISSION = process.env.NS_LC_CATEGORY_COMMISSION || '7';

// custbody16 shipping-method LIST (customlist718) option ids.
const SHIPMETHOD_COURIER = process.env.NS_SHIPMETHOD_COURIER_ID || '6';
const SHIPMETHOD_SEA = process.env.NS_SHIPMETHOD_SEA_ID || '1';
const SHIPMETHOD_AIR = process.env.NS_SHIPMETHOD_AIR_ID || '2';

// modes.json name → customlist718 option id. Order matters only in that 'Sea' is
// tested before 'Air'; the two names don't overlap, but keep it explicit.
function shipMethodId(mode) {
  if (!mode) return null;
  if (/sea|ocean/i.test(mode)) return SHIPMETHOD_SEA;
  if (/air/i.test(mode)) return SHIPMETHOD_AIR;
  if (/courier|parcel|express/i.test(mode)) return SHIPMETHOD_COURIER;
  return null;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Build one Item-Receipt landed-cost body per PO for a landed-cost row.
// `input`: { module, tracking_number, customs_entry_number, mode, split[] }
// `split[]`: [{ po_number, ci_value, freight, duty }]
function buildPayloads(input) {
  const isSms = input.module === 'sms';
  // A REAL customs entry number always wins — mainline always has one, and since
  // 2026-08-07 a BOOKED SMS consignment can carry one too (it clears customs
  // formally). Only an unbooked courier shipment has no entry: there we fall back
  // to courier + tracking, so the field reads e.g. "FedEx 874201930996".
  const customsEntry = input.customs_entry_number
    || (isSms ? ([input.courier, input.tracking_number].filter(Boolean).join(' ') || null) : null);

  return (input.split || []).map((s) => {
    const items = [
      { category: { id: CATEGORY_DUTY }, amount: round2(s.duty) },      // Duty
      { category: { id: CATEGORY_FREIGHT }, amount: round2(s.freight) }, // Freight
    ];
    // Commission — only when this PO carries one (supplier-scoped; e.g. Pratibha).
    const commission = round2(s.commission);
    if (commission > 0) items.push({ category: { id: CATEGORY_COMMISSION }, amount: commission }); // Commission
    const body = {
      memo: s.po_number,
      custbody_tt_customs_entry_number: customsEntry,
      landedCostMethod: { id: 'VALUE' },
      landedCosts: { items },
    };
    // shipping-method list (customlist718), mapped from the shipment's actual mode.
    // SMS falls back to COURIER (an unbooked parcel carries no mode); mainline
    // always has one, and a mode it can't map is left off rather than guessed.
    const id = shipMethodId(input.mode) || (isSms ? SHIPMETHOD_COURIER : null);
    if (id) body.custbody16 = { id };
    return { po_number: s.po_number, ci_value: s.ci_value, body };
  });
}

// The target endpoint description (no request is sent from here). One Item
// Receipt per PO; the internal id is resolved from the PO's receipt (synced
// from NetSuite) — pending until Item Receipts exist for these POs.
function targetDescriptor() {
  const accountId = (process.env.NETSUITE_ACCOUNT_ID || '<account>').toUpperCase().replace(/-/g, '_');
  return {
    record_type: 'itemReceipt',
    method: 'PATCH',
    url_template: `https://${accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/itemReceipt/{internalId}`,
    note: 'One Item Receipt per PO (memo = PO number); {internalId} resolved from the PO\'s receipt.',
  };
}

// Whether the live write is armed. FALSE in production unless explicitly set.
const pushEnabled = () => process.env.LANDED_COST_NS_PUSH === 'enabled';

// LIVE WRITE — only ever reached when pushEnabled() AND the caller supplies the
// Item Receipt internal id (we don't auto-resolve yet). PATCHes the landed-cost
// fields onto an existing Item Receipt. Not called anywhere unless armed.
async function pushOne(internalId, body) {
  const axios = require('axios');
  const { buildOAuthHeader } = require('../../services/integrationService');
  const accountId = (process.env.NETSUITE_ACCOUNT_ID || '').toLowerCase().replace(/_/g, '-');
  const url = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/itemReceipt/${internalId}`;
  const auth = buildOAuthHeader('PATCH', url);
  const res = await axios.patch(url, body, {
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  return { status: res.status, internalId };
}

module.exports = { buildPayloads, targetDescriptor, pushEnabled, pushOne, round2, shipMethodId };
