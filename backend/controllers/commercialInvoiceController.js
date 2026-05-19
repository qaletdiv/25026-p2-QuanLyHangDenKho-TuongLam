const stream = require('stream');
const ciParser = require('../services/ciParser');
const PurchaseOrderModel = require('../models/PurchaseOrderModel');
const driveStorage = require('../driveStorage');

async function parse(req, res) {
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
        const pos = await PurchaseOrderModel.read().catch(() => []);
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
                weight_kg:   parseFloat(matchedItems.reduce((sum, i) => sum + (i.weight_kg || 0), 0).toFixed(2)),
                cbm:         parseFloat(matchedItems.reduce((sum, i) => sum + (i.cbm || 0), 0).toFixed(3))
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

    // Save the original Excel file so it can be downloaded later
    let file_url = null;
    try {
        const timestamp = Date.now();
        const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `ci_${timestamp}_${safeName}`;
        const bufferStream = new stream.PassThrough();
        bufferStream.end(req.file.buffer);
        const uploaded = await driveStorage.uploadFile(filename, bufferStream, req.file.mimetype);
        file_url = uploaded.url;
    } catch (e) {
        // Non-fatal — parsed data is still returned; file just won't be downloadable
        console.error('CI file upload failed (non-fatal):', e.message);
    }

    res.json({ header, poSummary: recalculatedPoSummary, lineItems: enriched, summary, file_url });
}

module.exports = { parse };
