const ShipmentModel      = require('../models/ShipmentModel');
const PurchaseOrderModel = require('../models/PurchaseOrderModel');
const { history: HistoryModel } = require('../models/HistoryModel');

async function getReports(req, res) {
    const activeShipments   = await ShipmentModel.read().catch(() => []);
    const historyShipments  = await HistoryModel.read().catch(() => []);
    const shipments = [...activeShipments, ...historyShipments];
    const pos = await PurchaseOrderModel.read().catch(() => []);

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
}

async function getForecast(req, res) {
    const activeShipments = await ShipmentModel.read().catch(() => []);
    const pos             = await PurchaseOrderModel.read().catch(() => []);

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
        const year    = date.getFullYear();
        const weekKey = `W${weekNum} - ${year}`;

        if (!acc[weekKey]) acc[weekKey] = { week: weekKey, weekNum, cartons: 0, units: 0, warehouses: {} };

        const units = parseInt(isPO ? item.expected_qty : (item.expected_quantity || item.expected_qty || '0'), 10);
        if (units <= 0) return acc;

        const cartons = parseInt(item.number_of_cartons || item.cartons || Math.ceil(units / 20).toString(), 10);
        const wh = item.destination_warehouse || item.receiving_warehouse || 'Unknown';

        acc[weekKey].cartons += cartons;
        acc[weekKey].units   += units;

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
}

module.exports = { getReports, getForecast };
