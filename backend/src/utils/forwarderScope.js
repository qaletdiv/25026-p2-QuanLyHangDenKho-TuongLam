'use strict';

// Freight Forwarder row scoping (2026-10-08, per Lam) — the forwarder twin of
// utils/vendorScope. A forwarder sees a booking or shipment ONLY when the
// supplier chose them as its carrier: the record's courierId equals the
// forwarder's users.courierId (both FKs to the Couriers master).
//
//   not a Freight Forwarder   → null   (unscoped by this rule)
//   forwarder with a courier  → that courierId
//   forwarder with NO courier → NO_COURIER, which matches no row: an unlinked
//                               forwarder sees nothing (Lam: "if no list,
//                               freight forwarder can't see it")
//
// A record with no carrier yet ("Decide later") matches no forwarder either,
// since null never equals a courier id. Forwarders never see POs.

const { models } = require('../models');

const FORWARDER_ROLE = 'Freight Forwarder';
const NO_COURIER = '__no_courier__';

/** @returns {Promise<string|null>} courierId, NO_COURIER, or null when not a forwarder */
async function resolveForwarderCourierId(user) {
  if (!user || user.role !== FORWARDER_ROLE) return null;
  const users = await models.users.read().catch(() => []);
  const u = users.find((x) => String(x.id) === String(user.id));
  return u?.courierId || NO_COURIER;
}

/** True when a record with this courierId is visible to the forwarder scope. */
const courierMatches = (recordCourierId, forwarderCourierId) =>
  forwarderCourierId == null
  || (recordCourierId != null && String(recordCourierId) === String(forwarderCourierId));

module.exports = { resolveForwarderCourierId, courierMatches, NO_COURIER, FORWARDER_ROLE };
