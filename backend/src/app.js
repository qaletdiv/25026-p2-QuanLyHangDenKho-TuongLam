// Express application — middleware + routes + error handler.
//
// This file BUILDS the app and exports it. It never binds a port and never
// starts the cron scheduler; server.js does both. Keeping them apart is what
// lets tests/api.test.js drive the real app through supertest without
// occupying port 5000, and what makes the mount ORDER below the whole of the
// authorization story rather than a side effect of boot.
require('./config/env'); // must precede anything reading process.env at load
const express = require('express');
const cors = require('cors');
const path = require('path');
const { CORS_ORIGINS, LOGIN_RATE_LIMIT } = require('./config/env');
const { errorHandler } = require('./middlewares/errorHandler');

const app = express();

app.use(cors({
    origin(origin, cb) {
        // No Origin header = same-origin, curl, or a server-to-server call — allow.
        if (!origin) return cb(null, true);
        return cb(null, CORS_ORIGINS.includes(origin));
    },
    credentials: true,
}));
app.use(require('./middlewares/securityHeaders'));
app.use(express.json());

// ---------------------------------------------------------------------------
// ONE TRANSACTION PER WRITE REQUEST.
//
// Mounted here, above every router, because the multi-table writes it protects
// are spread across them: booking-approve writes shipments then shipment legs,
// the shipping-data upload writes five tables, an SMS shipment writes a header
// then its junction. Under the JSON stack a crash between two of those left
// partial state with no way back; now the request either lands whole or not at
// all. It is also what lets foreign keys exist at all — see database/txContext.js.
//
// GET/HEAD skip it, so read paths and streamed downloads are untouched.
// ---------------------------------------------------------------------------
app.use(require('../database/txContext').transactionMiddleware);

// Health check
app.get('/health', (req, res) => res.status(200).json({ message: 'initial running' }));

// Mount routes
// Legacy transactional stack (/shipments, /bookings, /purchase-orders, /history,
// /history-bookings, /commercial-invoices, /documents, /integrations, /wip-import)
// was REMOVED at the SMS cutover (2026-07-03) — mainline lives under /po +
// /mainline, SMS under /sms. See docs/SMS_MODULE_PLAN.md phase 7.
// Login is rate limited: it is the one unauthenticated write, so it is the only
// endpoint where an attacker can guess indefinitely. Keyed per IP.
const rateLimit = require('./middlewares/rateLimit');
app.use('/login', rateLimit({
    ...LOGIN_RATE_LIMIT,
    message: 'Too many login attempts — please wait a few minutes and try again.',
}), require('./routes/authRoutes'));

// ---------------------------------------------------------------------------
// AUTH GATE — everything mounted BELOW this line requires a valid JWT.
//
// Only /health and /login sit above it. Previously auth was applied per-route,
// which left all 50 GET endpoints (the full order book, SKU unit prices, landed
// costs, reports) readable with no token at all. Ordering enforces the allowlist
// so a new route can't be added unguarded by accident.
//
// The per-route requireAuth/requireAdmin calls in the routers below are now
// redundant but harmless; requireAdmin still carries the role check.
// ---------------------------------------------------------------------------
app.use(require('./middlewares/auth'));

// ---------------------------------------------------------------------------
// Static file downloads — BELOW the gate, so they now require a valid JWT.
//
// These were public: CI/packing/ASN documents and the freight template were
// downloadable by anyone who could reach this port, with guessable filenames
// (asn_<timestamp>_<booking>.xlsx). They sit here rather than above the gate
// because the browser no longer requests them directly — the Next.js route
// handler at /api/documents authenticates the user via the httpOnly cookie and
// proxies the file through with the caller's Bearer token. A direct hit from a
// browser tab now 401s, which is the point.
//
// /uploads is NOT static any more: routes/documentRoutes.js resolves each filename
// to its owning record (mainline_documents / mainline_asns / sms_documents) and
// applies the same vendor ownership check as the rest of the read path, so a vendor
// holding a leaked URL for another supplier's commercial invoice gets a 404.
// Unattributable files fail closed for vendors.
//
// /templates holds internal working spreadsheets (WIP reports, sample shipment data)
// that include real PO documents, and nothing in the app links to it. Left mounted
// so any manual workflow keeps working, but Vendors are refused — they have no reason
// to read internal templates, and some of those files ARE other suppliers' POs.
// ---------------------------------------------------------------------------
app.use('/uploads', require('./routes/documentRoutes'));
app.use('/templates', (req, res, next) => {
    if (req.user?.role === 'Vendor') {
        return res.status(404).json({ success: false, error: 'File not found' });
    }
    return next();
}, express.static(path.join(__dirname, '..', 'storage', 'templates')));

// Who am I, with permissions resolved NOW (not the login-time snapshot). The
// frontend page gate calls this on navigation — see controllers/meController.
app.use('/me',                 require('./routes/meRoutes'));
app.use('/po',                 require('./routes/poRoutes'));        // normalized PO hierarchy (mainline)
app.use('/mainline',           require('./routes/mainlineRoutes')); // mainline module
app.use('/sms',                require('./routes/smsRoutes'));      // SMS module — separate dataset (sms_* tables); see docs/SMS_MODULE_PLAN.md
app.use('/landed-costs',       require('./routes/landedCostRoutes')); // freight & duty (Phase 1: SMS estimates) — additive, own tables
app.use('/nri-invoices',       require('./routes/nriInvoiceRoutes')); // NRI 3PL invoice verification (invoice ↔ detail ↔ rate agreement) — additive, own tables under data/nri/
app.use('/master-data',        require('./routes/masterDataRoutes'));
app.use('/contacts',           require('./routes/contactRoutes'));
app.use('/reports',            require('./routes/reportRoutes'));
app.use('/forecast',           require('./routes/forecastRoutes'));
app.use('/users',              require('./routes/userRoutes'));
app.use('/roles',              require('./routes/roleRoutes'));
app.use('/freights',           require('./routes/freightRoutes'));
app.use('/notifications',      require('./routes/notificationRoutes')); // derived, role-scoped alerts

// Global Error Handler must be last!
app.use(errorHandler);

module.exports = app;
