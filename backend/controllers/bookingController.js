const BookingModel       = require('../models/BookingModel');
const ShipmentModel      = require('../models/ShipmentModel');
const PurchaseOrderModel = require('../models/PurchaseOrderModel');
const { enrichBookings, syncPoStatus, syncCiToShipments } = require('../services/bookingService');
const lotService = require('../services/lotService');

async function getAll(req, res) {
    const bookings = await BookingModel.read();
    const enriched = await enrichBookings(bookings);
    res.json(enriched);
}

async function create(req, res) {
    const { type, po_details, ...rest } = req.body;

    // Fix #3 — Input validation
    if (!rest.vendor_name && !rest.supplier) {
        const err = new Error('vendor_name is required');
        err.statusCode = 400;
        throw err;
    }
    if (!po_details || !Array.isArray(po_details) || po_details.length === 0) {
        const err = new Error('po_details must be a non-empty array');
        err.statusCode = 400;
        throw err;
    }

    // G1 — Vendor-match validation for multi-PO bookings
    if (po_details && Array.isArray(po_details) && po_details.length > 1) {
        const pos = await PurchaseOrderModel.read().catch(() => []);
        const suppliers = po_details.map(pod => {
            const po = pos.find(p => p.po_number === pod.po_number);
            return po ? (po.supplier || '').trim() : null;
        }).filter(Boolean);
        const uniqueSuppliers = new Set(suppliers);
        if (uniqueSuppliers.size > 1) {
            const err = new Error('All POs in a booking must belong to the same vendor');
            err.statusCode = 400;
            throw err;
        }
    }

    const typeLower = (type || '').toLowerCase();
    if (typeLower === 'sms' || (rest.mode === 'Courier' && typeLower !== 'mainline')) {
        const shipmentsData = await ShipmentModel.read();
        const pos = await PurchaseOrderModel.read().catch(() => []);

        // Fix #6 — G2 overbooking guard for SMS bookings
        // SMS bookings live in shipments (not bookings table), so we check shipments directly.
        if (po_details && Array.isArray(po_details)) {
            for (const pod of po_details) {
                if (!pod.po_number) continue;
                const po = pos.find(p => p.po_number === pod.po_number);
                if (!po) continue;
                const expected_qty = parseInt(po.expected_qty) || 0;
                // Sum all non-cancelled existing shipments for this PO (SMS + mainline)
                const alreadyShipped = shipmentsData
                    .filter(s => s.po_number === pod.po_number && s.status !== 'Cancelled')
                    .reduce((sum, s) => sum + (parseInt(s.expected_quantity) || 0), 0);
                // Also sum from active mainline bookings
                const mainlineBookings = await BookingModel.read().catch(() => []);
                const mainlineBooked = mainlineBookings
                    .filter(b => !['Cancelled', 'Rejected'].includes(b.booking_status))
                    .reduce((sum, b) => {
                        if (!Array.isArray(b.po_details)) return sum;
                        const match = b.po_details.find(pd => pd.po_number === pod.po_number);
                        return sum + (match ? (parseInt(match.units) || 0) : 0);
                    }, 0);
                const requested = parseInt(pod.units) || 0;
                const totalAlreadyBooked = alreadyShipped + mainlineBooked;
                if (totalAlreadyBooked + requested > expected_qty) {
                    const err = new Error(
                        `SMS booking for PO ${pod.po_number} would exceed expected quantity (${expected_qty}). Already booked: ${totalAlreadyBooked}, requested: ${requested}`
                    );
                    err.statusCode = 400;
                    throw err;
                }
            }
        }

        const createdShipments = [];

        if (po_details && Array.isArray(po_details)) {
            const validPOs = po_details.filter(p => p.po_number && p.po_number.trim() !== '');
            for (const pod of validPOs) {
                const units = parseInt(pod.units) || 0;
                const lot = await lotService.calculateLotNumber(pod.po_number, units);
                const po = pos.find(p => p.po_number === pod.po_number) || {};

                // Build SKU-level line_items with proportional expected_qty
                const poExpectedQty = parseInt(po.expected_qty) || 0;
                const shipLineItems = (po.line_items || []).map(li => ({
                    sku_code: li.sku_code,
                    description: li.description,
                    expected_qty: poExpectedQty > 0
                        ? Math.round(li.expected_qty * (units / poExpectedQty))
                        : 0,
                    shipped_qty: 0
                }));

                const newShipment = {
                    ...po,
                    ...rest,
                    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                    po_number: pod.po_number,
                    expected_quantity: units,
                    lot_number: lot,
                    line_items: shipLineItems,
                    status: 'Ready to Ship',
                    booking_status: 'No Booking',
                    type: 'sms',
                    // Map specific fields for shipment tracker visibility
                    etd: rest.cargo_ready_date || po.etd || '',
                    supplier: rest.vendor_name || po.supplier || '',
                    destination_warehouse: rest.receiving_warehouse || po.receiving_warehouse || ''
                };
                shipmentsData.push(newShipment);
                createdShipments.push(newShipment);
            }
            await ShipmentModel.write(shipmentsData);

            // Update PO status
            const poNumbers = po_details.map(p => p.po_number);
            const updatedPos = pos.map(p => {
                if (poNumbers.includes(p.po_number)) {
                    return { ...p, booking_status: 'No Booking' };
                }
                return p;
            });
            await PurchaseOrderModel.write(updatedPos);
        }

        return res.status(201).json(createdShipments[0] || { message: 'SMS Shipments created' });
    }

    // Mainline Logic: Create Active Booking
    const data = await BookingModel.read();

    // G2 — Overbooking guard
    if (po_details && Array.isArray(po_details)) {
        const pos = await PurchaseOrderModel.read().catch(() => []);
        for (const pod of po_details) {
            if (!pod.po_number) continue;
            const po = pos.find(p => p.po_number === pod.po_number);
            if (!po) continue;
            const expected_qty = parseInt(po.expected_qty) || 0;
            const booked_units_so_far = data
                .filter(b => !['Cancelled', 'Rejected'].includes(b.booking_status))
                .reduce((sum, b) => {
                    if (!Array.isArray(b.po_details)) return sum;
                    const match = b.po_details.find(pd => pd.po_number === pod.po_number);
                    return sum + (match ? (parseInt(match.units) || 0) : 0);
                }, 0);
            const requested = parseInt(pod.units) || 0;
            if (booked_units_so_far + requested > expected_qty) {
                const err = new Error(
                    `Booking for PO ${pod.po_number} would exceed expected quantity (${expected_qty}). Already booked: ${booked_units_so_far}, requested: ${requested}`
                );
                err.statusCode = 400;
                throw err;
            }
        }
    }

    const newBooking = {
        id: Date.now().toString(),
        type: 'mainline',
        ...req.body,
        booking_status: req.body.booking_status || 'Booking Pending'
    };
    data.push(newBooking);
    await BookingModel.write(data);

    if (newBooking.po_details && Array.isArray(newBooking.po_details)) {
        const pos = await PurchaseOrderModel.read().catch(() => []);
        const poNumbers = newBooking.po_details
            .map(p => p.po_number)
            .filter(Boolean);

        // Only update PO status if no other active booking already covers it.
        // This prevents a second partial booking from overwriting the first
        // booking's approved status.
        const existingBookings = data.filter(b =>
            b.id !== newBooking.id &&
            b.po_details?.some(pd => poNumbers.includes(pd.po_number))
        );

        const updatedPos = pos.map(p => {
            if (!poNumbers.includes(p.po_number)) return p;

            const hasOtherBooking = existingBookings.some(b =>
                b.po_details?.some(pd => pd.po_number === p.po_number)
            );

            if (hasOtherBooking) {
                // Another booking already references this PO — don't overwrite
                return p;
            }

            return {
                ...p,
                booking_status: 'Booking Pending',
                booking_number: newBooking.booking_number
            };
        });
        await PurchaseOrderModel.write(updatedPos);
    }

    res.status(201).json(newBooking);
}

async function update(req, res) {
    const data = await BookingModel.read();
    const idx = data.findIndex(s => s.id === req.params.id);
    if (idx > -1) {
        const oldStatus = data[idx].booking_status;
        const newStatus = req.body.booking_status;

        data[idx] = { ...data[idx], ...req.body };
        await BookingModel.write(data);

        // Approval Logic: If status changed to "Booking Approved", move to shipments
        if (newStatus === 'Booking Approved' && oldStatus !== 'Booking Approved') {
            const shipmentsData = await ShipmentModel.read();
            const pos = await PurchaseOrderModel.read().catch(() => []);
            const booking = data[idx];

            // Fix #4 — Guard against duplicate shipment rows if approval is called twice
            const existingBookingShipments = shipmentsData.filter(
                s => s.booking_number === booking.booking_number
            );

            if (booking.po_details && Array.isArray(booking.po_details)) {
                const validPOs = booking.po_details.filter(p => p.po_number && p.po_number.trim() !== '');
                for (const pod of validPOs) {
                    // Skip if a shipment row for this booking+PO already exists
                    const alreadyExists = existingBookingShipments.some(
                        s => s.po_number === pod.po_number
                    );
                    if (alreadyExists) continue;
                    const units = parseInt(pod.units) || 0;
                    const lot = await lotService.calculateLotNumber(pod.po_number, units);
                    const po = pos.find(p => p.po_number === pod.po_number) || {};

                    // Build SKU-level line_items with proportional expected_qty
                    const poExpectedQty = parseInt(po.expected_qty) || 0;
                    const shipLineItems = (po.line_items || []).map(li => ({
                        sku_code: li.sku_code,
                        description: li.description,
                        expected_qty: poExpectedQty > 0
                            ? Math.round(li.expected_qty * (units / poExpectedQty))
                            : 0,
                        shipped_qty: 0
                    }));

                    const newShipment = {
                        ...po,
                        ...booking,
                        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                        po_number: pod.po_number,
                        expected_quantity: units,
                        lot_number: lot,
                        line_items: shipLineItems,
                        status: 'Booking Approved',
                        booking_status: 'Booking Approved',
                        type: booking.type || 'mainline'
                    };
                    // Remove po_details from individual shipment record to avoid clutter
                    delete newShipment.po_details;
                    shipmentsData.push(newShipment);
                }
                await ShipmentModel.write(shipmentsData);
            }
        }

        // Sync status to POs if it changed
        if (newStatus) {
            await syncPoStatus(data[idx].booking_number, newStatus, data[idx].trn_number);
        }

        // Sync CI received quantities to shipments whenever a confirmed CI is present
        const ci = data[idx].commercial_invoice;
        if (ci?.status === 'confirmed' && Array.isArray(ci.line_items)) {
            await syncCiToShipments(data[idx].booking_number, ci.line_items);
        }

        res.json(data[idx]);
    } else {
        const err = new Error('Not found');
        err.statusCode = 404;
        throw err;
    }
}

async function remove(req, res) {
    let data = await BookingModel.read();
    const bookingToDelete = data.find(b => b.id === req.params.id);

    if (bookingToDelete) {
        const bkgNum = bookingToDelete.booking_number;

        // 1. Delete linked shipment rows
        if (bkgNum) {
            let shipments = await ShipmentModel.read().catch(() => []);
            shipments = shipments.filter(s => s.booking_number !== bkgNum);
            await ShipmentModel.write(shipments);
        }

        // 2. Reset PO statuses only if no OTHER booking still references the PO
        const poNumbers = (bookingToDelete.po_details || [])
            .map(p => p.po_number)
            .filter(Boolean);

        if (poNumbers.length > 0) {
            const remainingBookings = data.filter(b => b.id !== req.params.id);
            const pos = await PurchaseOrderModel.read().catch(() => []);

            const updatedPos = pos.map(p => {
                if (!poNumbers.includes(p.po_number)) return p;

                // Check if another booking still covers this PO
                const otherBooking = remainingBookings.find(b =>
                    b.po_details?.some(pd => pd.po_number === p.po_number)
                );

                if (otherBooking) {
                    // Another booking exists — point the PO to it
                    return {
                        ...p,
                        booking_status: otherBooking.booking_status || 'Booking Pending',
                        booking_number: otherBooking.booking_number
                    };
                }

                return { ...p, booking_status: 'No Booking', booking_number: null };
            });
            await PurchaseOrderModel.write(updatedPos);
        }
    }

    data = data.filter(s => s.id !== req.params.id);
    await BookingModel.write(data);
    res.status(204).send();
}

async function confirmCI(req, res) {
    const data = await BookingModel.read();
    const idx = data.findIndex(b => b.id === req.params.id);
    if (idx === -1) {
        const err = new Error('Booking not found'); err.statusCode = 404; throw err;
    }
    if (!data[idx].commercial_invoice) {
        const err = new Error('No commercial invoice attached to this booking'); err.statusCode = 400; throw err;
    }
    data[idx].commercial_invoice.status = 'confirmed';
    data[idx].commercial_invoice.confirmed_at = new Date().toISOString();

    // G3 — Record unmatched SKU counts at confirm (non-blocking)
    const ciLineItems = data[idx].commercial_invoice.line_items || [];
    const unmatchedCount = ciLineItems.filter(item => item.match_status === 'unmatched').length;
    const matchedQty = ciLineItems
        .filter(item => item.match_status === 'matched')
        .reduce((sum, item) => sum + (parseInt(item.qty) || 0), 0);
    const unmatchedQty = ciLineItems
        .filter(item => item.match_status === 'unmatched')
        .reduce((sum, item) => sum + (parseInt(item.qty) || 0), 0);
    data[idx].commercial_invoice.unmatched_sku_count = unmatchedCount;
    data[idx].commercial_invoice.total_matched_qty = matchedQty;
    data[idx].commercial_invoice.total_unmatched_qty = unmatchedQty;

    await BookingModel.write(data);

    // Sync CI received quantities to shipments
    const ci = data[idx].commercial_invoice;
    if (Array.isArray(ci.line_items)) {
        await syncCiToShipments(data[idx].booking_number, ci.line_items);
    }

    res.json(data[idx]);
}

async function getCI(req, res) {
    const data = await BookingModel.read();
    const booking = data.find(b => b.id === req.params.id);
    if (!booking) {
        const err = new Error('Booking not found'); err.statusCode = 404; throw err;
    }
    if (!booking.commercial_invoice) {
        const err = new Error('No commercial invoice found'); err.statusCode = 404; throw err;
    }
    res.json(booking.commercial_invoice);
}

module.exports = { getAll, create, update, remove, confirmCI, getCI };
