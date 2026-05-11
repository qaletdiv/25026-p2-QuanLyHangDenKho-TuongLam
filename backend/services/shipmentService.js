const ShipmentModel      = require('../models/ShipmentModel');
const PurchaseOrderModel = require('../models/PurchaseOrderModel');

/**
 * Enriches shipments with PO data if fields are missing.
 */
async function enrichShipments(shipments) {
    const pos = await PurchaseOrderModel.read().catch(() => []);

    return shipments.map(s => {
        const po = pos.find(p => p.po_number === s.po_number);
        if (!po) return s;
        return {
            ...s,
            expected_quantity:     s.expected_quantity     || po.expected_qty        || '',
            destination_warehouse: s.destination_warehouse || po.receiving_warehouse || '',
            season:                s.season                || po.season              || '',
            supplier:              s.supplier              || po.supplier            || '',
            courier:               s.courier               || po.courier             || ''
        };
    });
}

module.exports = { enrichShipments };
