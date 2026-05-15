const PurchaseOrderModel = require('../models/PurchaseOrderModel');
const ShipmentModel      = require('../models/ShipmentModel');
const BookingModel       = require('../models/BookingModel');
const { history: HistoryModel, historyBookings: HistoryBookingsModel } = require('../models/HistoryModel');

async function getAll(req, res) {
    // Fix #16 — Remove silent catch-all; individual data files use .catch(()=>[]) for graceful fallback.
    // purchase-orders.json itself is required — let it throw if missing (asyncWrap handles it).
    {
        const shipments = await ShipmentModel.read().catch(() => []);
        const history   = await HistoryModel.read().catch(() => []);
        const allShipments = [...shipments, ...history];

        const bookings        = await BookingModel.read().catch(() => []);
        const historyBookings = await HistoryBookingsModel.read().catch(() => []);
        const allBookings     = [...bookings, ...historyBookings];

        const pos = await PurchaseOrderModel.read();

        const enriched = pos.map(p => {
            const poNum = (p.po_number || '').trim();
            const relatedShipments = allShipments.filter(s => (s.po_number || '').trim() === poNum);

            // Sum received_quantity
            const totalReceived = relatedShipments.reduce((sum, s) => sum + (parseInt(s.received_quantity) || 0), 0);

            // Sum booked units
            // Bookings store po_details[] which contains units (Mainline)
            // G4 — exclude Cancelled/Rejected bookings from booked_qty
            const activeBookings = allBookings.filter(b =>
                !['Cancelled', 'Rejected'].includes(b.booking_status)
            );
            let totalBooked = 0;
            activeBookings.forEach(b => {
                if (b.po_details && Array.isArray(b.po_details)) {
                    b.po_details.forEach((pod) => {
                        if ((pod.po_number || '').trim() === poNum) {
                            totalBooked += (parseInt(pod.units) || 0);
                        }
                    });
                }
            });

            // SMS bookings bypass the bookings table, so we must sum them from shipments
            relatedShipments.forEach(s => {
                const sType = (s.type || '').toLowerCase();
                if (sType === 'sms') {
                    totalBooked += (parseInt(s.expected_quantity) || 0);
                }
            });

            const receiveDates = relatedShipments
                .map(s => s.actual_receive_date)
                .filter(Boolean)
                .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

            const latestDate = receiveDates.length > 0 ? receiveDates[0] : (p.actual_receive_date || '');

            return {
                ...p,
                line_items: Array.isArray(p.line_items) ? p.line_items : [],
                received_qty: totalReceived,
                booked_qty: totalBooked,
                actual_receive_date: latestDate
            };
        });

        res.json(enriched);
    }
}

async function create(req, res) {
    const data = await PurchaseOrderModel.read().catch(() => []);
    const newPO = { id: Date.now().toString(), booking_status: 'No Booking', booking_number: null, ...req.body };
    data.push(newPO);
    await PurchaseOrderModel.write(data);
    res.status(201).json(newPO);
}

async function bulkCreate(req, res) {
    const existing = await PurchaseOrderModel.read().catch(() => []);
    const incoming = Array.isArray(req.body) ? req.body : [];

    let updatedCount = 0;
    let addedCount = 0;

    const combined = [...existing];

    incoming.forEach(newPO => {
        const idx = combined.findIndex(p => p.po_number === newPO.po_number);
        if (idx > -1) {
            // Update existing (don't overwrite status or booking_number if they exist)
            combined[idx] = {
                ...combined[idx],
                ...newPO,
                booking_status: combined[idx].booking_status || 'No Booking',
                booking_number: combined[idx].booking_number || null
            };
            updatedCount++;
        } else {
            // Add new
            combined.push({
                id: Date.now().toString() + Math.random(),
                booking_status: 'No Booking',
                booking_number: null,
                ...newPO
            });
            addedCount++;
        }
    });

    await PurchaseOrderModel.write(combined);
    res.status(201).json({ updated: updatedCount, added: addedCount });
}

async function getOne(req, res) {
    const pos = await PurchaseOrderModel.read().catch(() => []);
    const po = pos.find(p => p.id === req.params.id);
    if (!po) {
        const err = new Error('Not found'); err.statusCode = 404; throw err;
    }
    res.json({ ...po, line_items: Array.isArray(po.line_items) ? po.line_items : [] });
}

async function update(req, res) {
    const data = await PurchaseOrderModel.read().catch(() => []);
    const idx = data.findIndex(p => p.id === req.params.id);
    if (idx > -1) {
        const updated = { ...data[idx], ...req.body };
        // Auto-compute expected_qty from line_items if present
        if (Array.isArray(updated.line_items) && updated.line_items.length > 0) {
            const sum = updated.line_items.reduce((s, item) => s + (parseInt(item.expected_qty) || 0), 0);
            if (sum > 0) updated.expected_qty = sum;
        }
        data[idx] = updated;
        await PurchaseOrderModel.write(data);
        res.json(data[idx]);
    } else {
        const err = new Error('Not found'); err.statusCode = 404; throw err;
    }
}

async function remove(req, res) {
    let data = await PurchaseOrderModel.read().catch(() => []);
    data = data.filter(p => p.id !== req.params.id);
    await PurchaseOrderModel.write(data);
    res.status(204).send();
}

// PO SHIPMENT LOTS — all shipments for a PO with lot info and remaining qty
async function getShipmentLots(req, res) {
    const pos = await PurchaseOrderModel.read().catch(() => []);
    const po = pos.find(p => p.id === req.params.id);
    if (!po) {
        const err = new Error('Not found'); err.statusCode = 404; throw err;
    }

    const shipments = await ShipmentModel.read().catch(() => []);
    const history   = await HistoryModel.read().catch(() => []);
    const allShipments = [...shipments, ...history];

    const bookings        = await BookingModel.read().catch(() => []);
    const historyBookings = await HistoryBookingsModel.read().catch(() => []);
    const allBookings     = [...bookings, ...historyBookings];

    const poShipments = allShipments.filter(s => s.po_number === po.po_number);

    // Sum booked qty from non-Cancelled shipments
    const totalBooked = poShipments
        .filter(s => s.status !== 'Cancelled')
        .reduce((sum, s) => sum + (parseInt(s.expected_quantity) || 0), 0);

    const remaining_qty = (parseInt(po.expected_qty) || 0) - totalBooked;

    const lots = poShipments.map(s => {
        const booking = s.booking_number
            ? allBookings.find(b => b.booking_number === s.booking_number)
            : null;
        const ci = booking?.commercial_invoice;

        // Derive per-SKU shipped quantities from CI line_items (matched only)
        const line_items = (ci?.status === 'confirmed' && Array.isArray(ci.line_items))
            ? ci.line_items
                .filter(li => li.match_status === 'matched' && li.matched_po === po.po_number)
                .map(li => ({ sku_code: li.sku_code, description: li.description || '', shipped_qty: li.qty || 0 }))
            : [];

        return {
            shipment_id: s.id,
            booking_number: s.booking_number || null,
            lot_number: s.lot_number ?? null,
            booked_qty: parseInt(s.expected_quantity) || 0,
            status: s.status || 'Unknown',
            ci_status: ci?.status || null,
            line_items
        };
    });

    res.json({ po_number: po.po_number, expected_qty: po.expected_qty, remaining_qty, lots });
}

// PO LINE ITEMS
async function replaceLineItems(req, res) {
    const data = await PurchaseOrderModel.read().catch(() => []);
    const idx = data.findIndex(p => p.id === req.params.id);
    if (idx === -1) {
        const err = new Error('Not found'); err.statusCode = 404; throw err;
    }
    const { line_items } = req.body;
    data[idx].line_items = line_items;
    // Auto-compute expected_qty from line_items
    const sum = line_items.reduce((s, item) => s + (parseInt(item.expected_qty) || 0), 0);
    if (sum > 0) data[idx].expected_qty = sum;
    await PurchaseOrderModel.write(data);
    res.json(data[idx]);
}

async function updateLineItem(req, res) {
    const data = await PurchaseOrderModel.read().catch(() => []);
    const poIdx = data.findIndex(p => p.id === req.params.id);
    if (poIdx === -1) {
        const err = new Error('PO not found'); err.statusCode = 404; throw err;
    }
    const po = data[poIdx];
    if (!Array.isArray(po.line_items)) {
        const err = new Error('SKU not found'); err.statusCode = 404; throw err;
    }
    const skuIdx = po.line_items.findIndex(li => li.sku_code === req.params.sku);
    if (skuIdx === -1) {
        const err = new Error('SKU not found'); err.statusCode = 404; throw err;
    }
    po.line_items[skuIdx] = { ...po.line_items[skuIdx], ...req.body };
    // Recompute expected_qty from line_items
    const sum = po.line_items.reduce((s, item) => s + (parseInt(item.expected_qty) || 0), 0);
    if (sum > 0) po.expected_qty = sum;
    data[poIdx] = po;
    await PurchaseOrderModel.write(data);
    res.json(po);
}

// PO FULFILLMENT (computed: expected vs shipped per SKU)
// Supports lookup by PO id or po_number (e.g. "PO-FW26-003")
async function getFulfillment(req, res) {
    const pos = await PurchaseOrderModel.read().catch(() => []);
    const param = req.params.id;
    const po = pos.find(p => p.id === param || p.po_number === param);
    if (!po) {
        const err = new Error('Not found'); err.statusCode = 404; throw err;
    }
    if (!Array.isArray(po.line_items) || po.line_items.length === 0) {
        return res.json({ line_items: [], message: 'No SKU line items on this PO' });
    }

    // Sum shipped qty from confirmed bookings (active + history) whose CI line_items match each SKU
    const bookings        = await BookingModel.read().catch(() => []);
    const historyBookings = await HistoryBookingsModel.read().catch(() => []);
    const confirmedBookings = [...bookings, ...historyBookings].filter(b =>
        b.commercial_invoice?.status === 'confirmed' &&
        Array.isArray(b.commercial_invoice?.line_items)
    );

    const fulfillment = po.line_items.map(li => {
        let shipped_qty = 0;
        for (const booking of confirmedBookings) {
            for (const ciItem of booking.commercial_invoice.line_items) {
                if (ciItem.sku_code === li.sku_code && ciItem.matched_po === po.po_number) {
                    shipped_qty += (parseInt(ciItem.qty) || 0);
                }
            }
        }
        return {
            sku_code: li.sku_code,
            description: li.description,
            expected_qty: li.expected_qty,
            shipped_qty,
            remaining_qty: (li.expected_qty || 0) - shipped_qty
        };
    });

    res.json(fulfillment);
}

module.exports = {
    getAll,
    create,
    bulkCreate,
    getOne,
    update,
    remove,
    getShipmentLots,
    replaceLineItems,
    updateLineItem,
    getFulfillment
};
