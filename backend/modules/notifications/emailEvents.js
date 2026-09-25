'use strict';

// ---------------------------------------------------------------------------
// WHAT COUNTS AS A CHANGE WORTH EMAILING, and how it is described.
//
// ⚠️ THIS IS AN EVENT, AND EVENTS ARE THE ONE THING THIS PORTAL CANNOT DERIVE.
// Every other notification (see notificationService) is computed from current
// state — "a booking IS pending", "a leg IS past CRD" — and vanishes when the
// condition resolves. "A shipment WAS updated" is a fact about the PAST. It has
// no representation in the present, so it cannot be derived, and the data layer
// offers no help either: `timestamps: false` is set globally and deliberately,
// and every write is a whole-table replace, so even an `updatedAt` would be
// restamped on every row of every write. The only moment the before and after
// both exist is inside the controller. That is why these hooks live there and
// nowhere else.
//
// CURATED, NOT EXHAUSTIVE (chosen 2026-09-25). Only fields other people ACT on
// appear here. Emailing every column difference is the reliable way to get a
// notification channel muted, and a muted channel is worse than none — it reads
// as covered while nobody is reading it. Adding a field is a deliberate act:
// put it in the spec below and say why it is something a recipient must act on.
//
// Deliberately ABSENT, so the next edit does not "fix" them back in:
//   netsuiteId / netsuiteIrId  system plumbing, changes on sync, means nothing
//                              to a human and would fire on every re-sync
//   submittedAt / approvedAt   stamps that always move WITH the status change
//                              that is already being reported — reporting both
//                              says the same thing twice in one email
//   overbooked                 derived from quantities, not typed by anyone
//   _seq                       row order, an implementation detail
// ---------------------------------------------------------------------------

const DATE = 'date';
const MONEY = 'money';
const LOOKUP = 'lookup';   // an id whose NAME is what a reader needs
const PLAIN = 'plain';

/**
 * Per-entity curated field list. `lookup` names the resolver key the notifier
 * uses to turn an id into something readable — nobody can act on
 * "courierId: cour_3 → cour_1".
 */
const FIELD_SPECS = {
  mainline_booking: {
    label: 'Booking',
    fields: [
      { key: 'cargoReadyDate', label: 'Cargo Ready', type: DATE },
      { key: 'courierId', label: 'Carrier', type: LOOKUP, lookup: 'courier' },
      { key: 'incotermId', label: 'Incoterm', type: LOOKUP, lookup: 'incoterm' },
      { key: 'supplierId', label: 'Supplier', type: LOOKUP, lookup: 'supplier' },
    ],
  },
  sms_booking: {
    label: 'Booking',
    fields: [
      { key: 'cargoReadyDate', label: 'Cargo Ready', type: DATE },
      { key: 'courierId', label: 'Courier', type: LOOKUP, lookup: 'courier' },
      { key: 'modeId', label: 'Mode', type: LOOKUP, lookup: 'mode' },
      { key: 'incotermId', label: 'Incoterm', type: LOOKUP, lookup: 'incoterm' },
      { key: 'supplierId', label: 'Supplier', type: LOOKUP, lookup: 'supplier' },
    ],
  },
  mainline_shipment: {
    label: 'Shipment',
    fields: [
      // The transit chain, in the order it happens. These are the dates the
      // whole downstream plan hangs on — a moved ETD is the single most
      // consequential edit anyone makes on this screen.
      { key: 'cargoReceivedDate', label: 'Received at Port', type: DATE },
      { key: 'etdPol', label: 'ETD (POL)', type: DATE },
      { key: 'etaPod', label: 'ETA (POD)', type: DATE },
      { key: 'eDel', label: 'E-DEL', type: DATE },
      { key: 'ata', label: 'ATA', type: DATE },
      { key: 'blNo', label: 'BL #', type: PLAIN },
      { key: 'carrierReference', label: 'Carrier Ref #', type: PLAIN },
      { key: 'courierId', label: 'Carrier', type: LOOKUP, lookup: 'courier' },
      { key: 'customsEntryNumber', label: 'Customs Entry #', type: PLAIN },
      { key: 'polPortId', label: 'Port of Loading', type: LOOKUP, lookup: 'port' },
      { key: 'podPortId', label: 'Port of Discharge', type: LOOKUP, lookup: 'port' },
      { key: 'containerTypeId', label: 'Container', type: LOOKUP, lookup: 'containerType' },
      { key: 'invoiceValue', label: 'Invoice Value', type: MONEY },
      { key: 'freight', label: 'Freight', type: MONEY },
      { key: 'duty', label: 'Duty', type: MONEY },
    ],
  },
  // Receipt events are ACTS, not field edits — an Item Receipt attribution is
  // either asserted, withdrawn or refused, and there is no "from → to" to show.
  // They carry no fields on purpose; the notifier reports them via `action`.
  mainline_receipt: { label: 'Item Receipt', fields: [] },
  sms_receipt: { label: 'Item Receipt', fields: [] },

  sms_shipment: {
    label: 'Shipment',
    fields: [
      { key: 'trackingNumber', label: 'Tracking #', type: PLAIN },
      { key: 'courierId', label: 'Courier', type: LOOKUP, lookup: 'courier' },
      { key: 'shipDate', label: 'Ship Date', type: DATE },
      { key: 'modeId', label: 'Mode', type: LOOKUP, lookup: 'mode' },
      { key: 'customsEntryNumber', label: 'Customs Entry #', type: PLAIN },
      { key: 'freight', label: 'Freight', type: MONEY },
      { key: 'duty', label: 'Duty', type: MONEY },
    ],
  },
};

/**
 * Normalise a value for COMPARISON. The two halves being compared come from
 * different places — one was just parsed off a JSON request body, the other
 * came back through Sequelize — so `null` vs `''` vs `undefined` and
 * `5` vs `"5.00"` are the same edit wearing different clothes. Without this
 * every save would report phantom changes, which is exactly the noise the
 * curated list above exists to avoid.
 */
function normalize(value, type) {
  if (value === undefined || value === null || value === '') return null;
  if (type === MONEY) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(2) : String(value);
  }
  if (type === DATE) {
    // Dates arrive as 'YYYY-MM-DD' or a full ISO stamp; compare the calendar day.
    const s = String(value);
    return s.length >= 10 ? s.slice(0, 10) : s;
  }
  return String(value).trim();
}

/**
 * Compare two snapshots of one record against its curated spec.
 *
 * Only keys PRESENT in `after` are considered — a PATCH that never mentions a
 * field has not changed it, and treating an absent key as null would report
 * every unsent field as cleared.
 *
 * @returns {Array<{key,label,type,lookup,from,to}>}
 */
function diffRecord(entity, before, after) {
  const spec = FIELD_SPECS[entity];
  if (!spec) return [];
  const out = [];
  for (const f of spec.fields) {
    if (!(f.key in after)) continue;
    const from = normalize(before ? before[f.key] : null, f.type);
    const to = normalize(after[f.key], f.type);
    if (from === to) continue;
    out.push({ ...f, from: before ? before[f.key] : null, to: after[f.key] });
  }
  return out;
}

module.exports = { FIELD_SPECS, diffRecord, normalize, DATE, MONEY, LOOKUP, PLAIN };
