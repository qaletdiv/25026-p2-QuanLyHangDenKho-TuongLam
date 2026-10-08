'use strict';

// ---------------------------------------------------------------------------
// WHO GETS THE EMAIL. Role-based, resolved from `users` per send — so a role
// change or a new hire takes effect immediately, with nothing to re-subscribe.
//
// ⚠️ THIS IS A SEPARATE MATRIX FROM notificationService.ROLE_RULES, ON PURPOSE.
// The bell and the inbox are not the same channel and must not share one table:
//   · The bell is a STATE list. It is free to show; a stale row just disappears.
//   · Email is a PUSH. It costs the recipient attention every single time and
//     cannot be recalled, so its matrix is narrower and deliberately different.
// The clearest case is the Freight Forwarder, who sees only
// `leg_unbooked_past_crd` on the bell but is emailed on BOOKING AND SHIPMENT
// events ACROSS BOTH MODULES (Lam, 2026-09-25) — they are the party who has to
// physically act on a moved date, so email is precisely the right channel for
// them even though the bell shows them little. Collapsing the two matrices
// would silently change one of these two channels.
//
// ⚠️ THE ACTOR IS NEVER EMAILED. Telling someone what they just typed is the
// fastest way to train people to filter the sender. Excluded by user id, not by
// email — two accounts can legitimately share a mailbox.
// ---------------------------------------------------------------------------

const { models } = require('../models');
const { resolveVendorSupplierId, NO_SUPPLIER } = require('../utils/vendorScope');

// Event types this module can emit. `<entity>_status` = a lifecycle move,
// `<entity>_updated` = curated field edits, `receipt_matched` = an IR
// attribution being confirmed, rejected or withdrawn.
const EVENT_TYPES = [
  'booking_status', 'booking_updated',
  'shipment_status', 'shipment_updated',
  'receipt_matched',
];

const ALL = '*';

/**
 * role → { types, modules, scoped }
 *   types    which events, or '*' for all
 *   modules  which dataset, or '*' for both
 *   scoped   true = only records belonging to this user's own supplier
 */
const ROLE_EMAIL_RULES = {
  'Admin':                 { types: ALL, modules: ALL, scoped: false },
  'Logistics Coordinator': { types: ALL, modules: ALL, scoped: false },

  // Production plans against lifecycle moves, not against every typed field.
  // A carrier reference landing on a shipment is not their business; that
  // shipment reaching In Transit is.
  'Production':            { types: ['booking_status', 'shipment_status'], modules: ALL, scoped: false },

  // The forwarder ACTS on this mail — they move the freight. Both modules,
  // bookings included, field edits included, because a changed ETD or cargo
  // ready date is an instruction to them.
  // …but ONLY about records that name them as the carrier (2026-10-08): the
  // forwarder twin of the vendor's supplier scoping, enforced below.
  'Freight Forwarder':     { types: ['booking_status', 'booking_updated', 'shipment_status', 'shipment_updated'],
                             modules: ALL, scoped: false, courierScoped: true },

  // A vendor hears about their OWN supplier's records and nobody else's. The
  // scoping is enforced below, not here.
  'Vendor':                { types: ['booking_status', 'booking_updated', 'shipment_status', 'shipment_updated'],
                             modules: ALL, scoped: true },
};

const matches = (rule, key) => rule === ALL || (Array.isArray(rule) && rule.includes(key));

// A role created on the Roles page has no entry above, so its holders receive
// NOTHING — correct (never mail someone by guessing), but silent, and silence
// is indistinguishable from "the email feature is broken". Warned once per role
// per process so it shows up in the log without repeating on every save.
const _warnedRoles = new Set();
function warnUnknownRole(role) {
  if (!role || _warnedRoles.has(role)) return;
  _warnedRoles.add(role);
  console.warn(`[email] role "${role}" has no entry in ROLE_EMAIL_RULES — nobody holding it `
    + 'will be emailed. Add it to lib/emailRecipients.js.');
}

/**
 * Resolve the mailing list for one event.
 *
 * @param {object} ev
 * @param {string} ev.type       one of EVENT_TYPES
 * @param {string} ev.module     'mainline' | 'sms'
 * @param {string|null} ev.supplierId  the record's supplier, for vendor scoping
 * @param {string|null} [ev.courierId] the record's carrier, for forwarder scoping
 * @param {string|null} ev.actorId     the user who made the change — never mailed
 * @returns {Promise<Array<{email:string,name:string,role:string}>>}
 */
async function recipientsFor(ev) {
  const [users, roles] = await Promise.all([
    models.users.read().catch(() => []),
    models.roles.read().catch(() => []),
  ]);
  // users is 3NF: the role is users.roleId; the NAME keys ROLE_EMAIL_RULES.
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const out = [];

  for (const row of users) {
    const u = { ...row, role: roleName.get(row.roleId) ?? null };
    if (!u.email) continue;
    if (ev.actorId != null && String(u.id) === String(ev.actorId)) continue;

    const rule = ROLE_EMAIL_RULES[u.role];
    if (!rule) { warnUnknownRole(u.role); continue; }
    if (!matches(rule.types, ev.type)) continue;
    if (!matches(rule.modules, ev.module)) continue;

    if (rule.scoped) {
      // No supplier on the record means nothing to scope against. Refusing to
      // send is the safe reading: a vendor must never receive another
      // supplier's record because the attribution was merely missing.
      if (!ev.supplierId) continue;
      const sid = await resolveVendorSupplierId(u, { onUnlinked: 'deny' });
      if (sid === NO_SUPPLIER || sid == null) continue;
      if (String(sid) !== String(ev.supplierId)) continue;
    }

    if (rule.courierScoped) {
      // No carrier on the record (or a mixed batch) ⇒ no forwarder is mailed.
      if (!ev.courierId) continue;
      if (!u.courierId || String(u.courierId) !== String(ev.courierId)) continue;
    }

    out.push({ email: u.email, name: u.name || u.email, role: u.role });
  }
  return out;
}

module.exports = { recipientsFor, ROLE_EMAIL_RULES, EVENT_TYPES };
