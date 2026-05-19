'use strict';

const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');

/**
 * Generate a packing list Excel file from a confirmed booking's CI line items.
 *
 * Only matched line items (match_status === 'matched') are included.
 * No financial data (unit_price, total, total_value, invoice_number, invoice_date).
 *
 * @param {object} booking  — full booking record with commercial_invoice
 * @returns {Promise<string>}  file_url like "/uploads/asn_<timestamp>_<bookingNumber>.xlsx"
 */
async function generatePackingList(booking) {
    const ci = booking.commercial_invoice || {};
    const lineItems = (ci.line_items || []).filter(
        item => item.match_status === 'matched'
    );

    // Collect unique PO numbers from the booking's po_details or matched line items
    const poNumbers = [];
    if (Array.isArray(booking.po_details)) {
        booking.po_details.forEach(pd => {
            if (pd.po_number && !poNumbers.includes(pd.po_number)) {
                poNumbers.push(pd.po_number);
            }
        });
    } else {
        lineItems.forEach(item => {
            if (item.matched_po && !poNumbers.includes(item.matched_po)) {
                poNumbers.push(item.matched_po);
            }
        });
    }

    const wb = xlsx.utils.book_new();
    const wsData = [];

    // Row 1: Title header (will be merged across all columns)
    wsData.push(['TENTREE PACKING LIST', '', '', '', '', '', '']);

    // Row 2-5: Metadata block
    wsData.push(['Booking #', booking.booking_number || '', '', '', '', '', '']);
    wsData.push(['Supplier', booking.vendor_name || '', '', '', '', '', '']);
    wsData.push(['Generated Date', new Date().toISOString().split('T')[0], '', '', '', '', '']);
    wsData.push(['PO Numbers', poNumbers.join(', '), '', '', '', '', '']);

    // Row 6: blank separator
    wsData.push(['', '', '', '', '', '', '']);

    // Row 7: Table header
    wsData.push([
        'SKU Code',
        'Description',
        'Quantity',
        'Weight (kg)',
        'CBM',
        'PO Number',
        'Status',
    ]);

    // Rows 8+: Line item data (matched only, no financial fields)
    for (const item of lineItems) {
        wsData.push([
            item.sku_code    || '',
            item.description || '',
            item.qty         ?? 0,
            item.weight_kg   ?? 0,
            item.cbm         ?? 0,
            item.matched_po  || '',
            item.match_status || '',
        ]);
    }

    // Totals row
    const totalQty    = lineItems.reduce((s, i) => s + (Number(i.qty)       || 0), 0);
    const totalWeight = lineItems.reduce((s, i) => s + (Number(i.weight_kg) || 0), 0);
    const totalCbm    = lineItems.reduce((s, i) => s + (Number(i.cbm)       || 0), 0);

    wsData.push([
        'TOTAL',
        '',
        totalQty,
        parseFloat(totalWeight.toFixed(2)),
        parseFloat(totalCbm.toFixed(3)),
        '',
        '',
    ]);

    const ws = xlsx.utils.aoa_to_sheet(wsData);

    // ── Column widths ──────────────────────────────────────────────────────────
    ws['!cols'] = [
        { wch: 22 },  // SKU Code
        { wch: 40 },  // Description
        { wch: 12 },  // Quantity
        { wch: 14 },  // Weight (kg)
        { wch: 10 },  // CBM
        { wch: 18 },  // PO Number
        { wch: 12 },  // Status
    ];

    // ── Merge Row 1 title across all columns (A1:G1) ───────────────────────────
    ws['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
    ];

    xlsx.utils.book_append_sheet(wb, ws, 'Packing List');

    // ── Write to disk ──────────────────────────────────────────────────────────
    const uploadDir = path.join(__dirname, '..', 'data', 'uploads');
    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
    }

    const safeBkgNum = (booking.booking_number || 'UNKNOWN').replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename   = `asn_${Date.now()}_${safeBkgNum}.xlsx`;
    const filepath   = path.join(uploadDir, filename);

    xlsx.writeFile(wb, filepath);

    return `/uploads/${filename}`;
}

module.exports = { generatePackingList };
