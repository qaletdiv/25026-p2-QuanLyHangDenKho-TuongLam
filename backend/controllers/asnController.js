'use strict';

const crypto = require('crypto');
const BookingModel = require('../models/BookingModel');
const ShipmentModel = require('../models/ShipmentModel');
const AsnModel = require('../models/AsnModel');
const { generatePackingList } = require('../services/asnService');

/**
 * POST /bookings/:id/asn
 *
 * Generate a packing list Excel for the booking and save an ASN record.
 * The booking must have a confirmed commercial_invoice (status === 'confirmed').
 * Multiple calls are idempotent in the sense that each call produces a new ASN
 * record and a new file (allowing regeneration after CI edits).
 */
async function generateAsn(req, res) {
    const bookings = await BookingModel.read();
    let booking = bookings.find(b => b.id === req.params.id || b.booking_number === req.params.id);

    // Active bookings are swept to history after processing — fall back to history-bookings
    if (!booking) {
        const { historyBookings } = require('../models/HistoryModel');
        const historyData = await historyBookings.read();
        booking = historyData.find(b => b.id === req.params.id || b.booking_number === req.params.id);
    }

    if (!booking) {
        const err = new Error('Booking not found');
        err.statusCode = 404;
        throw err;
    }

    const ci = booking.commercial_invoice;
    if (!ci || ci.status !== 'confirmed') {
        const err = new Error(
            'Cannot generate ASN: booking does not have a confirmed commercial invoice'
        );
        err.statusCode = 400;
        throw err;
    }

    // Generate the packing list Excel and get its URL
    const file_url = await generatePackingList(booking);

    const now = new Date().toISOString();

    // Collect PO numbers from the booking
    const poNumbers = Array.isArray(booking.po_details)
        ? booking.po_details.map(pd => pd.po_number).filter(Boolean)
        : [];

    const asnRecord = {
        id:                  crypto.randomUUID(),
        booking_id:          booking.id,
        booking_number:      booking.booking_number || null,
        tentree_po_number:   booking.tentree_po_number || (poNumbers[0] || null),
        po_numbers:          poNumbers,
        supplier:            booking.vendor_name || null,
        file_url,
        generated_at:        now,
        status:              'sent',
    };

    const asns = await AsnModel.read();
    asns.push(asnRecord);
    await AsnModel.write(asns);

    // Mark linked shipment rows as ASN sent — check both active and history tables
    if (booking.booking_number) {
        const shipments = await ShipmentModel.read();
        const updatedShipments = shipments.map(s =>
            s.booking_number === booking.booking_number
                ? { ...s, asn_sent: true, asn_file_url: file_url }
                : s
        );
        await ShipmentModel.write(updatedShipments);

        // Shipments may have been swept to history — update history.json too
        const { history } = require('../models/HistoryModel');
        const historyShipments = await history.read();
        const updatedHistory = historyShipments.map(s =>
            s.booking_number === booking.booking_number
                ? { ...s, asn_sent: true, asn_file_url: file_url }
                : s
        );
        await history.write(updatedHistory);
    }

    res.status(201).json({
        id:             asnRecord.id,
        booking_id:     asnRecord.booking_id,
        booking_number: asnRecord.booking_number,
        file_url:       asnRecord.file_url,
        generated_at:   asnRecord.generated_at,
    });
}

/**
 * GET /bookings/:id/asn
 *
 * Return the most recently generated ASN record for the given booking,
 * or 404 if no ASN has been generated yet.
 */
async function getAsn(req, res) {
    const asns = await AsnModel.read();

    // Return the latest ASN for this booking (last one generated)
    const bookingAsns = asns.filter(a => a.booking_id === req.params.id || a.booking_number === req.params.id);

    if (bookingAsns.length === 0) {
        const err = new Error('No ASN found for this booking');
        err.statusCode = 404;
        throw err;
    }

    // Return the most recently generated ASN
    const latest = bookingAsns[bookingAsns.length - 1];
    res.json(latest);
}

module.exports = { generateAsn, getAsn };
