'use strict';

// GET /me — who the CALLER is, with permissions resolved right now.
//
// Why this exists: `permissions[]` used to reach the frontend only once, in the
// login response, and got stored in the session cookie. So revoking a permission
// changed nothing on screen until that user logged out and back in — the nav item
// stayed, and (before the page gate) the page itself stayed reachable. The
// frontend route gate needs the CURRENT answer on every navigation, and it must
// come from the server: the session cookie is data the browser holds, so it can
// never be the basis of an authorization decision.
//
// Identity comes from the verified JWT (`req.user`, set by the global auth gate),
// never from the request body/query — this endpoint cannot be asked about someone
// else. Auth-only: every authenticated caller may ask about themselves.

const { permissionsForRole } = require('../../utils/rolePermissions');
const { models } = require('../../models');
const UserModel = models.users;

async function me(req, res) {
    const { id, email, role } = req.user || {};
    const permissions = await permissionsForRole(role);

    // name/supplier are display + vendor-scope fields the session already carries;
    // read them back so a single call can refresh the whole session. A user row
    // that has since been deleted still gets its token's claims back (the token
    // stays valid until it expires) but no profile fields.
    const row = await UserModel.findByPk(id, { raw: true }).catch(() => null);

    res.json({
        id,
        email,
        role,
        name: row?.name ?? null,
        supplier: row?.supplier ?? null,
        permissions,
    });
}

module.exports = { me };
