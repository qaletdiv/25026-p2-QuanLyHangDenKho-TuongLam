const driveStorage = require('../driveStorage');

/**
 * Calculates the Lot number for a PO booking based on business rules.
 * @param {string} poNumber 
 * @param {number} bookingQty 
 * @returns {Promise<number|null>}
 */
async function calculateLotNumber(poNumber, bookingQty) {
    const pos = await driveStorage.readData('purchase-orders.json').catch(() => []);
    const shipments = await driveStorage.readData('shipments.json').catch(() => []);
    const history = await driveStorage.readData('history.json').catch(() => []);
    const allShipments = [...shipments, ...history];

    const po = pos.find(p => p.po_number === poNumber);
    if (!po) return null;

    const expectedQty = parseInt(po.expected_qty) || 0;
    
    const existingShipments = allShipments.filter(s => s.po_number === poNumber);

    // Total already shipped/booked in shipments (excluding what's being booked now)
    const totalShipped = existingShipments.reduce((sum, s) => sum + (parseInt(s.expected_quantity) || 0), 0);

    // Rule: If quantity = expected PO quantity and it's the first booking, no lot.
    if (bookingQty === expectedQty && totalShipped === 0) {
        return null;
    }

    // Determine the highest existing lot number for this PO
    const existingLots = existingShipments
        .map(s => parseInt(s.lot_number))
        .filter(n => !isNaN(n) && n > 0);
        
    if (existingLots.length === 0) {
        // First partial shipment
        return 1;
    } else {
        // Subsequent shipments just increment the lot number
        const maxLot = Math.max(...existingLots);
        return maxLot + 1;
    }
}

module.exports = {
    calculateLotNumber
};
