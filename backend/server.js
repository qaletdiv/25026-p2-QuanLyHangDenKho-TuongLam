require('dotenv').config();
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

// Health check
app.get('/health', (req, res) => res.status(200).json({ message: 'initial running' }));

// Mount routes
app.use('/login',              require('./routes/auth'));
app.use('/shipments',          require('./routes/shipments'));
app.use('/bookings',           require('./routes/bookings'));
app.use('/purchase-orders',    require('./routes/purchaseOrders'));
app.use('/master-data',        require('./routes/masterData'));
app.use('/contacts',           require('./routes/contacts'));
app.use('/eom-tasks',          require('./routes/eomTasks'));
app.use('/history',            require('./routes/history'));
app.use('/history-bookings',   require('./routes/historyBookings'));
app.use('/reports',            require('./routes/reports'));
app.use('/forecast',           require('./routes/forecast'));
app.use('/documents',          require('./routes/documents'));
app.use('/commercial-invoices', require('./routes/commercialInvoices'));
app.use('/integrations',       require('./routes/integrations'));

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
