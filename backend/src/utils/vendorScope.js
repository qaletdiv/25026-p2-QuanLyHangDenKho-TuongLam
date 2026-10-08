'use strict';

// Vendor row-scoping — the single source of truth for "which supplier is this
// caller allowed to see?".
//
// The JWT carries {id, email, role} only, so a Vendor's supplier must be resolved
// per request: users.json holds a supplier NAME (free text), suppliers.json holds
// the id. Non-vendors are UNSCOPED (null) — staff see everything.
//
// This replaced four near-identical copies (smsShipmentController,
// smsBookingController, smsPackingController, notificationController). They
// differed in ONE deliberate way, preserved here as `onUnlinked`:
//
//   'throw' — a vendor with no linked supplier gets a 403 telling them to contact
//             an admin. Correct for WRITES: failing loudly beats silently
//             accepting a write that can never be scoped.
//   'deny'  — returns the NO_SUPPLIER sentinel, which matches no row, so the
//             caller sees an empty list. Correct for READS: a misconfigured
//             account should render an empty page, not error the whole view.
//
// Never compare a supplierId against the raw sentinel value — use it only as the
// needle in a filter, where "matches nothing" is the desired outcome.

const { models } = require('../models');

// suppliers.json / users.json live in data/ root, not data/migrated
const UsersModel = models.users;
const SuppliersModel = models.suppliers;

// A value no real supplier id can equal, so `supplierId === NO_SUPPLIER` is
// always false and every filter using it yields an empty set.
const NO_SUPPLIER = '__no_supplier__';

// users is 3NF since 2026-10-08: the vendor's supplier is `users.supplierId`, an
// FK, so this is an id lookup — no name matching. (It used to match the stored
// supplier NAME with supplierKey, because "Best Star Fashions Co Ltd" on the user
// vs "Best Star Fashions Co., Ltd." on the supplier defeated an exact match.)

/**
 * Resolve the supplier a caller is restricted to.
 *
 * @param {{id: string, role: string}|undefined} user  req.user (decoded JWT)
 * @param {{onUnlinked?: 'throw'|'deny'}} [opts]
 * @returns {Promise<string|null>} supplier id, NO_SUPPLIER, or null when unscoped
 */
async function resolveVendorSupplierId(user, opts = {}) {
  const onUnlinked = opts.onUnlinked || 'throw';
  if (!user || user.role !== 'Vendor') return null;   // staff — unscoped

  const [users, suppliers] = await Promise.all([
    UsersModel.read().catch(() => []),
    SuppliersModel.read().catch(() => []),
  ]);

  // String-compare the id: users.json stores vendor ids as NUMBERS (e.g.
  // 1786561729792) while ids arriving from route params or a re-signed token are
  // strings. A strict === silently fell through to "unlinked", which on a read
  // path (onUnlinked:'deny') means the vendor sees an EMPTY list instead of an
  // error — a scoping bug that looks like missing data. ids are unique, so
  // coercing cannot create a false match.
  const u = users.find((x) => String(x.id) === String(user.id));
  const sup = u?.supplierId ? suppliers.find((s) => s.id === u.supplierId) : null;

  if (!sup) {
    if (onUnlinked === 'deny') return NO_SUPPLIER;
    const e = new Error('Your vendor account is not linked to a supplier — contact an administrator');
    e.statusCode = 403;
    throw e;
  }
  return sup.id;
}

/** True when the caller is restricted to a single supplier (i.e. is a Vendor). */
const isScoped = (vendorSupplierId) => vendorSupplierId != null;

module.exports = { resolveVendorSupplierId, isScoped, NO_SUPPLIER };
