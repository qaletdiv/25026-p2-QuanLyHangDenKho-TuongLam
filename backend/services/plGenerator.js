'use strict';

const ExcelJS = require('exceljs');

// Multi-line addresses — one line per ROW, see the long note in ciGenerator.js.
// Same reason: these fields run to eight lines in live data, and a single cell
// showed only the first.
const splitLines = (v) => String(v ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/** Write `lines` down one column, a row each. @returns the first row AFTER them. */
function writeLines(ws, col, startRow, lines) {
    lines.forEach((line, i) => { ws.getCell(`${col}${startRow + i}`).value = line; });
    return startRow + lines.length;
}

/** Medium rule around a rectangle, interior untouched — see ciGenerator.outline. */
function outline(ws, top, left, bottom, right, style = 'medium') {
    for (let r = top; r <= bottom; r++) {
        for (let c = left; c <= right; c++) {
            if (r !== top && r !== bottom && c !== left && c !== right) continue;
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
 * Generate a formatted Packing List Excel workbook.
 *
 * Rows are grouped by carton number — shared columns (CTN#, N/W, G/W, MEASURE)
 * are merged vertically within each carton group.
 *
 * @param {{ rows: object[], summary: object }} shipmentData — parsed upload
 * @param {object} meta — PO / supplier / warehouse metadata
 * @returns {Promise<Buffer>}
 */
async function generatePL(shipmentData, meta) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Packing List');

    // ── Carton table columns ─────────────────────────────────────────────
    // Declared FIRST because the sheet's right edge derives from them: the info
    // block sits in the last two, the banner spans all of them, and the medium
    // rule goes down the last one. Add a column here and everything follows.
    const colHeaders = [
        'CTN#', 'PO#', 'SKU#', 'UPC', 'Style Description',
        'Color Description', 'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
    ];
    const LAST_COL = colHeaders.length;        // J — the sheet's right edge
    const INFO_LABEL_COL = LAST_COL - 1;       // I

    //  A=10  B=18  C=16  D=16  E=25  F=22  G=10  H=12  I=18  J=18
    //  I is wider than "G/W (KGS)" needs because it now also carries the info
    //  block's labels ("Port of Discharge" is 17 characters).
    ws.columns = [
        { width: 10 }, { width: 18 }, { width: 16 }, { width: 16 }, { width: 25 },
        { width: 22 }, { width: 10 }, { width: 12 }, { width: 18 }, { width: 18 },
    ];

    const bold = { bold: true };
    const borderThin = {
        top: { style: 'thin' }, bottom: { style: 'thin' },
        left: { style: 'thin' }, right: { style: 'thin' },
    };

    // ── Header section (rows 1-10) ───────────────────────────────────────
    ws.getCell('A1').value = meta.vendor_name || '';
    ws.getCell('A1').font = { bold: true, size: 12 };

    // Left column grows with the address; the H/I label stack (rows 2-9) is a
    // separate column and stays where it is.
    const afterAddr = writeLines(ws, 'A', 2, splitLines(meta.vendor_address));
    const contactRow = Math.max(3, afterAddr);
    ws.getCell(`A${contactRow}`).value = meta.vendor_contact || '';

    // Label stack: the LAST TWO COLUMNS, contiguous from row 1, so the block's
    // right edge is the carton table's right edge. Its own column group, so the
    // left-hand address block grows past it without disturbing it.
    const labels = [
        ['PO #',              meta.poNumber],
        ['Invoice #',         meta.invoiceNumber],
        ['Date',              meta.date || new Date().toISOString().slice(0, 10)],
        ['Shipping Mode',     meta.shipping_mode],
        ['Shipment #',        meta.shipmentNumber],
        ['Port of Loading',   meta.portOfLoading],
        ['Port of Discharge', meta.portOfDischarge],
        ['Country of Origin', meta.country_of_origin],
    ];
    labels.forEach(([label, value], i) => {
        const r = i + 1;
        const labelCell = ws.getCell(r, INFO_LABEL_COL);
        labelCell.value = label;
        labelCell.font = bold;
        ws.getCell(r, LAST_COL).value = value || '';
    });
    const labelsEnd = labels.length;

    // Banner clears both the left column and the H/I labels, centred across the
    // sheet's full width (A:J, every carton column).
    const titleRow = Math.max(labelsEnd + 2, contactRow + 2);
    ws.mergeCells(titleRow, 1, titleRow, LAST_COL);
    ws.getCell(`A${titleRow}`).value = 'Packing List';
    ws.getCell(`A${titleRow}`).font = { bold: true, size: 14 };
    ws.getCell(`A${titleRow}`).alignment = { horizontal: 'center', vertical: 'middle' };

    // ── Consignee / Notify Party ─────────────────────────────────────────
    // The packing list travels with the goods and is read at the destination, so
    // it needs the same two blocks as the CI (added 2026-09-16). Same columns, same
    // one-line-per-row layout, so the two documents read identically.
    const labelRow = titleRow + 2;
    ws.getCell(`A${labelRow}`).value = 'Consignee';    ws.getCell(`A${labelRow}`).font = bold;
    ws.getCell(`D${labelRow}`).value = 'Notify Party'; ws.getCell(`D${labelRow}`).font = bold;

    const blockRow = labelRow + 1;
    const conLines = [...splitLines(meta.consignee_name), ...splitLines(meta.consignee_address)];
    const notifyLines = [...splitLines(meta.notify_party_name), ...splitLines(meta.notify_party_address)];
    writeLines(ws, 'A', blockRow, conLines);
    writeLines(ws, 'D', blockRow, notifyLines);

    // ── Column headers — directly under the taller block ─────────────────
    const headerRowNum = blockRow + Math.max(conLines.length, notifyLines.length) + 1;
    const headerRow = ws.getRow(headerRowNum);
    colHeaders.forEach((h, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = h;
        cell.font = bold;
        cell.border = borderThin;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
    });

    // ── Group rows by carton (preserve order) ────────────────────────────
    // Group on `_group_key` (po#ctn) when present so two POs that both number
    // cartons from #1 stay separate; falls back to ctnNumber (single-PO / SMS).
    const cartonGroups = new Map();
    for (const r of shipmentData.rows) {
        const key = r._group_key ?? r.ctnNumber;
        if (!cartonGroups.has(key)) {
            cartonGroups.set(key, []);
        }
        cartonGroups.get(key).push(r);
    }

    // Sort carton groups by carton number ascending (by the group's own ctn number)
    const sortedCartons = [...cartonGroups.entries()].sort((a, b) => a[1][0].ctnNumber - b[1][0].ctnNumber);

    // ── Data rows (immediately under the header) ─────────────────────────
    let dataRow = headerRowNum + 1;
    let totalPcs = 0;
    let totalNetWeight = 0;
    let totalGrossWeight = 0;
    let totalCartons = 0;

    for (const [, rows] of sortedCartons) {
        const ctnNum = rows[0].ctnNumber;   // displayed carton number (group key may be po#ctn)
        const startRow = dataRow;
        const groupSize = rows.length;
        totalCartons++;

        // Per-carton weight/measure from first row in group
        const nw = rows[0].netWeightKgs || 0;
        const gw = rows[0].grossWeightKgs || 0;
        const measure = rows[0].measureCm || '';

        totalNetWeight += nw;
        totalGrossWeight += gw;

        for (let ri = 0; ri < groupSize; ri++) {
            const r = rows[ri];
            const row = ws.getRow(dataRow);

            row.getCell(1).value = ctnNum;                     // CTN#
            row.getCell(2).value = r.poNumber || '';           // PO#
            row.getCell(3).value = r.sku;                       // SKU#
            row.getCell(4).value = r.upc || '';                 // UPC
            row.getCell(5).value = r.style_description || '';   // Style Description
            row.getCell(6).value = r.color_description || '';   // Color Description
            row.getCell(7).value = r.pcsPerCtn;              // PCS/CTN

            // Weight/Measure only on first row (will be merged)
            if (ri === 0) {
                row.getCell(8).value = nw;                     // N/W
                row.getCell(9).value = gw;                     // G/W
                row.getCell(10).value = measure;               // MEASURE
            }

            // Borders for all cells
            for (let c = 1; c <= 10; c++) {
                row.getCell(c).border = borderThin;
            }

            totalPcs += r.pcsPerCtn;
            dataRow++;
        }

        // Merge carton-level cells vertically if more than one row in group
        if (groupSize > 1) {
            const endRow = startRow + groupSize - 1;
            ws.mergeCells(startRow, 1, endRow, 1);   // CTN#
            ws.mergeCells(startRow, 8, endRow, 8);   // N/W
            ws.mergeCells(startRow, 9, endRow, 9);   // G/W
            ws.mergeCells(startRow, 10, endRow, 10); // MEASURE

            // Vertical alignment for merged cells
            for (const col of [1, 8, 9, 10]) {
                ws.getCell(startRow, col).alignment = { vertical: 'middle' };
            }
        }

        // Number formatting for weight cells
        ws.getCell(startRow, 8).numFmt = '#,##0.00';
        ws.getCell(startRow, 9).numFmt = '#,##0.00';
    }

    // ── Totals row ───────────────────────────────────────────────────────
    dataRow++; // blank row
    const totalsRow = dataRow;
    const totRow = ws.getRow(dataRow);

    totRow.getCell(1).value = 'TOTAL';
    totRow.getCell(1).font = bold;
    totRow.getCell(1).border = borderThin;

    totRow.getCell(6).value = `${totalCartons} Cartons`;
    totRow.getCell(6).font = bold;
    totRow.getCell(6).border = borderThin;

    totRow.getCell(7).value = totalPcs;
    totRow.getCell(7).font = bold;
    totRow.getCell(7).border = borderThin;

    totRow.getCell(8).value = parseFloat(totalNetWeight.toFixed(2));
    totRow.getCell(8).font = bold;
    totRow.getCell(8).numFmt = '#,##0.00';
    totRow.getCell(8).border = borderThin;

    totRow.getCell(9).value = parseFloat(totalGrossWeight.toFixed(2));
    totRow.getCell(9).font = bold;
    totRow.getCell(9).numFmt = '#,##0.00';
    totRow.getCell(9).border = borderThin;

    // ── CBM summary ──────────────────────────────────────────────────────
    dataRow += 2;
    ws.getCell(`A${dataRow}`).value = 'Total CBM:';
    ws.getCell(`A${dataRow}`).font = bold;
    ws.getCell(`B${dataRow}`).value = shipmentData.summary.totalCbm;
    ws.getCell(`B${dataRow}`).numFmt = '#,##0.000';

    // ── Signature block ──────────────────────────────────────────────────
    dataRow += 4;
    ws.getCell(`G${dataRow}`).value = 'Seller Full Company Name and Address:';
    ws.getCell(`G${dataRow + 1}`).value = (meta.vendor_name || '').toUpperCase();
    const sigEnd = writeLines(ws, 'G', dataRow + 2,
        splitLines(meta.vendor_address).map((l) => l.toUpperCase()));
    // Clears the address block instead of a fixed 5 rows down, which a multi-line
    // address would have overwritten.
    const lastRow = Math.max(dataRow + 5, sigEnd + 2);
    ws.getCell(`G${lastRow}`).value = '(Authorized Signature/ Company Mark)';

    // ── Frame ────────────────────────────────────────────────────────────
    // Drawn LAST, once every row position is known — see ciGenerator for why.
    // Banner and the Consignee / Notify Party block are deliberately UNBOXED — see
    // the same note in ciGenerator.
    outline(ws, 1, INFO_LABEL_COL, labelsEnd, LAST_COL);          // info block
    outline(ws, 1, 1, labelsEnd, INFO_LABEL_COL - 1);             // seller
    outline(ws, headerRowNum, 1, totalsRow, LAST_COL);            // carton table
    outline(ws, 1, 1, lastRow, LAST_COL);                         // the form itself

    return wb.xlsx.writeBuffer();
}

module.exports = { generatePL };
