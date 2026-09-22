const cron = require('node-cron');
const { atomically } = require('../db/tx');

// The legacy history sweep (archiving delivered legacy shipments into
// history.json) was removed with the legacy stack at the SMS cutover (2026-07-03).
//
// Each job runs inside ONE transaction (db/tx.js — a no-op on DATA_BACKEND=json).
// These are the same multi-table writes the sync ROUTES perform, and those get a
// transaction for free from db/txContext.js because they are HTTP requests; a
// cron tick is not a request, so it has to ask. Without it, a sync interrupted
// between writing po_orders and writing its receipts leaves a half-applied pull
// that nothing will notice until a number looks wrong.
const initCronJobs = () => {
    // SMS courier tracking poll — every 4 hours. Appends new FedEx scan events;
    // shipment status stays derived at read time. Skips silently when FedEx
    // credentials are absent (fedexService.configured).
    cron.schedule('0 */4 * * *', async () => {
        console.log('[Cron] SMS tracking poll starting...');
        try {
            const r = await atomically(() => require('../modules/sms/smsTrackingService').poll());
            console.log(`[Cron] SMS tracking poll: ${r.polled ?? 0} polled, ${r.events_added ?? 0} new events${r.fetch_error ? ' — ' + r.fetch_error : ''}`);
        } catch (e) {
            console.error('[Cron] SMS tracking poll failed:', e.message);
        }
    });

    // SMS NetSuite sync — every 4 hours (staggered +30m). Pulls SMS POs + their
    // Item Receipts so received qty and the landed-cost IR matches stay current
    // without a manual "Sync NetSuite". Degrades on a bad token / network error
    // (returns fetch_error, mutates nothing); never throws.
    cron.schedule('30 */4 * * *', async () => {
        console.log('[Cron] SMS NetSuite sync starting...');
        try {
            const r = await atomically(() => require('../modules/sms/smsNetsuiteSyncService').sync());
            console.log(`[Cron] SMS NetSuite sync: ${r.pos_upserted ?? 0} POs, ${r.receipts_upserted ?? 0} receipts${r.fetch_error ? ' — ' + r.fetch_error : ''}`);
        } catch (e) {
            console.error('[Cron] SMS NetSuite sync failed:', e.message);
        }
    });

    // Mainline PO + Item Receipt sync — every 4 hours (staggered +45m). Keeps
    // mainline received qty current. Honors R1 (protect-if-booked); degrades on
    // error; never throws.
    cron.schedule('45 */4 * * *', async () => {
        console.log('[Cron] Mainline PO sync starting...');
        try {
            const r = await atomically(() => require('../modules/po/netsuiteSyncService').sync());
            console.log(`[Cron] Mainline PO sync: ${r.orders_upserted ?? 0} orders, ${r.receipts_upserted ?? 0} receipts${r.fetch_error ? ' — ' + r.fetch_error : ''}`);
        } catch (e) {
            console.error('[Cron] Mainline PO sync failed:', e.message);
        }
    });

    console.log('[Cron] Scheduled: SMS tracking poll (4h), SMS NetSuite sync (4h @ :30), Mainline PO sync (4h @ :45).');
};

module.exports = { initCronJobs };
