const cron = require('node-cron');
const driveStorage = require('../driveStorage');
const integrationService = require('./integrationService');

const runHistorySweep = async () => {
    console.log("[Sweep] Running manual/daily job: moving delivered shipments and bookings to history...");
    try {
        const shipments = await driveStorage.readData('shipments.json');
        const bookings = await driveStorage.readData('bookings.json');
        
        let history = [];
        let historyBookings = [];
        try { history = await driveStorage.readData('history.json'); } catch(e) {}
        try { historyBookings = await driveStorage.readData('history-bookings.json'); } catch(e) {}
        
        const deliveredShipments = shipments.filter(s => s.status === 'Delivered');
        const activeShipments = shipments.filter(s => s.status !== 'Delivered');
        
        const deliveredBookings = bookings.filter(b => b.booking_status === 'Delivered');
        const activeBookings = bookings.filter(b => b.booking_status !== 'Delivered');
        
        let reportMsg = "";
        
        if (deliveredShipments.length > 0) {
            await driveStorage.writeData('history.json', [...history, ...deliveredShipments]);
            await driveStorage.writeData('shipments.json', activeShipments);
            console.log(`[Sweep] Moved ${deliveredShipments.length} shipments to history.`);
            reportMsg += `${deliveredShipments.length} shipments were delivered. `;
        }
        
        if (deliveredBookings.length > 0) {
            await driveStorage.writeData('history-bookings.json', [...historyBookings, ...deliveredBookings]);
            await driveStorage.writeData('bookings.json', activeBookings);
            console.log(`[Sweep] Moved ${deliveredBookings.length} bookings to history.`);
            reportMsg += `${deliveredBookings.length} bookings were delivered. `;
        }
        
        if (reportMsg) {
            // Email report
            await integrationService.sendToEmail('admin@tentree.com', 'Daily Sweep Report', reportMsg + "They have been moved to history.");
        }
        return { success: true, count: deliveredShipments.length, bookingCount: deliveredBookings.length };
    } catch(e) {
        console.error("[Sweep] Error executing history sweep:", e.message);
        throw e;
    }
};

const initCronJobs = () => {
    // Run every 15 minutes during business hours (9 AM - 6 PM)
    cron.schedule('*/15 9-18 * * *', async () => {
        console.log("[Cron] Starting scheduled business hours sweep...");
        await runHistorySweep().catch(console.error);
    });

    // Run every day at midnight for a full cleanup
    cron.schedule('0 0 * * *', async () => {
        console.log("[Cron] Starting scheduled midnight sweep...");
        await runHistorySweep().catch(console.error);
    });
    
    console.log("[Cron] History sweep automation initialized.");
};

module.exports = { initCronJobs, runHistorySweep };
