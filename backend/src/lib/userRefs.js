'use strict';

// users is 3NF (2026-10-08): a row stores roleId / supplierId / courierId, never
// the names. This is the ONE place the names are joined back, so login, /me, the
// Users screen and the email recipient list can't disagree about who someone is.
//
//   roleId     → roles      the role's NAME is what the JWT carries and what
//                           permissions / ROLE_RULES key on
//   supplierId → suppliers  a Vendor's supplier (vendor row scoping)
//   courierId  → couriers   a Freight Forwarder's carrier (forwarder row scoping)

const { models } = require('../models');

async function loadUserRefs() {
  const [roles, suppliers, couriers] = await Promise.all([
    models.roles.read().catch(() => []),
    models.suppliers.read().catch(() => []),
    models.couriers.read().catch(() => []),
  ]);
  return {
    roles, suppliers, couriers,
    roleName:     new Map(roles.map((r) => [r.id, r.name])),
    supplierName: new Map(suppliers.map((s) => [s.id, s.name])),
    courierName:  new Map(couriers.map((c) => [c.id, c.name])),
  };
}

/** A user row with its names joined and the secrets dropped. */
function presentUser(u, refs) {
  const { password: _pw, _seq, ...rest } = u;
  return {
    ...rest,
    role: refs.roleName.get(u.roleId) ?? null,
    supplier: u.supplierId ? (refs.supplierName.get(u.supplierId) ?? null) : null,
    courier: u.courierId ? (refs.courierName.get(u.courierId) ?? null) : null,
  };
}

module.exports = { loadUserRefs, presentUser };
