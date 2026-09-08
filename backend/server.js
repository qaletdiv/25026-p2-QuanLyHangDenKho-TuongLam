require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const driveStorage = require('./driveStorage');
const { errorHandler } = require('./middleware/errorHandler');
const { initCronJobs } = require('./services/cronJobs');

const app = express();
const PORT = process.env.PORT || 5000;

// ---------------------------------------------------------------------------
// CORS — allowlist, was `origin: '*'`.
//
// Nothing in the app is a browser→backend call any more: the Next.js server does
// every API fetch server-side (lib/api.ts), and the file downloads that used to hit
// this origin directly now go through the Next route handler at /api/documents. So
// the allowlist exists only for local tooling and any future first-party browser
// client; an unlisted origin simply gets no CORS headers.
//
// Set CORS_ORIGINS in .env as a comma-separated list to override.
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({
    origin(origin, cb) {
        // No Origin header = same-origin, curl, or a server-to-server call — allow.
        if (!origin) return cb(null, true);
        return cb(null, ALLOWED_ORIGINS.includes(origin));
    },
    credentials: true,
}));
app.use(require('./middleware/securityHeaders'));
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.status(200).json({ message: 'initial running' }));

// Mount routes
// Legacy transactional stack (/shipments, /bookings, /purchase-orders, /history,
// /history-bookings, /commercial-invoices, /documents, /integrations, /wip-import)
// was REMOVED at the SMS cutover (2026-07-03) — mainline lives under /po +
// /mainline, SMS under /sms. See backend/SMS_MODULE_PLAN.md phase 7.
// Login is rate limited: it is the one unauthenticated write, so it is the only
// endpoint where an attacker can guess indefinitely. Keyed per IP.
const rateLimit = require('./middleware/rateLimit');
app.use('/login', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Too many login attempts — please wait a few minutes and try again.',
}), require('./routes/auth'));

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
app.use(require('./middleware/auth'));

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
// /uploads is NOT static any more: routes/documents.js resolves each filename to its
// owning record (mainline_documents / mainline_asns / sms_documents) and applies the
// same vendor ownership check as the rest of the read path, so a vendor holding a
// leaked URL for another supplier's commercial invoice gets a 404. Unattributable
// files fail closed for vendors.
//
// /templates holds internal working spreadsheets (WIP reports, sample shipment data)
// that include real PO documents, and nothing in the app links to it. Left mounted
// so any manual workflow keeps working, but Vendors are refused — they have no reason
// to read internal templates, and some of those files ARE other suppliers' POs.
// ---------------------------------------------------------------------------
app.use('/uploads', require('./routes/documents'));
app.use('/templates', (req, res, next) => {
    if (req.user?.role === 'Vendor') {
        return res.status(404).json({ success: false, error: 'File not found' });
    }
    return next();
}, express.static(path.join(__dirname, 'data', 'templates')));

app.use('/po',                 require('./modules/po/poRoutes'));        // normalized PO hierarchy (mainline)
app.use('/mainline',           require('./modules/mainline/mainlineRoutes')); // mainline module
app.use('/sms',                require('./modules/sms/smsRoutes'));      // SMS module — separate dataset (sms_* tables); see SMS_MODULE_PLAN.md
app.use('/landed-costs',       require('./modules/landedcosts/landedCostRoutes')); // freight & duty (Phase 1: SMS estimates) — additive, own tables
app.use('/nri-invoices',       require('./modules/nriinvoices/nriInvoiceRoutes')); // NRI 3PL invoice verification (invoice ↔ detail ↔ rate agreement) — additive, own tables under data/nri/
app.use('/master-data',        require('./routes/masterData'));
app.use('/contacts',           require('./routes/contacts'));
app.use('/eom-tasks',          require('./routes/eomTasks'));
app.use('/reports',            require('./routes/reports'));
app.use('/forecast',           require('./routes/forecast'));
app.use('/users',              require('./routes/users'));
app.use('/roles',              require('./routes/roles'));
app.use('/freights',           require('./routes/freights'));
app.use('/notifications',      require('./routes/notifications')); // derived, role-scoped alerts

// Global Error Handler must be last!
app.use(errorHandler);

if (require.main === module) {
    driveStorage.init().then(() => {
        initCronJobs();
        app.listen(PORT, () => {
            console.log(`Server is listening at http://localhost:${PORT}`);
        });
    });
}

module.exports = app;
