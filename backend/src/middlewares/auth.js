const jwt = require('jsonwebtoken');

// No fallback by design. A hardcoded default would live in source control, which
// means anyone who has ever seen the repo could forge an Admin token — so refuse
// to boot instead. Set JWT_SECRET in backend/.env (see .env.example).
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error(
        'JWT_SECRET is not set. Generate one and add it to backend/.env:\n' +
        "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\""
    );
}

function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    const token = authHeader.slice(7);
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

module.exports = requireAuth;
module.exports.JWT_SECRET = JWT_SECRET;
