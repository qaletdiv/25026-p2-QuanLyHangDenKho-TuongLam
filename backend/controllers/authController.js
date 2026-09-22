const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const { verifyPassword } = require('../utils/passwordUtils');
const driveStorage = require('../driveStorage');
const { permissionsForRole } = require('../utils/rolePermissions');

async function login(req, res) {
    const { email, password } = req.body;
    const users = await driveStorage.readData('users.json');
    const userByEmail = users.find(u => u.email === email);
    const user = userByEmail && await verifyPassword(password, userByEmail.password) ? userByEmail : null;

    if (user) {
        const { password, ...userWithoutPassword } = user;
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
