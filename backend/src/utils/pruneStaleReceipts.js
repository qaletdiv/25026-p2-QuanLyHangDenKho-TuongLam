'use strict';

/**
 * Item Receipts the portal holds that NetSuite no longer has.
 *
 * THE BUG (PO04801, 2026-09-10): both receipt folds are upsert-only — they key on
 * `netsuiteIrId`, refresh what NetSuite returns and add what is new, but never
 * remove. Delete an IR in NetSuite and post a replacement, re-sync, and the portal
 * keeps BOTH: PO04801 held IR65999 (315) + IR66000 (14) + IR66023 (329) = 658
 * received against the 329 NetSuite actually has. Received quantity feeds the
 * three-way match, the "Received" status, the SMS report's received floor and the
 * landed-cost push target, so a phantom receipt is not cosmetic.
 *
 * WHY A PURE HELPER SHARED BY BOTH MODULES: this is not module logic, it is one
 * sentence about NetSuite ownership — "within the scope we just asked about, the
 * fetched set is the whole truth". SMS and mainline keep their own tables, folds
 * and stats (they must); only this predicate is common, which is exactly the
 * "pure helpers may be shared" line the landed-cost split already draws.
 *
 * THREE THINGS IT REFUSES TO TOUCH, each learned from the data:
 *  1. POs OUTSIDE the queried scope. Both syncs scope the receipt query to a set
 *     of PO internal ids (SMS: the POs this pull returned; mainline: every held
 *     PO with an id). A receipt for a PO nobody asked about is absent from the
 *     answer because it was never in the question — deleting it would wipe the
 *     receipt history of every PO outside the 18-month SMS window.
 *  2. `source: 'manual'` rows. A human typed that IR number to override a wrong
 *     auto-match (smsReceiptController.manualMatch), and it may deliberately point
 *     at an IR raised against a different PO — which is precisely why the
 *     PO-scoped query will not return it.
 *  3. Rows with no `netsuiteIrId`. Nothing links them to NetSuite, so NetSuite
 *     cannot be the authority on whether they should exist.
 *
 * A stale row that carried a CONFIRMED match still goes — a confirmation pointing
 * at a deleted IR asserts a receipt that does not exist, which would keep a
 * consignment "Received" and postable. It is reported so the removal is visible
 * rather than silent.
 */

/**
 * @param {object}   args
 * @param {object[]} args.nsReceipts        what NetSuite just returned ([{ ir_id, ... }])
 * @param {Iterable} args.queriedPoNumbers  the PO numbers the receipt query covered
 * @param {object[]} args.receipts          stored receipt rows
 * @param {object[]} args.receiptLines      stored receipt line rows
 * @returns {{receipts: object[], receiptLines: object[], removed: object[]}}
 */
function pruneStaleReceipts({ nsReceipts = [], queriedPoNumbers = [], receipts = [], receiptLines = [] }) {
    const live = new Set(nsReceipts.map((ir) => String(ir.ir_id)).filter(Boolean));
    const scope = queriedPoNumbers instanceof Set ? queriedPoNumbers : new Set(queriedPoNumbers);

    const stale = receipts.filter((r) => (
        r.netsuiteIrId                        // linked to NetSuite at all
        && r.source !== 'manual'                // not a human's override
        && scope.has(r.poNumber)               // its PO was actually in the question
        && !live.has(String(r.netsuiteIrId))  // and NetSuite did not return it
    ));
    const staleIds = new Set(stale.map((r) => r.id));

    return {
        receipts: receipts.filter((r) => !staleIds.has(r.id)),
        receiptLines: receiptLines.filter((l) => !staleIds.has(l.receiptId)),
        removed: stale.map((r) => ({
            id: r.id,
            poNumber: r.poNumber,
            ir: r.netsuiteIrTranid || `#${r.netsuiteIrId}`,
            // surfaced because deleting it also withdraws a human's assertion
            was_confirmed: Boolean(r.confirmedBy || r.matchedShipmentId),
        })),
    };
}

module.exports = { pruneStaleReceipts };
