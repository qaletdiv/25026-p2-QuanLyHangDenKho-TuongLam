// LEGACY-DATA CONSUMER (kept for /forecast only). The legacy transactional stack
// was deleted at the SMS cutover (2026-07-03); purchase-orders.json is a FROZEN
// snapshot and the other files no longer exist (reads degrade to []). The
// forecast page needs a rebuild on the mainline (migrated/*) + SMS (sms_*)
// datasets — until then it charts the frozen PO snapshot only.
const BaseModel = require('../models/BaseModel');
const ShipmentModel        = new BaseModel('shipments.json');
const PurchaseOrderModel   = new BaseModel('purchase-orders.json');
const BookingModel         = new BaseModel('bookings.json');
const HistoryModel         = new BaseModel('history.json');
const HistoryBookingModel  = new BaseModel('history-bookings.json');

async function getReports(req, res) {
    const activeShipments   = await ShipmentModel.read().catch(() => []);
    const historyShipments  = await HistoryModel.read().catch(() => []);
    const shipments = [...activeShipments, ...historyShipments];
    const pos = await PurchaseOrderModel.read().catch(() => []);

    const reports = shipments.map(s => {
        const po = (s.po_id ? pos.find(p => p.id === s.po_id) : pos.find(p => p.po_number === s.po_number)) || {};
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
            eta: s.etd_pol || po.etd_pol || '',
            lot_number: s.lot_number || null
        };
    });
    res.json(reports);
}

async function getForecast(req, res) {
    const activeShipments = await ShipmentModel.read().catch(() => []);
    const pos             = await PurchaseOrderModel.read().catch(() => []);

    // CONFIRMED cartons come only from the uploaded packing list (booking.shipment_data),
    // counted as distinct cartons per PO — NOT from the booking/shipment estimate field.
    // Map: booking_number -> { po_number -> confirmed carton count }.
    const bookings        = await BookingModel.read().catch(() => []);
    const historyBookings = await HistoryBookingModel.read().catch(() => []);
    const confirmedCartons = {};
    for (const b of [...bookings, ...historyBookings]) {
        const rows = b.shipment_data?.rows;
        if (!b.booking_number || !Array.isArray(rows)) continue;
        const perPo = {};
        for (const r of rows) {
            if (!r.po_number) continue;
            (perPo[r.po_number] = perPo[r.po_number] || new Set()).add(r.ctn_number);
        }
        confirmedCartons[b.booking_number] = Object.fromEntries(
            Object.entries(perPo).map(([po, set]) => [po, set.size])
        );
    }
    // A (booking, po) packing list is assigned to one shipment row only, so splitting
    // a PO into lots doesn't multiply its confirmed cartons.
    const cartonsAssigned = new Set();

    // Helper for ISO week number
    const getWeekNumber = (d) => {
        d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    };

    const processItem = (acc, item, isPO = false) => {
        if (!isPO && item.status === 'Delivered') return acc;

        const date = new Date(item.etd_pol || item.e_del || '');
        if (isNaN(date.getTime())) return acc;

        const weekNum = getWeekNumber(date);
        const year    = date.getFullYear();
        const weekKey = `W${weekNum} - ${year}`;

        if (!acc[weekKey]) acc[weekKey] = { week: weekKey, weekNum, cartons: 0, units: 0, warehouses: {} };

        const units = parseInt(isPO ? item.expected_qty : (item.expected_quantity || item.expected_qty || '0'), 10);
        if (units <= 0) return acc;

        // Cartons are CONFIRMED only by the uploaded packing list. An unbooked PO
        // line has none; a shipment row uses its packing-list count (0 until one is
        // uploaded). The shipment/booking number_of_cartons (an estimate) is ignored.
        let cartons = 0;
        if (!isPO) {
            const key = `${item.booking_number}|${item.po_number}`;
            const conf = confirmedCartons[item.booking_number]?.[item.po_number];
            if (conf != null && !cartonsAssigned.has(key)) {
                cartons = conf;
                cartonsAssigned.add(key);
            }
        }
        const wh = item.destination_warehouse || item.receiving_warehouse || 'Unknown';

        acc[weekKey].cartons += cartons;
        acc[weekKey].units   += units;

        // Per-warehouse breakdown carries BOTH units and cartons (dynamic set of warehouses)
        if (!acc[weekKey].warehouses[wh]) acc[weekKey].warehouses[wh] = { units: 0, cartons: 0 };
        acc[weekKey].warehouses[wh].units   += units;
        acc[weekKey].warehouses[wh].cartons += cartons;

        return acc;
    };

    let forecast = activeShipments.reduce((acc, s) => processItem(acc, s, false), {});

    // Add unassigned POs
    pos.forEach(po => {
        const linked = activeShipments.filter(s =>
            s.po_id === po.id || (!s.po_id && s.po_number === po.po_number)
        );
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
