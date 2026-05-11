const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const { verifyPassword } = require('../utils/passwordUtils');
const driveStorage = require('../driveStorage');

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
        res.json({ ...userWithoutPassword, token });
    } else {
        const err = new Error('Invalid credentials');
        err.statusCode = 401;
        throw err;
    }
}

module.exports = { login };
