const cron = require('node-cron');

// The legacy history sweep (archiving delivered legacy shipments into
// history.json) was removed with the legacy stack at the SMS cutover (2026-07-03).
const initCronJobs = () => {
    // SMS courier tracking poll — every 4 hours. Appends new FedEx scan events;
    // shipment status stays derived at read time. Skips silently when FedEx
    // credentials are absent (fedexService.configured).
    cron.schedule('0 */4 * * *', async () => {
        console.log('[Cron] SMS tracking poll starting...');
        try {
            const r = await require('../modules/sms/smsTrackingService').poll();
            console.log(`[Cron] SMS tracking poll: ${r.polled ?? 0} polled, ${r.events_added ?? 0} new events${r.fetch_error ? ' — ' + r.fetch_error : ''}`);
        } catch (e) {
            console.error('[Cron] SMS tracking poll failed:', e.message);
        }
    });

    console.log('[Cron] SMS tracking poll scheduled (every 4h).');
};

module.exports = { initCronJobs };
