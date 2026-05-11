const BookingModel       = require('../models/BookingModel');
const ShipmentModel      = require('../models/ShipmentModel');
const PurchaseOrderModel = require('../models/PurchaseOrderModel');
const { statuses: StatusModel } = require('../models/MasterDataModel');

/**
 * Synchronizes the booking_status in purchase-orders.json for all POs
 * associated with a specific booking number.
 */
async function syncPoStatus(bookingNumber, status, trnNumber) {
    if (!bookingNumber) return;
    try {
        const pos      = await PurchaseOrderModel.read().catch(() => []);
        const shipments = await ShipmentModel.read();

        // Find all PO numbers in this booking via shipment rows
        let poNumbers = shipments
            .filter(s => s.booking_number === bookingNumber)
            .map(s => s.po_number);

        // Fix #7 — For mainline bookings before approval, there are no shipment rows yet.
        // Fall back to scanning the bookings table for this booking_number.
        if (poNumbers.length === 0) {
            const bookings = await BookingModel.read().catch(() => []);
            const booking  = bookings.find(b => b.booking_number === bookingNumber);
            if (booking && Array.isArray(booking.po_details)) {
                poNumbers = booking.po_details.map(pd => pd.po_number).filter(Boolean);
            }
        }

        if (poNumbers.length === 0) return;

        let changed = false;
        const updatedPos = pos.map(p => {
            if (poNumbers.includes(p.po_number)) {
                let pChanged = false;
                const newP = { ...p };
                if (newP.booking_status !== status) {
                    newP.booking_status = status;
                    pChanged = true;
                }
                if (trnNumber && newP.trn_number !== trnNumber) {
                    newP.trn_number = trnNumber;
                    pChanged = true;
                }
                if (pChanged) {
                    changed = true;
                    return newP;
                }
            }
            return p;
        });

        if (changed) {
            await PurchaseOrderModel.write(updatedPos);
        }
    } catch (e) {
        console.error('[syncPoStatus] error:', e);
    }
}

/**
 * When a confirmed CI is attached to a booking, write per-PO received_quantity
 * back onto the linked shipment rows so that GET /purchase-orders can sum them.
 *
 * CI line items carry a `matched_po` field from the parse step — we group by
 * that and sum `qty` to get the received units per PO.
 */
async function syncCiToShipments(bookingNumber, ciLineItems) {
    if (!bookingNumber || !Array.isArray(ciLineItems)) return;
    try {
        const shipments = await ShipmentModel.read();

        // Build { po_number → received qty } from matched CI line items
        const poQtyMap = {};
        // Build { po_number → { sku_code → shipped_qty } } for SKU-level sync
        const poSkuQtyMap = {};
        for (const item of ciLineItems) {
            const poNum = item.matched_po;
            if (!poNum) continue;
            poQtyMap[poNum] = (poQtyMap[poNum] || 0) + (parseInt(item.qty) || 0);
            if (!poSkuQtyMap[poNum]) poSkuQtyMap[poNum] = {};
            const sku = item.sku_code;
            if (sku) {
                poSkuQtyMap[poNum][sku] = (poSkuQtyMap[poNum][sku] || 0) + (parseInt(item.qty) || 0);
            }
        }

        let changed = false;
        const updated = shipments.map(s => {
            if (s.booking_number !== bookingNumber) return s;
            const ciQty  = poQtyMap[s.po_number];
            const skuMap = poSkuQtyMap[s.po_number];
            let sChanged = false;
            const newS = { ...s };

            // Update aggregate received_quantity
            if (ciQty != null && newS.received_quantity !== ciQty) {
                newS.received_quantity = ciQty;
                sChanged = true;
            }

            // Update per-SKU shipped_qty on shipment line_items
            if (skuMap && Array.isArray(newS.line_items)) {
                newS.line_items = newS.line_items.map(li => {
                    const shippedQty = skuMap[li.sku_code] || 0;
                    if (li.shipped_qty !== shippedQty) {
                        sChanged = true;
                        return { ...li, shipped_qty: shippedQty };
                    }
                    return li;
                });
            }

            // Set ci_status on shipment
            if (newS.ci_status !== 'confirmed') {
                newS.ci_status = 'confirmed';
                sChanged = true;
            }

            if (sChanged) {
                changed = true;
                return newS;
            }
            return s;
        });

        if (changed) await ShipmentModel.write(updated);
    } catch (e) {
        console.error('[syncCiToShipments] error:', e);
    }
}

/**
 * Recalculates and writes back the aggregate booking_status for a booking
 * based on the current status of all its linked PO rows in shipments.
 * Rule: the booking status = the lowest (bottleneck) status among all PO rows.
 */
async function recalcBookingStatus(bookingNumber) {
    if (!bookingNumber) return;
    try {
        const shipments      = await ShipmentModel.read();
        const bookings       = await BookingModel.read();
        const masterStatuses = await StatusModel.read().catch(() => []);

        const linkedRows = shipments.filter(s => s.booking_number === bookingNumber);
        if (linkedRows.length === 0) return;

        const rowStatuses = linkedRows.map(s => s.status || 'No Booking');

        // Dynamic order from statuses.json
        const statusOrder = masterStatuses.map(s => s.name);
        // Identify exception statuses dynamically (those with red coloring)
        const exceptionStatuses = masterStatuses
            .filter(s => s.color.includes('red') || s.name === 'EXCEPTION')
            .map(s => s.name);

        const exception = rowStatuses.find(s => exceptionStatuses.includes(s));
        const aggregate = exception || rowStatuses.reduce((lowest, current) => {
            const lowestIdx  = statusOrder.indexOf(lowest);
            const currentIdx = statusOrder.indexOf(current);
            if (currentIdx === -1) return lowest;
            if (lowestIdx === -1) return current;
            return currentIdx < lowestIdx ? current : lowest;
        });

        const bIdx = bookings.findIndex(b => b.booking_number === bookingNumber);
        if (bIdx > -1 && bookings[bIdx].booking_status !== aggregate) {
            bookings[bIdx] = { ...bookings[bIdx], booking_status: aggregate };
            await BookingModel.write(bookings);

            // Sync status back to PO master list
            await syncPoStatus(bookingNumber, aggregate);
        }
    } catch (e) {
        console.error('[recalcBookingStatus] error:', e);
    }
}

/**
 * Enriches a list of bookings with metadata from purchase-orders.json
 * if the booking itself is missing those fields (legacy data support).
 */
async function enrichBookings(bookings) {
    const pos = await PurchaseOrderModel.read().catch(() => []);

    return bookings.map(b => {
        // Find first PO in details to get general info if missing
        const firstPoNum = (b.po_details?.[0]?.po_number || '').trim();
        const mainPo     = pos.find(p => (p.po_number || '').trim() === firstPoNum);

        return {
            ...b,
            receiving_warehouse: b.receiving_warehouse || mainPo?.receiving_warehouse || '',
            season:              b.season              || mainPo?.season              || '',
            trn_number:          b.trn_number          || mainPo?.trn_number          || '',
            type:                b.type                || mainPo?.type                || '',
            mode:                b.mode                || mainPo?.mode                || '',
            incoterm:            b.incoterm            || mainPo?.incoterm            || '',
            po_details: b.po_details?.map(pDetail => {
                const po = pos.find(p => (p.po_number || '').trim() === (pDetail.po_number || '').trim());
                return {
                    ...pDetail,
                    units: pDetail.units || po?.expected_qty || ''
                };
            }) || []
        };
    });
}

module.exports = { syncPoStatus, syncCiToShipments, recalcBookingStatus, enrichBookings };
