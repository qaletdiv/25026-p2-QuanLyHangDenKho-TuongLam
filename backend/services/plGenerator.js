'use strict';

const ExcelJS = require('exceljs');

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

    // ── Column widths ────────────────────────────────────────────────────
    //  A=10  B=18  C=16  D=16  E=25  F=22  G=10  H=12  I=12  J=18
    ws.columns = [
        { width: 10 }, { width: 18 }, { width: 16 }, { width: 16 }, { width: 25 },
        { width: 22 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 18 },
    ];

    const bold = { bold: true };
    const borderThin = {
        top: { style: 'thin' }, bottom: { style: 'thin' },
        left: { style: 'thin' }, right: { style: 'thin' },
    };

    // ── Header section (rows 1-10) ───────────────────────────────────────
    ws.getCell('A1').value = meta.vendor_name || '';
    ws.getCell('A1').font = { bold: true, size: 12 };

    ws.getCell('A2').value = meta.vendor_address || '';
    ws.getCell('H2').value = 'PO #';        ws.getCell('H2').font = bold;
    ws.getCell('I2').value = meta.po_number || '';

    ws.getCell('A3').value = meta.vendor_contact || '';
    ws.getCell('H3').value = 'Invoice #';   ws.getCell('H3').font = bold;
    ws.getCell('I3').value = meta.invoice_number || '';

    ws.getCell('H4').value = 'Date';        ws.getCell('H4').font = bold;
    ws.getCell('I4').value = meta.date || new Date().toISOString().slice(0, 10);

    ws.getCell('H5').value = 'Shipping Mode'; ws.getCell('H5').font = bold;
    ws.getCell('I5').value = meta.shipping_mode || '';

    ws.getCell('H6').value = 'Shipment #';   ws.getCell('H6').font = bold;
    ws.getCell('I6').value = meta.shipment_number || '';

    ws.getCell('H7').value = 'Port of Loading'; ws.getCell('H7').font = bold;
    ws.getCell('I7').value = meta.port_of_loading || '';

    ws.getCell('H8').value = 'Port of Discharge'; ws.getCell('H8').font = bold;
    ws.getCell('I8').value = meta.port_of_discharge || '';

    ws.getCell('H9').value = 'Country of Origin'; ws.getCell('H9').font = bold;
    ws.getCell('I9').value = meta.country_of_origin || '';

    ws.mergeCells('A10:G10');
    ws.getCell('A10').value = 'Packing List';
    ws.getCell('A10').font = { bold: true, size: 13 };

    // ── Column headers (row 12) ──────────────────────────────────────────
    const colHeaders = [
        'CTN#', 'PO#', 'SKU#', 'UPC', 'Style Description',
        'Color Description', 'PCS/CTN', 'N/W (KGS)', 'G/W (KGS)', 'MEASURE (CM)',
    ];
    const headerRow = ws.getRow(12);
    colHeaders.forEach((h, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = h;
        cell.font = bold;
        cell.border = borderThin;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
    });

    // ── Group rows by carton (preserve order) ────────────────────────────
    // Group on `_group_key` (po#ctn) when present so two POs that both number
    // cartons from #1 stay separate; falls back to ctn_number (single-PO / SMS).
    const cartonGroups = new Map();
    for (const r of shipmentData.rows) {
        const key = r._group_key ?? r.ctn_number;
        if (!cartonGroups.has(key)) {
            cartonGroups.set(key, []);
        }
        cartonGroups.get(key).push(r);
    }

    // Sort carton groups by carton number ascending (by the group's own ctn number)
    const sortedCartons = [...cartonGroups.entries()].sort((a, b) => a[1][0].ctn_number - b[1][0].ctn_number);

    // ── Data rows (row 13+) ──────────────────────────────────────────────
    let dataRow = 13;
    let totalPcs = 0;
    let totalNetWeight = 0;
    let totalGrossWeight = 0;
    let totalCartons = 0;

    for (const [, rows] of sortedCartons) {
        const ctnNum = rows[0].ctn_number;   // displayed carton number (group key may be po#ctn)
        const startRow = dataRow;
        const groupSize = rows.length;
        totalCartons++;

        // Per-carton weight/measure from first row in group
        const nw = rows[0].net_weight_kgs || 0;
        const gw = rows[0].gross_weight_kgs || 0;
        const measure = rows[0].measure_cm || '';

        totalNetWeight += nw;
        totalGrossWeight += gw;

        for (let ri = 0; ri < groupSize; ri++) {
            const r = rows[ri];
            const row = ws.getRow(dataRow);

            row.getCell(1).value = ctnNum;                     // CTN#
            row.getCell(2).value = r.po_number || '';           // PO#
            row.getCell(3).value = r.sku;                       // SKU#
            row.getCell(4).value = r.upc || '';                 // UPC
            row.getCell(5).value = r.style_description || '';   // Style Description
            row.getCell(6).value = r.color_description || '';   // Color Description
            row.getCell(7).value = r.pcs_per_ctn;              // PCS/CTN

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

            totalPcs += r.pcs_per_ctn;
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
    ws.getCell(`B${dataRow}`).value = shipmentData.summary.total_cbm;
    ws.getCell(`B${dataRow}`).numFmt = '#,##0.000';

    // ── Signature block ──────────────────────────────────────────────────
    dataRow += 4;
    ws.getCell(`G${dataRow}`).value = 'Seller Full Company Name and Address:';
    ws.getCell(`G${dataRow + 1}`).value = (meta.vendor_name || '').toUpperCase();
    ws.getCell(`G${dataRow + 2}`).value = (meta.vendor_address || '').toUpperCase();
    dataRow += 5;
    ws.getCell(`G${dataRow}`).value = '(Authorized Signature/ Company Mark)';

    return wb.xlsx.writeBuffer();
}

module.exports = { generatePL };
