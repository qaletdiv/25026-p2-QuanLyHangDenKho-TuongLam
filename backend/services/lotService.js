const driveStorage = require('../driveStorage');

/**
 * Calculates the lot number for a new booking against a given PO.
 *
 * Business rules:
 *   - If this booking covers the full PO quantity AND no prior shipments exist → no lot (return null)
 *   - First partial shipment → lot 1
 *   - Each subsequent shipment → max existing lot + 1
 *
 * RACE CONDITION CAVEAT:
 *   Lot numbers are determined by reading shipments.json at call time.  If two
 *   bookings are created concurrently for the same PO (e.g. two simultaneous API
 *   requests), both reads may see the same set of existing shipments and assign
 *   the same lot number.  This is acceptable for the current JSON-file storage
 *   phase.  When migrating to PostgreSQL, replace this logic with a SELECT FOR
 *   UPDATE or a sequence/counter column to guarantee uniqueness.
 *
 * @param {string} poNumber   — PO number to assign a lot against
 * @param {number|string} bookingQty — quantity being booked in this new booking
 * @returns {Promise<number|null>}   — lot number, or null if no lot needed
 */
async function calculateLotNumber(poNumber, bookingQty) {
    const pos      = await driveStorage.readData('purchase-orders.json').catch(() => []);
    const shipments = await driveStorage.readData('shipments.json').catch(() => []);
    const history  = await driveStorage.readData('history.json').catch(() => []);
    const allShipments = [...shipments, ...history];

    const po = pos.find(p => p.po_number === poNumber);
    if (!po) return null;

    // Coerce to integers — bookingQty may arrive as a string from JSON body parsing
    const expectedQty = parseInt(po.expected_qty) || 0;
    const bQty        = parseInt(bookingQty)       || 0;

    // Filter shipments that belong to this PO
    const existingShipments = allShipments.filter(s => s.po_number === poNumber);

    // Total already shipped/booked for this PO (excluding the booking being created now).
    // Uses `booked_qty` with fallback to `expected_quantity` for backwards compatibility
    // with older shipment records that used the legacy field name.
    const totalShipped = existingShipments.reduce((sum, s) => {
        const qty = parseInt(s.booked_qty ?? s.expected_quantity) || 0;
        return sum + qty;
    }, 0);

    // Full-PO single booking → no lot needed
    if (bQty === expectedQty && totalShipped === 0) {
        return null;
    }

    // Determine the highest existing lot number for this PO across all shipments
    const existingLots = existingShipments
        .map(s => parseInt(s.lot_number))
        .filter(n => !isNaN(n) && n > 0);

    // Retroactive lot renumbering: if a prior full-PO shipment exists with
    // lot_number === null, it must be upgraded to lot 1 now that the PO is
    // being split into multiple shipments.
    const nullLotShipments = existingShipments.filter(s => s.lot_number == null);
    if (nullLotShipments.length > 0 && existingLots.length === 0) {
        const currentShipments = await driveStorage.readData('shipments.json').catch(() => []);
        let updated = false;
        for (const nls of nullLotShipments) {
            const idx = currentShipments.findIndex(s => s.id === nls.id);
            if (idx !== -1) {
                currentShipments[idx].lot_number = 1;
                updated = true;
            }
        }
        if (updated) {
            await driveStorage.writeData('shipments.json', currentShipments);
        }
        // Also update in history.json if the shipment was already archived
        const currentHistory = await driveStorage.readData('history.json').catch(() => []);
        let histUpdated = false;
        for (const nls of nullLotShipments) {
            const idx = currentHistory.findIndex(s => s.id === nls.id);
            if (idx !== -1) {
                currentHistory[idx].lot_number = 1;
                histUpdated = true;
            }
        }
        if (histUpdated) {
            await driveStorage.writeData('history.json', currentHistory);
        }
        return 2;
    }

    if (existingLots.length === 0) {
        // First partial shipment
        return 1;
    }

    // Subsequent shipment — increment from the current maximum
    const maxLot = Math.max(...existingLots);
    return maxLot + 1;
}

module.exports = { calculateLotNumber };
