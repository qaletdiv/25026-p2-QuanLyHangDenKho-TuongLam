const cron = require('node-cron');
const driveStorage = require('../driveStorage');
const integrationService = require('./integrationService');

/**
 * Recalculate and persist booking statuses based on the current state of their
 * associated shipments.  Called before the history sweep so that bookings whose
 * shipments have all been delivered get promoted to "Delivered" and are then
 * eligible for archiving in the same sweep run.
 *
 * Status derivation rules (in priority order):
 *   - Any shipment "In Transit"  → booking is "In Transit"
 *   - All shipments "Delivered"  → booking is "Delivered"
 *   - Any shipment "Confirmed"   → booking is "Confirmed"
 *   - Otherwise keep existing status (covers bookings with no shipments yet)
 *
 * @param {object[]} bookings   — current active bookings array
 * @param {object[]} shipments  — current active shipments array
 * @returns {object[]}          — updated bookings array (same references, mutated statuses)
 */
function recalcBookingStatuses(bookings, shipments) {
    return bookings.map(booking => {
        const relatedShipments = shipments.filter(s => s.booking_id === booking.id);

        if (relatedShipments.length === 0) {
            // No shipments linked yet — leave status unchanged
            return booking;
        }

        const statuses = relatedShipments.map(s => (s.status || '').trim());
        const allDelivered  = statuses.every(s => s === 'Delivered');
        const anyInTransit  = statuses.some(s => s === 'In Transit');
        const anyConfirmed  = statuses.some(s => s === 'Confirmed');

        let newStatus = booking.booking_status;
        if (allDelivered)   newStatus = 'Delivered';
        else if (anyInTransit) newStatus = 'In Transit';
        else if (anyConfirmed) newStatus = 'Confirmed';

        if (newStatus !== booking.booking_status) {
            console.log(
                `[Sweep] Booking ${booking.id}: status updated ` +
                `"${booking.booking_status}" → "${newStatus}"`
            );
            return { ...booking, booking_status: newStatus };
        }
        return booking;
    });
}

const runHistorySweep = async () => {
    console.log('[Sweep] Running manual/daily job: moving delivered shipments and bookings to history...');
    try {
        let shipments      = await driveStorage.readData('shipments.json').catch(() => []);
        let bookings       = await driveStorage.readData('bookings.json').catch(() => []);
        let history        = await driveStorage.readData('history.json').catch(() => []);
        let historyBookings = await driveStorage.readData('history-bookings.json').catch(() => []);

        // ── Step 1: promote shipments to history first ────────────────────────
        const deliveredShipments = shipments.filter(s => s.status === 'Delivered');
        const activeShipments    = shipments.filter(s => s.status !== 'Delivered');

        if (deliveredShipments.length > 0) {
            await driveStorage.writeData('history.json', [...history, ...deliveredShipments]);
            await driveStorage.writeData('shipments.json', activeShipments);
            console.log(`[Sweep] Moved ${deliveredShipments.length} shipments to history.`);
        }

        // ── Step 2: recalculate booking statuses now that shipments have moved ─
        // Use the updated active shipments list so bookings whose last in-transit
        // shipment just moved to history are correctly marked Delivered.
        bookings = recalcBookingStatuses(bookings, activeShipments);

        // Persist updated booking statuses (even if nothing moves to history)
        await driveStorage.writeData('bookings.json', bookings);

        // ── Step 3: move fully-delivered bookings to history-bookings ─────────
        const deliveredBookings = bookings.filter(b => b.booking_status === 'Delivered');
        const activeBookings    = bookings.filter(b => b.booking_status !== 'Delivered');

        if (deliveredBookings.length > 0) {
            await driveStorage.writeData('history-bookings.json', [...historyBookings, ...deliveredBookings]);
            await driveStorage.writeData('bookings.json', activeBookings);
            console.log(`[Sweep] Moved ${deliveredBookings.length} bookings to history.`);
        }

        // ── Step 4: email report ──────────────────────────────────────────────
        const parts = [];
        if (deliveredShipments.length > 0)
            parts.push(`${deliveredShipments.length} shipment(s) moved to history`);
        if (deliveredBookings.length > 0)
            parts.push(`${deliveredBookings.length} booking(s) moved to history`);

        if (parts.length > 0) {
            const reportMsg = parts.join('; ') + '.';
            await integrationService.sendToEmail(
                'admin@tentree.com',
                'Daily Sweep Report',
                reportMsg
            );
        }

        return {
            success:      true,
            count:        deliveredShipments.length,
            bookingCount: deliveredBookings.length,
        };
    } catch (e) {
        console.error('[Sweep] Error executing history sweep:', e.message);
        throw e;
    }
};

const initCronJobs = () => {
    // Run every 15 minutes during business hours (9 AM – 6 PM)
    cron.schedule('*/15 9-18 * * *', async () => {
        console.log('[Cron] Starting scheduled business-hours sweep...');
        await runHistorySweep().catch(console.error);
    });

    // Run every day at midnight for a full cleanup
    cron.schedule('0 0 * * *', async () => {
        console.log('[Cron] Starting scheduled midnight sweep...');
        await runHistorySweep().catch(console.error);
    });

    console.log('[Cron] History sweep automation initialized.');
};

module.exports = { initCronJobs, runHistorySweep };
