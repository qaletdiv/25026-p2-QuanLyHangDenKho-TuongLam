const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const { verifyPassword } = require('../utils/passwordUtils');
const driveStorage = require('../driveStorage');
const RoleModel = require('../models/RoleModel');

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
        // Inject role permissions so the frontend session carries them without an extra fetch
        const roles = await RoleModel.read().catch(() => []);
        const roleData = roles.find(r => r.name === user.role);
        const permissions = roleData?.permissions || [];
        res.json({ ...userWithoutPassword, token, permissions });
    } else {
        const err = new Error('Invalid credentials');
        err.statusCode = 401;
        throw err;
    }
}

module.exports = { login };
