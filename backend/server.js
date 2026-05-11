require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const stream = require('stream');
const path = require('path');
const jwt = require('jsonwebtoken');
const { verifyPassword } = require('./utils/passwordUtils');
const driveStorage = require('./driveStorage');
const { errorHandler, asyncWrap } = require('./middleware/errorHandler');
const { initCronJobs, runHistorySweep } = require('./services/cronJobs');
const integrationService = require('./services/integrationService');
const lotService = require('./services/lotService');
const ciParser = require('./services/ciParser');

const JWT_SECRET = process.env.JWT_SECRET || 'tentree-dev-secret-2026';

function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    const token = authHeader.slice(7);
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));

const upload = multer();

const readData = async (filename) => {
    return await driveStorage.readData(filename);
};

const writeData = async (filename, data) => {
    await driveStorage.writeData(filename, data);
};

app.get('/health', (req, res) => {
    res.status(200).json({ 'message': 'initial running' });
});

// AUTH
app.post('/login', asyncWrap(async (req, res) => {
    const { email, password } = req.body;
    const users = await readData('users.json');
    const userByEmail = users.find(u => u.email === email);
    const user = userByEmail && await verifyPassword(password, userByEmail.password) ? userByEmail : null;

    if (user) {
        const { password, ...userWithoutPassword } = user;
        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        res.json({ ...userWithoutPassword, token });
    } else {
        const err = new Error('Invalid credentials');
        err.statusCode = 401;
        throw err;
    }
}));

/**
 * Synchronizes the booking_status in purchase-orders.json for all POs
 * associated with a specific booking number.
 */
async function syncPoStatus(bookingNumber, status, trnNumber) {
    if (!bookingNumber) return;
    try {
        const pos = await readData('purchase-orders.json').catch(() => []);
        const shipments = await readData('shipments.json');

        // Find all PO numbers in this booking via shipment rows
        let poNumbers = shipments
            .filter(s => s.booking_number === bookingNumber)
            .map(s => s.po_number);

        // Fix #7 — For mainline bookings before approval, there are no shipment rows yet.
        // Fall back to scanning the bookings table for this booking_number.
        if (poNumbers.length === 0) {
            const bookings = await readData('bookings.json').catch(() => []);
            const booking = bookings.find(b => b.booking_number === bookingNumber);
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
            await writeData('purchase-orders.json', updatedPos);
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
        const shipments = await readData('shipments.json');

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
            const ciQty = poQtyMap[s.po_number];
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

        if (changed) await writeData('shipments.json', updated);
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
        const shipments = await readData('shipments.json');
        const bookings = await readData('bookings.json');
        const masterStatuses = await readData('statuses.json').catch(() => []);

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
            const lowestIdx = statusOrder.indexOf(lowest);
            const currentIdx = statusOrder.indexOf(current);
            if (currentIdx === -1) return lowest;
            if (lowestIdx === -1) return current;
            return currentIdx < lowestIdx ? current : lowest;
        });

        const bIdx = bookings.findIndex(b => b.booking_number === bookingNumber);
        if (bIdx > -1 && bookings[bIdx].booking_status !== aggregate) {
            bookings[bIdx] = { ...bookings[bIdx], booking_status: aggregate };
            await writeData('bookings.json', bookings);

            // Sync status back to PO master list
            await syncPoStatus(bookingNumber, aggregate);
        }
    } catch (e) {
        console.error('[recalcBookingStatus] error:', e);
    }
}

// SHIPMENTS
app.get('/shipments', asyncWrap(async (req, res) => {
    const shipments = await readData('shipments.json');
    const pos = await readData('purchase-orders.json').catch(() => []);

    // Enrich shipments with PO data if fields are missing
    const enriched = shipments.map(s => {
        const po = pos.find(p => p.po_number === s.po_number);
        if (!po) return s;
        return {
            ...s,
            expected_quantity: s.expected_quantity || po.expected_qty || '',
            destination_warehouse: s.destination_warehouse || po.receiving_warehouse || '',
            season: s.season || po.season || '',
            supplier: s.supplier || po.supplier || '',
            courier: s.courier || po.courier || ''
        };
    });
    res.json(enriched);
}));
app.post('/shipments', requireAuth, asyncWrap(async (req, res) => {
    // Fix #3 — Input validation
    if (!req.body.po_number) {
        const err = new Error('po_number is required');
        err.statusCode = 400;
        throw err;
    }
    const data = await readData('shipments.json');
    const newShipment = { id: Date.now().toString(), ...req.body };
    data.push(newShipment);
    await writeData('shipments.json', data);
    res.status(201).json(newShipment);
}));
app.put('/shipments/:id', requireAuth, asyncWrap(async (req, res) => {
    const data = await readData('shipments.json');
    const idx = data.findIndex(s => s.id === req.params.id);
    if (idx > -1) {
        data[idx] = { ...data[idx], ...req.body };
        // Auto-set received_quantity from expected_quantity when marked Delivered (if not already set by CI)
        if (req.body.status === 'Delivered' && !data[idx].received_quantity) {
            data[idx].received_quantity = parseInt(data[idx].expected_quantity) || 0;
        }
        await writeData('shipments.json', data);
        // Recalculate aggregate booking status after any individual PO status change
        await recalcBookingStatus(data[idx].booking_number);
        res.json(data[idx]);
    } else {
        const err = new Error('Not found');
        err.statusCode = 404;
        throw err;
    }
}));
app.delete('/shipments/:id', requireAuth, asyncWrap(async (req, res) => {
    let data = await readData('shipments.json');
    const removed = data.find(s => s.id === req.params.id);
    data = data.filter(s => s.id !== req.params.id);
    await writeData('shipments.json', data);
    if (removed?.booking_number) await recalcBookingStatus(removed.booking_number);
    res.status(204).send();
}));

// SHIPMENT LINE ITEMS
app.get('/shipments/:id/line-items', asyncWrap(async (req, res) => {
    const shipments = await readData('shipments.json');
    const shipment = shipments.find(s => s.id === req.params.id);
    if (!shipment) {
        const err = new Error('Shipment not found'); err.statusCode = 404; throw err;
    }
    res.json(shipment.line_items || []);
}));

// BULK STATUS — update all PO rows in a booking at once, then recalc aggregate
app.post('/shipments/bulk-status', requireAuth, asyncWrap(async (req, res) => {
    const { booking_number, status } = req.body;
    if (!booking_number || !status) {
        const err = new Error('booking_number and status are required');
        err.statusCode = 400;
        throw err;
    }
    let data = await readData('shipments.json');
    let updatedCount = 0;
    data = data.map(s => {
        if (s.booking_number === booking_number) {
            updatedCount++;
            const updated = { ...s, status };
            // Auto-set received_quantity from expected_quantity when bulk-marking Delivered (if not already set by CI)
            if (status === 'Delivered' && !s.received_quantity) {
                updated.received_quantity = parseInt(s.expected_quantity) || 0;
            }
            return updated;
        }
        return s;
    });
    await writeData('shipments.json', data);
    await recalcBookingStatus(booking_number);
    res.json({ updated: updatedCount, booking_number, status });
}));

/**
 * Enriches a list of bookings with metadata from purchase-orders.json
 * if the booking itself is missing those fields (legacy data support).
 */
async function enrichBookings(bookings) {
    const pos = await readData('purchase-orders.json').catch(() => []);

    return bookings.map(b => {
        // Find first PO in details to get general info if missing
        const firstPoNum = (b.po_details?.[0]?.po_number || '').trim();
        const mainPo = pos.find(p => (p.po_number || '').trim() === firstPoNum);

        return {
            ...b,
            receiving_warehouse: b.receiving_warehouse || mainPo?.receiving_warehouse || '',
            season: b.season || mainPo?.season || '',
            trn_number: b.trn_number || mainPo?.trn_number || '',
            type: b.type || mainPo?.type || '',
            mode: b.mode || mainPo?.mode || '',
            incoterm: b.incoterm || mainPo?.incoterm || '',
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

// BOOKINGS
app.get('/bookings', asyncWrap(async (req, res) => {
    const bookings = await readData('bookings.json');
    const enriched = await enrichBookings(bookings);
    res.json(enriched);
}));
app.post('/bookings', requireAuth, asyncWrap(async (req, res) => {
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
        const pos = await readData('purchase-orders.json').catch(() => []);
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
        const shipmentsData = await readData('shipments.json');
        const pos = await readData('purchase-orders.json').catch(() => []);

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
                const mainlineBookings = await readData('bookings.json').catch(() => []);
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
            await writeData('shipments.json', shipmentsData);

            // Update PO status
            const poNumbers = po_details.map(p => p.po_number);
            const updatedPos = pos.map(p => {
                if (poNumbers.includes(p.po_number)) {
                    return { ...p, booking_status: 'No Booking' };
                }
                return p;
            });
            await writeData('purchase-orders.json', updatedPos);
        }

        return res.status(201).json(createdShipments[0] || { message: 'SMS Shipments created' });
    }

    // Mainline Logic: Create Active Booking
    const data = await readData('bookings.json');

    // G2 — Overbooking guard
    if (po_details && Array.isArray(po_details)) {
        const pos = await readData('purchase-orders.json').catch(() => []);
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
    await writeData('bookings.json', data);

    if (newBooking.po_details && Array.isArray(newBooking.po_details)) {
        const pos = await readData('purchase-orders.json').catch(() => []);
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
        await writeData('purchase-orders.json', updatedPos);
    }

    res.status(201).json(newBooking);
}));
app.put('/bookings/:id', requireAuth, asyncWrap(async (req, res) => {
    const data = await readData('bookings.json');
    const idx = data.findIndex(s => s.id === req.params.id);
    if (idx > -1) {
        const oldStatus = data[idx].booking_status;
        const newStatus = req.body.booking_status;

        data[idx] = { ...data[idx], ...req.body };
        await writeData('bookings.json', data);

        // Approval Logic: If status changed to "Booking Approved", move to shipments
        if (newStatus === 'Booking Approved' && oldStatus !== 'Booking Approved') {
            const shipmentsData = await readData('shipments.json');
            const pos = await readData('purchase-orders.json').catch(() => []);
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
                await writeData('shipments.json', shipmentsData);
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
}));

app.delete('/bookings/:id', requireAuth, asyncWrap(async (req, res) => {
    let data = await readData('bookings.json');
    const bookingToDelete = data.find(b => b.id === req.params.id);

    if (bookingToDelete) {
        const bkgNum = bookingToDelete.booking_number;

        // 1. Delete linked shipment rows
        if (bkgNum) {
            let shipments = await readData('shipments.json').catch(() => []);
            shipments = shipments.filter(s => s.booking_number !== bkgNum);
            await writeData('shipments.json', shipments);
        }

        // 2. Reset PO statuses only if no OTHER booking still references the PO
        const poNumbers = (bookingToDelete.po_details || [])
            .map(p => p.po_number)
            .filter(Boolean);

        if (poNumbers.length > 0) {
            const remainingBookings = data.filter(b => b.id !== req.params.id);
            const pos = await readData('purchase-orders.json').catch(() => []);

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
            await writeData('purchase-orders.json', updatedPos);
        }
    }

    data = data.filter(s => s.id !== req.params.id);
    await writeData('bookings.json', data);
    res.status(204).send();
}));

// BOOKING COMMERCIAL INVOICES
app.post('/bookings/:id/commercial-invoice/confirm', requireAuth, asyncWrap(async (req, res) => {
    const data = await readData('bookings.json');
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

    await writeData('bookings.json', data);

    // Sync CI received quantities to shipments
    const ci = data[idx].commercial_invoice;
    if (Array.isArray(ci.line_items)) {
        await syncCiToShipments(data[idx].booking_number, ci.line_items);
    }

    res.json(data[idx]);
}));

app.get('/bookings/:id/commercial-invoice', asyncWrap(async (req, res) => {
    const data = await readData('bookings.json');
    const booking = data.find(b => b.id === req.params.id);
    if (!booking) {
        const err = new Error('Booking not found'); err.statusCode = 404; throw err;
    }
    if (!booking.commercial_invoice) {
        const err = new Error('No commercial invoice found'); err.statusCode = 404; throw err;
    }
    res.json(booking.commercial_invoice);
}));

// PURCHASE ORDERS (PO Master List)
app.get('/purchase-orders', asyncWrap(async (req, res) => {
    // Fix #16 — Remove silent catch-all; individual data files use .catch(()=>[]) for graceful fallback.
    // purchase-orders.json itself is required — let it throw if missing (asyncWrap handles it).
    {
        const shipments = await readData('shipments.json').catch(() => []);
        const history = await readData('history.json').catch(() => []);
        const allShipments = [...shipments, ...history];

        const bookings = await readData('bookings.json').catch(() => []);
        const historyBookings = await readData('history-bookings.json').catch(() => []);
        const allBookings = [...bookings, ...historyBookings];

        const pos = await readData('purchase-orders.json');

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
                received_qty: totalReceived,
                booked_qty: totalBooked,
                actual_receive_date: latestDate
            };
        });

        res.json(enriched);
    }
}));
app.post('/purchase-orders', requireAuth, asyncWrap(async (req, res) => {
    // Fix #3 — Input validation
    if (!req.body.po_number) {
        const err = new Error('po_number is required');
        err.statusCode = 400;
        throw err;
    }
    const data = await readData('purchase-orders.json').catch(() => []);
    const newPO = { id: Date.now().toString(), booking_status: 'No Booking', booking_number: null, ...req.body };
    data.push(newPO);
    await writeData('purchase-orders.json', data);
    res.status(201).json(newPO);
}));
app.post('/purchase-orders/bulk', requireAuth, asyncWrap(async (req, res) => {
    const existing = await readData('purchase-orders.json').catch(() => []);
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

    await writeData('purchase-orders.json', combined);
    res.status(201).json({ updated: updatedCount, added: addedCount });
}));
app.get('/purchase-orders/:id', asyncWrap(async (req, res) => {
    const pos = await readData('purchase-orders.json').catch(() => []);
    const po = pos.find(p => p.id === req.params.id);
    if (!po) {
        const err = new Error('Not found'); err.statusCode = 404; throw err;
    }
    res.json(po);
}));
app.put('/purchase-orders/:id', requireAuth, asyncWrap(async (req, res) => {
    const data = await readData('purchase-orders.json').catch(() => []);
    const idx = data.findIndex(p => p.id === req.params.id);
    if (idx > -1) {
        const updated = { ...data[idx], ...req.body };
        // Auto-compute expected_qty from line_items if present
        if (Array.isArray(updated.line_items) && updated.line_items.length > 0) {
            const sum = updated.line_items.reduce((s, item) => s + (parseInt(item.expected_qty) || 0), 0);
            if (sum > 0) updated.expected_qty = sum;
        }
        data[idx] = updated;
        await writeData('purchase-orders.json', data);
        res.json(data[idx]);
    } else {
        const err = new Error('Not found'); err.statusCode = 404; throw err;
    }
}));
app.delete('/purchase-orders/:id', requireAuth, asyncWrap(async (req, res) => {
    let data = await readData('purchase-orders.json').catch(() => []);
    data = data.filter(p => p.id !== req.params.id);
    await writeData('purchase-orders.json', data);
    res.status(204).send();
}));

// PO SHIPMENT LOTS — all shipments for a PO with lot info and remaining qty
app.get('/purchase-orders/:id/shipment-lots', asyncWrap(async (req, res) => {
    const pos = await readData('purchase-orders.json').catch(() => []);
    const po = pos.find(p => p.id === req.params.id);
    if (!po) {
        const err = new Error('Not found'); err.statusCode = 404; throw err;
    }

    const shipments = await readData('shipments.json').catch(() => []);
    const history = await readData('history.json').catch(() => []);
    const allShipments = [...shipments, ...history];

    const poShipments = allShipments.filter(s => s.po_number === po.po_number);

    // Sum booked qty from non-Cancelled shipments
    const totalBooked = poShipments
        .filter(s => s.status !== 'Cancelled')
        .reduce((sum, s) => sum + (parseInt(s.expected_quantity) || 0), 0);

    const remaining_qty = (parseInt(po.expected_qty) || 0) - totalBooked;

    const lots = poShipments.map(s => ({
        shipment_id: s.id,
        booking_number: s.booking_number || null,
        lot_number: s.lot_number ?? null,
        booked_qty: parseInt(s.expected_quantity) || 0,
        status: s.status || 'Unknown',
        line_items: s.line_items || []
    }));

    res.json({ po_number: po.po_number, expected_qty: po.expected_qty, remaining_qty, lots });
}));

// PO LINE ITEMS
app.post('/purchase-orders/:id/line-items', requireAuth, asyncWrap(async (req, res) => {
    const data = await readData('purchase-orders.json').catch(() => []);
    const idx = data.findIndex(p => p.id === req.params.id);
    if (idx === -1) {
        const err = new Error('Not found'); err.statusCode = 404; throw err;
    }
    const { line_items } = req.body;
    if (!Array.isArray(line_items)) {
        const err = new Error('line_items must be an array'); err.statusCode = 400; throw err;
    }
    data[idx].line_items = line_items;
    // Auto-compute expected_qty from line_items
    const sum = line_items.reduce((s, item) => s + (parseInt(item.expected_qty) || 0), 0);
    if (sum > 0) data[idx].expected_qty = sum;
    await writeData('purchase-orders.json', data);
    res.json(data[idx]);
}));

app.put('/purchase-orders/:id/line-items/:sku', requireAuth, asyncWrap(async (req, res) => {
    const data = await readData('purchase-orders.json').catch(() => []);
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
    await writeData('purchase-orders.json', data);
    res.json(po);
}));

// PO FULFILLMENT (computed: expected vs shipped per SKU)
app.get('/purchase-orders/:id/fulfillment', asyncWrap(async (req, res) => {
    const pos = await readData('purchase-orders.json').catch(() => []);
    const po = pos.find(p => p.id === req.params.id);
    if (!po) {
        const err = new Error('Not found'); err.statusCode = 404; throw err;
    }
    if (!Array.isArray(po.line_items) || po.line_items.length === 0) {
        return res.json({ line_items: [], message: 'No SKU line items on this PO' });
    }

    // Sum shipped qty from confirmed bookings whose CI line_items match each SKU
    const bookings = await readData('bookings.json').catch(() => []);
    const confirmedBookings = bookings.filter(b =>
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
}));

// MASTER DATA
app.get('/master-data/suppliers', asyncWrap(async (req, res) => {
    res.json(await readData('suppliers.json').catch(() => []));
}));
app.put('/master-data/suppliers', requireAuth, asyncWrap(async (req, res) => {
    await writeData('suppliers.json', req.body);
    res.json({ success: true });
}));

app.get('/master-data/couriers', asyncWrap(async (req, res) => {
    res.json(await readData('couriers.json').catch(() => []));
}));
app.put('/master-data/couriers', requireAuth, asyncWrap(async (req, res) => {
    await writeData('couriers.json', req.body);
    res.json({ success: true });
}));

app.get('/master-data/incoterms', asyncWrap(async (req, res) => {
    res.json(await readData('incoterms.json').catch(() => []));
}));
app.put('/master-data/incoterms', requireAuth, asyncWrap(async (req, res) => {
    await writeData('incoterms.json', req.body);
    res.json({ success: true });
}));

app.get('/master-data/statuses', asyncWrap(async (req, res) => {
    res.json(await readData('statuses.json').catch(() => []));
}));
app.put('/master-data/statuses', requireAuth, asyncWrap(async (req, res) => {
    await writeData('statuses.json', req.body);
    res.json({ success: true });
}));

// CONTACTS
app.get('/contacts', asyncWrap(async (req, res) => {
    res.json(await readData('contacts.json'));
}));

// EOM TASKS
app.get('/eom-tasks', asyncWrap(async (req, res) => {
    let data = await readData('eom-tasks.json');
    if (req.query.month) {
        data = data.filter(t => t.month === req.query.month);
    }
    res.json(data);
}));
app.post('/eom-tasks/bulk', requireAuth, asyncWrap(async (req, res) => {
    const data = await readData('eom-tasks.json');
    const newTasks = req.body.map(t => ({ id: Math.random().toString(36).substr(2, 9), ...t }));
    const combined = [...data, ...newTasks];
    await writeData('eom-tasks.json', combined);
    res.status(201).json(newTasks);
}));
app.put('/eom-tasks/:id', requireAuth, asyncWrap(async (req, res) => {
    const data = await readData('eom-tasks.json');
    const idx = data.findIndex(s => s.id === req.params.id);
    if (idx > -1) {
        data[idx] = { ...data[idx], ...req.body };
        await writeData('eom-tasks.json', data);
        res.json(data[idx]);
    } else {
        const err = new Error('Not found');
        err.statusCode = 404;
        throw err;
    }
}));



// HISTORY
app.get('/history', asyncWrap(async (req, res) => {
    try {
        const data = await readData('history.json');
        res.json(data);
    } catch (e) {
        // history.json might not exist yet if no items were archived
        res.json([]);
    }
}));

app.get('/history-bookings', asyncWrap(async (req, res) => {
    try {
        const data = await readData('history-bookings.json');
        const enriched = await enrichBookings(data);
        res.json(enriched);
    } catch (e) {
        res.json([]);
    }
}));

// REPORTS & FORECAST MOCKS
app.get('/reports', asyncWrap(async (req, res) => {
    const activeShipments = await readData('shipments.json').catch(() => []);
    const historyShipments = await readData('history.json').catch(() => []);
    const shipments = [...activeShipments, ...historyShipments];
    const pos = await readData('purchase-orders.json').catch(() => []);

    const reports = shipments.map(s => {
        const po = pos.find(p => p.po_number === s.po_number) || {};
        const expected = parseInt(s.expected_quantity || po.expected_qty || '0', 10);
        // Fix #13 — field is received_quantity everywhere else; received_units was a typo
        const received = parseInt(s.received_quantity || s.received_units || '0', 10);
        const discrepancy = received - expected;

        return {
            id: s.id,
            po_number: s.po_number,
            season: s.season || po.season,
            type: (s.type || po.type || '').toLowerCase(),
            mode: s.mode || po.mode || '',
            courier: s.courier || '',
            booking_number: s.booking_number || po.booking_number || '',
            supplier: s.supplier || po.supplier,
            expected_units: expected,
            received_units: received,
            discrepancy: discrepancy,
            invoice_value: parseFloat(s.invoice_value || '0'),
            duty: parseFloat(s.duty || '0'),
            freight: parseFloat(s.freight || '0'),
            total_cost: parseFloat(s.invoice_value || '0') + parseFloat(s.duty || '0') + parseFloat(s.freight || '0'),
            status: s.status,
            etd: s.etd || po.etd || '',
            eta: s.eta || po.eta || '',
            lot_number: s.lot_number || null
        };
    });
    res.json(reports);
}));

app.get('/forecast', asyncWrap(async (req, res) => {
    const activeShipments = await readData('shipments.json').catch(() => []);
    const pos = await readData('purchase-orders.json').catch(() => []);

    // Helper for ISO week number
    const getWeekNumber = (d) => {
        d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    };

    const processItem = (acc, item, isPO = false) => {
        if (!isPO && item.status === 'Delivered') return acc;
        
        const date = new Date(item.eta);
        if (isNaN(date.getTime())) return acc;

        const weekNum = getWeekNumber(date);
        const year = date.getFullYear();
        const weekKey = `W${weekNum} - ${year}`;

        if (!acc[weekKey]) acc[weekKey] = { week: weekKey, weekNum, cartons: 0, units: 0, warehouses: {} };

        const units = parseInt(isPO ? item.expected_qty : (item.expected_quantity || item.expected_qty || '0'), 10);
        if (units <= 0) return acc;

        const cartons = parseInt(item.number_of_cartons || item.cartons || Math.ceil(units / 20).toString(), 10);
        const wh = item.destination_warehouse || item.receiving_warehouse || 'Unknown';

        acc[weekKey].cartons += cartons;
        acc[weekKey].units += units;

        if (!acc[weekKey].warehouses[wh]) acc[weekKey].warehouses[wh] = 0;
        acc[weekKey].warehouses[wh] += units;

        return acc;
    };

    let forecast = activeShipments.reduce((acc, s) => processItem(acc, s, false), {});

    // Add unassigned POs
    pos.forEach(po => {
        const linked = activeShipments.filter(s => s.po_number === po.po_number);
        const totalExpectedInLots = linked.reduce((sum, s) => sum + parseInt(s.expected_quantity || '0', 10), 0);
        const poExpected = parseInt(po.expected_qty || '0', 10);
        
        if (totalExpectedInLots < poExpected && po.booking_status !== 'Delivered') {
            const unassignedUnits = poExpected - totalExpectedInLots;
            processItem(forecast, { ...po, expected_qty: unassignedUnits }, true);
        }
    });

    // Sort by week number
    const sortedForecast = Object.values(forecast).sort((a, b) => {
        return a.weekNum - b.weekNum;
    });

    res.json(sortedForecast);
}));

app.post('/history/sweep', requireAuth, asyncWrap(async (req, res) => {
    const result = await runHistorySweep();
    res.json(result);
}));

// INTEGRATION MOCKS endpoints (Optional, for frontend to hit)
app.get('/integrations/netsuite/pos', asyncWrap(async (req, res) => {
    const pos = await integrationService.fetchNetSuitePOs();
    res.json(pos);
}));

// DOCUMENTS UPLOAD
app.post('/documents/upload', upload.single('file'), asyncWrap(async (req, res) => {
    if (!req.file) {
        const err = new Error('No file uploaded');
        err.statusCode = 400;
        throw err;
    }

    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);

    const result = await driveStorage.uploadFile(req.file.originalname, bufferStream, req.file.mimetype);
    res.json(result);
}));

// COMMERCIAL INVOICES — parse only (nothing saved until Step 3 / confirm)
app.post('/commercial-invoices/parse', upload.single('file'), asyncWrap(async (req, res) => {
    if (!req.file) {
        const err = new Error('No file uploaded'); err.statusCode = 400; throw err;
    }

    // po_numbers: JSON string ("[\"PO-SS26-001\"]") or comma-separated string
    let poNumbers = [];
    if (req.body.po_numbers) {
        try {
            poNumbers = JSON.parse(req.body.po_numbers);
        } catch {
            poNumbers = String(req.body.po_numbers).split(',').map(s => s.trim()).filter(Boolean);
        }
    }

    // Optional column/row config override from the form body
    let config = {};
    if (req.body.config) {
        try { config = JSON.parse(req.body.config); } catch { /* use default */ }
    }

    // Parse the Excel file — wrap for a user-friendly error message
    let header, poSummary, lineItems;
    try {
        ({ header, poSummary, lineItems } = ciParser.parseCIExcel(req.file.buffer, config));
    } catch (e) {
        const err = new Error('Failed to parse CI file: ' + e.message);
        err.statusCode = 422;
        throw err;
    }

    // Build a sku_code → { po_number, expected_qty } lookup from the referenced POs
    const poSkuMap = {};
    if (poNumbers.length > 0) {
        const pos = await readData('purchase-orders.json').catch(() => []);
        for (const po of pos) {
            if (!poNumbers.includes(po.po_number)) continue;
            for (const li of (po.line_items || [])) {
                if (li.sku_code) {
                    poSkuMap[li.sku_code] = { po_number: po.po_number, expected_qty: li.expected_qty };
                }
            }
        }
    }

    // Enrich each line item with match information
    const enriched = lineItems.map(item => {
        const match = poSkuMap[item.sku_code];
        return {
            ...item,
            match_status:    match ? 'matched' : (poNumbers.length > 0 ? 'unmatched' : 'pending'),
            matched_po:      match?.po_number ?? null,
            po_expected_qty: match?.expected_qty ?? null,
        };
    });
    
    // Recalculate PO summary using sums from the line items (except cartons, which is kept as-is)
    const recalculatedPoSummary = poSummary.map(ps => {
        const matchedItems = enriched.filter(i => i.matched_po === ps.po_number);
        if (matchedItems.length > 0) {
            return {
                ...ps,
                shipped_qty: matchedItems.reduce((sum, i) => sum + (i.qty || 0), 0),
                weight_kg: parseFloat(matchedItems.reduce((sum, i) => sum + (i.weight_kg || 0), 0).toFixed(2)),
                cbm: parseFloat(matchedItems.reduce((sum, i) => sum + (i.cbm || 0), 0).toFixed(3))
            };
        }
        return ps;
    });

    const summary = {
        total_items: enriched.length,
        matched:     enriched.filter(i => i.match_status === 'matched').length,
        unmatched:   enriched.filter(i => i.match_status === 'unmatched').length,
        total_qty:   enriched.reduce((s, i) => s + i.qty, 0),
    };

    res.json({ header, poSummary: recalculatedPoSummary, lineItems: enriched, summary });
}));

// Global Error Handler must be last!
app.use(errorHandler);

if (require.main === module) {
    // Initialize Drive and start server
    driveStorage.init().then(() => {
        initCronJobs();
        app.listen(PORT, () => {
            console.log(`Server is listening at http://localhost:${PORT}`)
        });
    });
}

module.exports = app;
