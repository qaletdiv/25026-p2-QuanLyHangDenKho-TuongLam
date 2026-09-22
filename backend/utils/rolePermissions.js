'use strict';

// ONE resolver for "what may this role do", used by every consumer:
// middleware/requirePermission (route gating), authController.login (the session
// payload) and controllers/meController (the frontend's page gate).
//
// Resolved from roles.json PER CALL and deliberately NOT cached — a permission
// change must take effect immediately, not at the user's next login. (Same reason
// requirePermission never cached; `mainline/statuses.js` caching a table it never
// invalidates is already logged as migration debt, and this is an authorization
// answer, which is a worse thing to serve stale.)
//
// Unknown role → EMPTY set, never "no permissions required": a token naming a
// role that has since been deleted must not fall through to full access.

const RoleModel = require('../models/RoleModel');

/**
 * @param {string} roleName  role name as carried in the JWT (`req.user.role`)
 * @returns {Promise<string[]>} the role's permission keys ([] if unknown)
 */
async function permissionsForRole(roleName) {
    if (!roleName) return [];
    const roles = await RoleModel.read().catch(() => []);
    const role = Array.isArray(roles) ? roles.find((r) => r.name === roleName) : null;
    return role && Array.isArray(role.permissions) ? role.permissions : [];
}

module.exports = { permissionsForRole };
