'use strict';

// Authenticated, OWNERSHIP-CHECKED file downloads. Mounted at /uploads, replacing
// `express.static`.
//
// Static serving only ever answered "does this filename exist", so once /uploads sat
// behind the auth gate any logged-in account — including a Vendor — could still fetch
// ANY document whose URL it held. Those files are commercial invoices and packing
// lists carrying per-SKU unit prices, i.e. exactly the cross-supplier data the read
// scoping exists to protect. The URL was effectively a bearer token: leaked in a
// pasted link, browser history or a log, it kept working forever and against records
// that were never the holder's.
//
// WHY HERE AND NOT IN THE NEXT PROXY: /api/documents is the only path the UI uses, but
// it is not the only path that exists. A vendor holding their own valid JWT can call
// this API directly, bypassing the frontend entirely. Authorization has to live on the
// server that owns the data.
//
// The ownership RULES are not reimplemented here — each module's own guard is reused
// (modules/mainline/vendorAccess, modules/sms/vendorAccess), so there is one
// definition of "is this booking/shipment yours" and this route just works out which
// record a filename belongs to and asks the right module. That also keeps the
// mainline/SMS separation intact: no cross-module table joins happen in this file.

const express = require('express');
const path = require('path');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const BaseModel = require('../models/BaseModel');
const { resolveVendorSupplierId } = require('../utils/vendorScope');
const mainlineAccess = require('../modules/mainline/vendorAccess');
const smsAccess = require('../modules/sms/vendorAccess');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');

const readM = (f) => new BaseModel(`migrated/${f}.json`).read().catch(() => []);

// Same 404 for "no such file", "not yours" and "can't tell whose it is". Distinct
// codes would let a vendor probe which documents exist for other suppliers.
const notFound = () => { const e = new Error('File not found'); e.statusCode = 404; throw e; };

router.get('/:filename', asyncWrap(async (req, res) => {
    const { filename } = req.params;

    // Serve only a plain filename out of the uploads dir. basename() strips any path
    // segments, and re-comparing rejects traversal instead of silently normalising it.
    if (!filename || filename !== path.basename(filename) || filename.includes('\0')) notFound();

    const fileUrl = `/uploads/${filename}`;
    const [mlDocs, mlAsns, smsDocs] = await Promise.all([
        readM('mainline_documents'),
        readM('mainline_asns'),
        readM('sms_documents'),
    ]);

    // Which record does this file belong to? First match wins; the three namespaces
    // don't overlap (ci_/asn_/sms_ prefixes).
    const mlDoc = mlDocs.find((d) => d.file_url === fileUrl);
    const mlAsn = mlAsns.find((a) => a.file_url === fileUrl);
    const smsDoc = smsDocs.find((d) => d.file_url === fileUrl);

    if (mlDoc) {
        // throws 404 when the caller may not see the parent booking
        await mainlineAccess.assertBookingVisible(req, mlDoc.booking_id, 'File not found');
    } else if (mlAsn) {
        await mainlineAccess.assertShipmentVisible(req, mlAsn.shipment_id, 'File not found');
    } else if (smsDoc) {
        await smsAccess.assertShipmentVisible(req, smsDoc.shipment_id, 'File not found');
    } else {
        // ORPHAN — a file on disk with no owning row (a re-upload replaced the record,
        // or it predates the current tables; ~40 of them). Attribution is impossible,
        // so fail CLOSED for vendors and let staff through. Freight exports
        // (freight_<id>.xlsx) land here too, which is right: only the `freight`
        // permission reaches those records, and no vendor holds it.
        const vendorSid = await resolveVendorSupplierId(req.user, { onUnlinked: 'deny' });
        if (vendorSid != null) notFound();
    }

    // res.download sets Content-Disposition: attachment, so a spreadsheet can never be
    // rendered inline in this origin.
    return res.download(path.join(UPLOAD_DIR, filename), filename, (err) => {
        if (err && !res.headersSent) {
            res.status(404).json({ success: false, error: 'File not found' });
        }
    });
}));

module.exports = router;
