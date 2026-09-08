'use strict';

// Server-side permission enforcement.
//
// Until now `permissions[]` was injected into the session at login and consumed
// ONLY by the frontend `can()` in Sidebar.tsx — which hides nav links but stops
// nothing, since the API is reachable with curl. Role checks existed in exactly
// two places (requireAdmin, plus one inline check in mainlineBookingController),
// so any valid token of any role could call e.g. PUT /master-data/suppliers.
//
// WHY PER-REQUEST, NOT FROM THE JWT
// The token carries {id, email, role} only. Resolving role → permissions from
// roles.json on each request means a permission change takes effect IMMEDIATELY
// rather than at the user's next login (the wart documented in CLAUDE.md). It also
// keeps the JWT small and avoids a second source of truth that can go stale. No
// cache, deliberately: `mainline/statuses.js` caches a table and never invalidates
// it, which is already listed as Postgres-migration debt — not repeating that for
// an authorization check.
//
// WHY "ANY OF" RATHER THAN "ALL OF"
// The permission vocabulary splits into NAV keys (purchase_orders, bookings,
// shipments, reports, forecast, contacts, settings, freight, landed_costs — page
// visibility) and ACTION keys (booking_approve, shipment_delete, po_edit, …). Some
// endpoints are legitimately reachable by more than one capability: a Vendor
// uploads their own SMS packing list via `shipments`, while Logistics does it via
// `shipment_import_export`. Passing several keys grants access when the caller has
// ANY of them, so enforcement can be added without stripping capability from a
// role that legitimately holds a different key.
//
// Admin is NOT special-cased — the Admin role in roles.json already carries every
// key, and enforcing purely from data keeps this consistent with what the frontend
// shows. An admin who edits the Admin role can still repair it, because /roles
// writes are gated by requireAdmin (a role check, not a permission check).
//
// Must run AFTER requireAuth so req.user exists — satisfied by the global auth
// gate in server.js, which every router below it sits under.

const RoleModel = require('../models/RoleModel');

/**
 * Gate a route on permission keys. Grants access if the caller's role holds ANY
 * of the listed keys.
 *
 * @param  {...string} keys  permission keys from roles.json
 * @returns {import('express').RequestHandler}
 */
function requirePermission(...keys) {
    if (!keys.length) throw new Error('requirePermission() needs at least one permission key');

    return async function permissionGate(req, res, next) {
        try {
            // Defence in depth: the global gate should have set this already.
            if (!req.user || !req.user.role) {
                return res.status(401).json({ success: false, error: 'Authentication required' });
            }

            const roles = await RoleModel.read().catch(() => []);
            const role = Array.isArray(roles) ? roles.find((r) => r.name === req.user.role) : null;

            // Unknown role → deny. A token naming a role that no longer exists
            // must not fall through to "no permissions required".
            const granted = new Set(role && Array.isArray(role.permissions) ? role.permissions : []);

            if (keys.some((k) => granted.has(k))) return next();

            return res.status(403).json({
                success: false,
                error: keys.length === 1
                    ? `Permission denied — '${keys[0]}' required`
                    : `Permission denied — one of [${keys.join(', ')}] required`,
            });
        } catch (e) {
            return next(e);
        }
    };
}

module.exports = requirePermission;
