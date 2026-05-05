require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const stream = require('stream');
const path = require('path');
const driveStorage = require('./driveStorage');
const { errorHandler, asyncWrap } = require('./middleware/errorHandler');
const { initCronJobs, runHistorySweep } = require('./services/cronJobs');
const integrationService = require('./services/integrationService');
const lotService = require('./services/lotService');

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
    const user = users.find(u => u.email === email && u.password === password);

    if (user) {
        const { password, ...userWithoutPassword } = user;
        res.json(userWithoutPassword);
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

        // Find all PO numbers in this booking
        const poNumbers = shipments
            .filter(s => s.booking_number === bookingNumber)
            .map(s => s.po_number);

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
app.post('/shipments', asyncWrap(async (req, res) => {
    const data = await readData('shipments.json');
    const newShipment = { id: Date.now().toString(), ...req.body };
    data.push(newShipment);
    await writeData('shipments.json', data);
    res.status(201).json(newShipment);
}));
app.put('/shipments/:id', asyncWrap(async (req, res) => {
    const data = await readData('shipments.json');
    const idx = data.findIndex(s => s.id === req.params.id);
    if (idx > -1) {
        data[idx] = { ...data[idx], ...req.body };
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
app.delete('/shipments/:id', asyncWrap(async (req, res) => {
    let data = await readData('shipments.json');
    const removed = data.find(s => s.id === req.params.id);
    data = data.filter(s => s.id !== req.params.id);
    await writeData('shipments.json', data);
    if (removed?.booking_number) await recalcBookingStatus(removed.booking_number);
    res.status(204).send();
}));

// BULK STATUS — update all PO rows in a booking at once, then recalc aggregate
app.post('/shipments/bulk-status', asyncWrap(async (req, res) => {
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
            return { ...s, status };
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
app.post('/bookings', asyncWrap(async (req, res) => {
    const { type, po_details, ...rest } = req.body;

    const typeLower = (type || '').toLowerCase();
    if (typeLower === 'sms' || (rest.mode === 'Courier' && typeLower !== 'mainline')) {
        const shipmentsData = await readData('shipments.json');
        const pos = await readData('purchase-orders.json').catch(() => []);
        const createdShipments = [];

        if (po_details && Array.isArray(po_details)) {
            const validPOs = po_details.filter(p => p.po_number && p.po_number.trim() !== '');
            for (const pod of validPOs) {
                const units = parseInt(pod.units) || 0;
                const lot = await lotService.calculateLotNumber(pod.po_number, units);
                const po = pos.find(p => p.po_number === pod.po_number) || {};

                const newShipment = {
                    ...po,
                    ...rest,
                    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                    po_number: pod.po_number,
                    expected_quantity: units,
                    lot_number: lot,
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
    const newBooking = {
        id: Date.now().toString(),
        type: 'mainline',
        ...req.body,
        booking_status: 'Booking Pending'
    };
    data.push(newBooking);
    await writeData('bookings.json', data);

    if (newBooking.po_details && Array.isArray(newBooking.po_details)) {
        const pos = await readData('purchase-orders.json').catch(() => []);
        const poNumbers = newBooking.po_details.map(p => p.po_number);

        const updatedPos = pos.map(p => {
            if (poNumbers.includes(p.po_number)) {
                return {
                    ...p,
                    booking_status: 'Booking Pending',
                    booking_number: newBooking.booking_number
                };
            }
            return p;
        });
        await writeData('purchase-orders.json', updatedPos);
    }

    res.status(201).json(newBooking);
}));
app.put('/bookings/:id', asyncWrap(async (req, res) => {
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

            if (booking.po_details && Array.isArray(booking.po_details)) {
                const validPOs = booking.po_details.filter(p => p.po_number && p.po_number.trim() !== '');
                for (const pod of validPOs) {
                    const units = parseInt(pod.units) || 0;
                    const lot = await lotService.calculateLotNumber(pod.po_number, units);
                    const po = pos.find(p => p.po_number === pod.po_number) || {};

                    const newShipment = {
                        ...po,
                        ...booking,
                        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                        po_number: pod.po_number,
                        expected_quantity: units,
                        lot_number: lot,
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

        res.json(data[idx]);
    } else {
        const err = new Error('Not found');
        err.statusCode = 404;
        throw err;
    }
}));

app.delete('/bookings/:id', asyncWrap(async (req, res) => {
    let data = await readData('bookings.json');
    const bookingToDelete = data.find(b => b.id === req.params.id);

    if (bookingToDelete?.po_details) {
        // Reset PO statuses in master list
        const pos = await readData('purchase-orders.json').catch(() => []);
        const poNumbers = bookingToDelete.po_details.map(p => p.po_number);

        if (poNumbers.length > 0) {
            const updatedPos = pos.map(p => {
                if (poNumbers.includes(p.po_number)) {
                    return { ...p, booking_status: 'No Booking', booking_number: null };
                }
                return p;
            });
            await writeData('purchase-orders.json', updatedPos);
        }
    }

    data = data.filter(s => s.id !== req.params.id);
    await writeData('bookings.json', data);
    res.status(204).send();
}));

// PURCHASE ORDERS (PO Master List)
app.get('/purchase-orders', asyncWrap(async (req, res) => {
    try {
        const shipments = await readData('shipments.json').catch(() => []);
        const history = await readData('history.json').catch(() => []);
        const allShipments = [...shipments, ...history];

        const bookings = await readData('bookings.json').catch(() => []);
        const historyBookings = await readData('history-bookings.json').catch(() => []);
        const allBookings = [...bookings, ...historyBookings];

        const pos = await readData('purchase-orders.json').catch(() => []);

        const enriched = pos.map(p => {
            const poNum = (p.po_number || '').trim();
            const relatedShipments = allShipments.filter(s => (s.po_number || '').trim() === poNum);

            // Sum received_quantity
            const totalReceived = relatedShipments.reduce((sum, s) => sum + (parseInt(s.received_quantity) || 0), 0);

            // Sum booked units
            // Bookings store po_details[] which contains units (Mainline)
            let totalBooked = 0;
            allBookings.forEach(b => {
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
    } catch (e) {
        res.json([]);
    }
}));
app.post('/purchase-orders', asyncWrap(async (req, res) => {
    const data = await readData('purchase-orders.json').catch(() => []);
    const newPO = { id: Date.now().toString(), booking_status: 'No Booking', booking_number: null, ...req.body };
    data.push(newPO);
    await writeData('purchase-orders.json', data);
    res.status(201).json(newPO);
}));
app.post('/purchase-orders/bulk', asyncWrap(async (req, res) => {
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
app.put('/purchase-orders/:id', asyncWrap(async (req, res) => {
    const data = await readData('purchase-orders.json').catch(() => []);
    const idx = data.findIndex(p => p.id === req.params.id);
    if (idx > -1) {
        data[idx] = { ...data[idx], ...req.body };
        await writeData('purchase-orders.json', data);
        res.json(data[idx]);
    } else {
        const err = new Error('Not found'); err.statusCode = 404; throw err;
    }
}));
app.delete('/purchase-orders/:id', asyncWrap(async (req, res) => {
    let data = await readData('purchase-orders.json').catch(() => []);
    data = data.filter(p => p.id !== req.params.id);
    await writeData('purchase-orders.json', data);
    res.status(204).send();
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
app.post('/eom-tasks/bulk', asyncWrap(async (req, res) => {
    const data = await readData('eom-tasks.json');
    const newTasks = req.body.map(t => ({ id: Math.random().toString(36).substr(2, 9), ...t }));
    const combined = [...data, ...newTasks];
    await writeData('eom-tasks.json', combined);
    res.status(201).json(newTasks);
}));
app.put('/eom-tasks/:id', asyncWrap(async (req, res) => {
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
    const shipments = await readData('shipments.json');
    const pos = await readData('purchase-orders.json').catch(() => []);

    const reports = shipments.map(s => {
        const po = pos.find(p => p.po_number === s.po_number) || {};
        const expected = parseInt(s.expected_quantity || po.expected_qty || '0', 10);
        const received = parseInt(s.received_units || '0', 10);
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
    const shipments = await readData('shipments.json');
    const pos = await readData('purchase-orders.json').catch(() => []);

    // Helper for ISO week number
    const getWeekNumber = (d) => {
        d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    };

    const forecast = shipments.reduce((acc, s) => {
        if (s.status === 'Delivered') return acc;

        const date = new Date(s.eta);
        if (isNaN(date.getTime())) return acc;

        const weekNum = getWeekNumber(date);
        const year = date.getFullYear();
        const weekKey = `W${weekNum} - ${year}`;

        if (!acc[weekKey]) acc[weekKey] = { week: weekKey, weekNum, cartons: 0, units: 0, warehouses: {} };

        const units = parseInt(s.expected_quantity || s.expected_qty || '0', 10);
        // Fallback: estimate 20 units per carton if cartons not explicitly set
        const cartons = parseInt(s.number_of_cartons || s.cartons || Math.ceil(units / 20).toString(), 10);
        const wh = s.destination_warehouse || s.receiving_warehouse || 'Unknown';

        acc[weekKey].cartons += cartons;
        acc[weekKey].units += units;

        if (!acc[weekKey].warehouses[wh]) acc[weekKey].warehouses[wh] = 0;
        acc[weekKey].warehouses[wh] += units;

        return acc;
    }, {});

    // Sort by week number
    const sortedForecast = Object.values(forecast).sort((a, b) => {
        return a.weekNum - b.weekNum;
    });

    res.json(sortedForecast);
}));

app.post('/history/sweep', asyncWrap(async (req, res) => {
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
