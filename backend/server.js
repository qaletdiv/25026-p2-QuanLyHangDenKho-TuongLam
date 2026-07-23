require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const driveStorage = require('./driveStorage');
const { errorHandler } = require('./middleware/errorHandler');
const { initCronJobs } = require('./services/cronJobs');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));
app.use('/templates', express.static(path.join(__dirname, 'data', 'templates')));

// Health check
app.get('/health', (req, res) => res.status(200).json({ message: 'initial running' }));

// Mount routes
// Legacy transactional stack (/shipments, /bookings, /purchase-orders, /history,
// /history-bookings, /commercial-invoices, /documents, /integrations, /wip-import)
// was REMOVED at the SMS cutover (2026-07-03) — mainline lives under /po +
// /mainline, SMS under /sms. See backend/SMS_MODULE_PLAN.md phase 7.
app.use('/login',              require('./routes/auth'));
app.use('/po',                 require('./modules/po/poRoutes'));        // normalized PO hierarchy (mainline)
app.use('/mainline',           require('./modules/mainline/mainlineRoutes')); // mainline module
app.use('/sms',                require('./modules/sms/smsRoutes'));      // SMS module — separate dataset (sms_* tables); see SMS_MODULE_PLAN.md
app.use('/landed-costs',       require('./modules/landedcosts/landedCostRoutes')); // freight & duty (Phase 1: SMS estimates) — additive, own tables
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
