'use strict';

const ExcelJS = require('exceljs');

// ---------------------------------------------------------------------------
//  Multi-line address blocks — ONE LINE PER ROW
//
//  These fields are free text and genuinely long: a consignee block carries the
//  street address, a contact name, a phone, an email, a carrier-appointment
//  address and an EIN — eight lines in live data. The original layout wrote
//  addrLines[0] and [1] into two fixed cells and spread the consignee over
//  exactly four rows, so everything past line 2 (or 4) was DROPPED, silently and
//  on a customs document.
//
//  Each line now gets its own Excel row, so the cells are ordinary cells: you can
//  click one, edit it, copy a column. The cost is that nothing below a block can
//  sit at a fixed row any more — the layout is computed downward from the blocks
//  (see the `Math.max(originalRow, …)` anchors). Those maxes keep a short address
//  looking EXACTLY as it did before: with one-line addresses the sheet still has
//  its banner on row 12, its consignee label on 14 and its item table on 21.
// ---------------------------------------------------------------------------
const splitLines = (v) => String(v ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/**
 * Write `lines` down one column, a row each.
 * @returns {number} the first row AFTER the block
 */
function writeLines(ws, col, startRow, lines) {
    lines.forEach((line, i) => { ws.getCell(`${col}${startRow + i}`).value = line; });
    return startRow + lines.length;
}

/**
 * Draw a MEDIUM rule around a rectangle, leaving whatever is inside alone.
 *
 * The form is a set of boxes — header, info block, parties, item table — inside one
 * outer box. Without them the sheet is a grid of values that stops wherever the data
 * happens to stop, and it does not read as a document. Each edge is merged into the
 * cell's existing border, so the thin cell grid inside the item table survives.
 */
function outline(ws, top, left, bottom, right, style = 'medium') {
    for (let r = top; r <= bottom; r++) {
        for (let c = left; c <= right; c++) {
            if (r !== top && r !== bottom && c !== left && c !== right) continue;   // interior
            const cell = ws.getCell(r, c);
            const b = { ...(cell.border || {}) };
            if (r === top) b.top = { style };
            if (r === bottom) b.bottom = { style };
            if (c === left) b.left = { style };
            if (c === right) b.right = { style };
            cell.border = b;
        }
    }
}

/**
 * Generate a formatted Commercial Invoice Excel workbook.
 *
 * @param {{ rows: object[], summary: object }} shipmentData — parsed upload
 * @param {object} meta — PO / supplier / warehouse metadata
 * @returns {Promise<Buffer>}
 */
async function generateCI(shipmentData, meta) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Commercial Invoice');

    // ── Item table columns ───────────────────────────────────────────────
    // Declared FIRST because the sheet's whole right edge is derived from them:
    // the info block sits in the last two, the banner spans all of them, and the
    // medium rule goes down the last one. Add a column here and everything follows.
    const colHeaders = [
        'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
        'Category', 'Gender', 'Composition', 'HTS Code', 'Quantity',
        'Unit Price USD', 'Total USD',
    ];
    const LAST_COL = colHeaders.length;        // M — the sheet's right edge
    const INFO_LABEL_COL = LAST_COL - 1;       // L

    //  A=12  B=22  C=16  D=12  E=25  F=28  G=12  H=10  I=35  J=16  K=10  L=18  M=18
    //  L and M are wider than a money column needs because they now also carry the
    //  info block ("Port of Discharge" is 17 characters).
    ws.columns = [
        { width: 12 }, { width: 22 }, { width: 16 }, { width: 12 }, { width: 25 },
        { width: 28 }, { width: 12 }, { width: 10 }, { width: 35 }, { width: 16 },
        { width: 10 }, { width: 18 }, { width: 18 },
    ];

    const bold = { bold: true };
    const borderThin = {
        top: { style: 'thin' }, bottom: { style: 'thin' },
        left: { style: 'thin' }, right: { style: 'thin' },
    };

    // ── Header section ───────────────────────────────────────────────────
    ws.getCell('A1').value = meta.vendor_name || '';
    ws.getCell('A1').font = { bold: true, size: 12 };

    // The RIGHT-hand label stack: the LAST TWO COLUMNS, contiguous from row 1, so
    // the block's right edge is the table's right edge. A separate column group
    // from the seller block on the left, so a long address grows the left column
    // past it without disturbing it. Country of Origin lives here too, which is
    // what frees the banner row below to be centred across the full width.
    const labels = [
        ['PO #',              meta.po_number],
        ['Invoice #',         meta.invoice_number],
        ['Date',              meta.date || new Date().toISOString().slice(0, 10)],
        ['Shipping Mode',     meta.shipping_mode],
        ['Shipment #',        meta.shipment_number],
        ['ETA Date',          meta.eta_date],
        ['Port of Loading',   meta.port_of_loading],
        ['Port of Discharge', meta.port_of_discharge],
        ['Country of Origin', meta.country_of_origin],
        ['Remarks',           meta.remarks],
    ];
    labels.forEach(([label, value], i) => {
        const r = i + 1;
        const labelCell = ws.getCell(r, INFO_LABEL_COL);
        labelCell.value = label;
        labelCell.font = bold;
        ws.getCell(r, LAST_COL).value = value || '';
    });
    const labelsEnd = labels.length;

    // ── LEFT column: seller, then manufacturer — one address line per ROW ──
    let after = writeLines(ws, 'A', 2, splitLines(meta.vendor_address));
    const contactRow = Math.max(3, after);
    ws.getCell(`A${contactRow}`).value = meta.vendor_contact || '';

    // Manufacturer is its OWN field on the supplier now — the factory that made the
    // goods is not always the company on the invoice (an agent may be). Falls back
    // to the vendor when the supplier has no separate manufacturer recorded, which
    // is what this line always showed before.
    const mfrNameRow = Math.max(6, contactRow + 2);
    ws.getCell(`A${mfrNameRow}`).value = 'Manufacturer Name: ' + (meta.manufacturer_name || meta.vendor_name || '');
    const mfrAddr = splitLines(meta.manufacturer_address || meta.vendor_address);
    after = writeLines(ws, 'A', mfrNameRow + 1,
        mfrAddr.map((l, i) => (i === 0 ? 'Manufacturer address: ' + l : l)));
    const contact2Row = Math.max(9, after);
    ws.getCell(`A${contact2Row}`).value = meta.vendor_contact || '';

    // The banner has to clear BOTH stacks — the left column above and the I/J
    // labels. Centred across the sheet's full width (A:M, every item column), which
    // it could not be while Country of Origin sat on this row.
    const titleRow = Math.max(labelsEnd + 2, contact2Row + 2);
    ws.mergeCells(titleRow, 1, titleRow, LAST_COL);
    ws.getCell(`A${titleRow}`).value = 'Commercial Invoice';
    ws.getCell(`A${titleRow}`).font = { bold: true, size: 14 };
    ws.getCell(`A${titleRow}`).alignment = { horizontal: 'center', vertical: 'middle' };

    // ── Consignee / Notify Party — side by side, one line per row ────────
    const labelRow = titleRow + 2;                       // 14 by default
    ws.getCell(`A${labelRow}`).value = 'Consignee';    ws.getCell(`A${labelRow}`).font = bold;
    ws.getCell(`D${labelRow}`).value = 'Notify Party'; ws.getCell(`D${labelRow}`).font = bold;

    const blockRow = labelRow + 1;                       // 15 by default
    const conLines = [...splitLines(meta.consignee_name), ...splitLines(meta.consignee_address)];
    const notifyLines = [...splitLines(meta.notify_party_name), ...splitLines(meta.notify_party_address)];
    writeLines(ws, 'A', blockRow, conLines);
    writeLines(ws, 'D', blockRow, notifyLines);

    // ── Column headers ───────────────────────────────────────────────────
    // Directly under the TALLER of the two blocks, one blank row between. No fixed
    // floor: the table follows the consignee rather than leaving a gap to reach a
    // row number that stopped meaning anything once the blocks grew.
    const headerRow = blockRow + Math.max(conLines.length, notifyLines.length) + 1;
    const headerRowRef = ws.getRow(headerRow);
    colHeaders.forEach((h, i) => {
        const cell = headerRowRef.getCell(i + 1);
        cell.value = h;
        cell.font = bold;
        cell.border = borderThin;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
    });

    // ── Aggregate rows by PO + SKU ───────────────────────────────────────
    // Key by po_number too: a consolidated booking can carry the same style-color
    // SKU under multiple POs, and those must stay as separate CI line items
    // (keying by SKU alone would collapse them and drop a PO from the invoice).
    const skuMap = new Map();
    for (const r of shipmentData.rows) {
        const key = `${r.po_number || ''}||${r.sku}`;
        if (skuMap.has(key)) {
            skuMap.get(key).qty += r.pcs_per_ctn;
        } else {
            skuMap.set(key, { ...r, qty: r.pcs_per_ctn });
        }
    }

    // Sort by PO, then SKU
    const skuRows = [...skuMap.values()].sort((a, b) =>
        (a.po_number || '').localeCompare(b.po_number || '') ||
        a.sku.localeCompare(b.sku)
    );

    // ── Data rows (immediately under the header) ─────────────────────────
    let dataRow = headerRow + 1;
    let totalQty = 0;
    let totalValue = 0;

    for (const s of skuRows) {
        const lineTotal = parseFloat((s.qty * s.unit_price).toFixed(2));
        const values = [
            s.po_number, s.sku, s.upc || '', s.knit_woven || '',
            s.style_description || '', s.color_description || '',
            s.category || '', s.gender || '', s.composition || '',
            s.hts_code || '', s.qty, s.unit_price, lineTotal,
        ];
        const row = ws.getRow(dataRow);
        values.forEach((v, i) => {
            const cell = row.getCell(i + 1);
            cell.value = v;
            cell.border = borderThin;
        });
        // Number formatting
        row.getCell(12).numFmt = '#,##0.00';
        row.getCell(13).numFmt = '$#,##0.00';

        totalQty += s.qty;
        totalValue += lineTotal;
        dataRow++;
    }

    // ── Totals row ───────────────────────────────────────────────────────
    dataRow++; // blank row
    const totalsRow = dataRow;
    const totRow = ws.getRow(dataRow);
    totRow.getCell(11).value = totalQty;
    totRow.getCell(11).font = bold;
    totRow.getCell(11).border = borderThin;
    totRow.getCell(13).value = parseFloat(totalValue.toFixed(2));
    totRow.getCell(13).font = bold;
    totRow.getCell(13).numFmt = '$#,##0.00';
    totRow.getCell(13).border = borderThin;

    // ── Say in words ─────────────────────────────────────────────────────
    dataRow += 2;
    ws.getCell(`A${dataRow}`).value =
        `Say In Words Total US Dollars: ${numberToWords(totalValue)}`;

    // ── Additional Remarks ───────────────────────────────────────────────
    dataRow += 3;
    ws.getCell(`A${dataRow}`).value = 'Additional Remarks';
    ws.getCell(`A${dataRow}`).font = bold;

    // ── Signature block ──────────────────────────────────────────────────
    dataRow += 5;
    ws.getCell(`H${dataRow}`).value = 'Seller Full Company Name and Address:';
    ws.getCell(`H${dataRow + 1}`).value = (meta.vendor_name || '').toUpperCase();
    const sigEnd = writeLines(ws, 'H', dataRow + 2,
        splitLines(meta.vendor_address).map((l) => l.toUpperCase()));
    // Signature line clears the address block rather than sitting a fixed 6 rows
    // down, which a multi-line address would have overwritten.
    const lastRow = Math.max(dataRow + 6, sigEnd + 3);
    ws.getCell(`H${lastRow}`).value = '(Authorized Signature/ Company Mark)';

    // ── Frame ────────────────────────────────────────────────────────────
    // Drawn LAST, once every row position is known. Section boxes first, then the
    // outer box, so the outer edge wins wherever the two meet.
    // The banner and the Consignee / Notify Party block are deliberately UNBOXED
    // (per Lam, 2026-09-16) — boxing every section made the sheet busy; the outer
    // frame plus the two data boxes is enough structure.
    outline(ws, 1, INFO_LABEL_COL, labelsEnd, LAST_COL);          // info block
    outline(ws, 1, 1, labelsEnd, INFO_LABEL_COL - 1);             // seller / manufacturer
    outline(ws, headerRow, 1, totalsRow, LAST_COL);               // item table
    outline(ws, 1, 1, lastRow, LAST_COL);                         // the form itself

    return wb.xlsx.writeBuffer();
}

/**
 * Simple number-to-words for USD amounts.
 */
function numberToWords(amount) {
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
        'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
        'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    function convert(n) {
        if (n === 0) return '';
        if (n < 20) return ones[n];
        if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
        if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' and ' + convert(n % 100) : '');
        if (n < 1000000) return convert(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + convert(n % 1000) : '');
        return convert(Math.floor(n / 1000000)) + ' Million' + (n % 1000000 ? ' ' + convert(n % 1000000) : '');
    }

    const dollars = Math.floor(amount);
    const cents = Math.round((amount - dollars) * 100);
    const dollarWords = dollars === 0 ? 'Zero' : convert(dollars);
    return `${dollarWords} and Cents ${cents < 10 ? '0' : ''}${cents} only.`;
}

module.exports = { generateCI };
