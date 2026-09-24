const jwt = require('jsonwebtoken');
const { models } = require('../../models');
const { JWT_SECRET } = require('../../middleware/auth');
const { verifyPassword, needsRehash, hashPassword } = require('../../utils/passwordUtils');
const UserModel = models.users;
const { txOptions } = require('../../database/txContext');
const { permissionsForRole } = require('../../utils/rolePermissions');

async function login(req, res) {
    const { email, password } = req.body;
    // Query the one row rather than reading the whole table and scanning it in
    // JavaScript, which is what this did while the backend was file-based.
    const userByEmail = await UserModel.findOne({ where: { email }, raw: true });
    const user = userByEmail && await verifyPassword(password, userByEmail.password) ? userByEmail : null;

    if (user) {
        // Transparent upgrade to bcrypt. A correct login is the ONLY moment the
        // plaintext exists, so it is the only chance to re-hash an account that
        // still carries a legacy scrypt value. Guarded by the verify above —
        // re-hashing on a failed attempt would store an attacker's guess.
        //
        // Deliberately non-fatal: if this write fails the user is still
        // authenticated, because their password WAS correct. They simply get
        // upgraded on a later login instead of being handed a 500.
        if (needsRehash(user.password)) {
            try {
                // txOptions() joins the request's transaction — without it this
                // would run on a different connection and self-commit, which is
                // the same trap database/txContext.js documents.
                await UserModel.update(
                    { password: await hashPassword(password) },
                    { where: { id: user.id }, ...txOptions() },
                );
            } catch (e) {
                console.error(`[auth] could not re-hash password for ${user.email}:`, e.message);
            }
        }

        // `_seq` carries row order and is an implementation detail of the store;
        // it must not travel out in the login payload.
        const { password: _pw, _seq, ...userWithoutPassword } = user;
        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        // Seed the frontend session with the role's permissions so the first render
        // has them. This is a SNAPSHOT — it goes stale the moment a role is edited,
        // which is why the frontend re-resolves them from GET /me per navigation
        // rather than trusting this copy for access decisions.
        const permissions = await permissionsForRole(user.role);
        res.json({ ...userWithoutPassword, token, permissions });
    } else {
        const err = new Error('Invalid credentials');
        err.statusCode = 401;
        throw err;
    }
}

module.exports = { login };
