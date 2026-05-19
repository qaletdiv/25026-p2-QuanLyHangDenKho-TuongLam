const requireAuth = require('./auth');

/**
 * Extends requireAuth — only allows through if the authenticated user is an Admin.
 */
function requireAdmin(req, res, next) {
    requireAuth(req, res, (err) => {
        if (err) return next(err);
        if (req.user?.role !== 'Admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    });
}

module.exports = requireAdmin;
