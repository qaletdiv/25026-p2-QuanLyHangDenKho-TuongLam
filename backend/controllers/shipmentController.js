const ShipmentModel = require('../models/ShipmentModel');
const { history: HistoryShipmentModel } = require('../models/HistoryModel');
const { enrichShipments } = require('../services/shipmentService');
const { recalcBookingStatus } = require('../services/bookingService');

async function nextShipmentId() {
    const data = await ShipmentModel.read().catch(() => []);
    const maxId = data.reduce((max, s) => Math.max(max, parseInt(s.id) || 0), 0);
    return String(maxId + 1);
}

async function getAll(req, res) {
    const shipments = await ShipmentModel.read();
    const enriched = await enrichShipments(shipments);
    res.json(enriched);
}

async function getOne(req, res) {
    const [active, history] = await Promise.all([
        ShipmentModel.read().catch(() => []),
        HistoryShipmentModel.read().catch(() => []),
    ]);
    const shipment = [...active, ...history].find(s => s.id === req.params.id);
    if (!shipment) {
        const err = new Error('Shipment not found');
        err.statusCode = 404;
        throw err;
    }
    const enriched = await enrichShipments([shipment]);
    res.json(enriched[0]);
}

async function create(req, res) {
    const data = await ShipmentModel.read();
    const newShipment = { id: await nextShipmentId(), ...req.body };
    data.push(newShipment);
    await ShipmentModel.write(data);
    res.status(201).json(newShipment);
}

async function update(req, res) {
    const data = await ShipmentModel.read();
    const idx = data.findIndex(s => s.id === req.params.id);
    if (idx > -1) {
        data[idx] = { ...data[idx], ...req.body };
        // Auto-set received_quantity from expected_quantity when marked Delivered (if not already set by CI)
        if (req.body.status === 'Delivered' && !data[idx].received_quantity) {
            data[idx].received_quantity = parseInt(data[idx].expected_quantity) || 0;
        }
        await ShipmentModel.write(data);
        // Recalculate aggregate booking status after any individual PO status change
        await recalcBookingStatus(data[idx].booking_number);
        res.json(data[idx]);
    } else {
        const err = new Error('Not found');
        err.statusCode = 404;
        throw err;
    }
}

async function remove(req, res) {
    let data = await ShipmentModel.read();
    const removed = data.find(s => s.id === req.params.id);
    data = data.filter(s => s.id !== req.params.id);
    await ShipmentModel.write(data);
    if (removed?.booking_number) await recalcBookingStatus(removed.booking_number);
    res.status(204).send();
}

// BULK STATUS — update all PO rows in a booking at once, then recalc aggregate
async function bulkStatus(req, res) {
    const { booking_number, status } = req.body;
    let data = await ShipmentModel.read();
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
    await ShipmentModel.write(data);
    await recalcBookingStatus(booking_number);
    res.json({ updated: updatedCount, booking_number, status });
}

module.exports = { getAll, getOne, create, update, remove, bulkStatus };
