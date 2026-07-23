'use strict';

const ExcelJS = require('exceljs');

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

    // ── Column widths ────────────────────────────────────────────────────
    //  A=12  B=22  C=16  D=12  E=25  F=28  G=12  H=10  I=35  J=16  K=10  L=14  M=14
    ws.columns = [
        { width: 12 }, { width: 22 }, { width: 16 }, { width: 12 }, { width: 25 },
        { width: 28 }, { width: 12 }, { width: 10 }, { width: 35 }, { width: 16 },
        { width: 10 }, { width: 14 }, { width: 14 },
    ];

    const bold = { bold: true };
    const borderThin = {
        top: { style: 'thin' }, bottom: { style: 'thin' },
        left: { style: 'thin' }, right: { style: 'thin' },
    };

    // ── Header section (rows 1-12) ───────────────────────────────────────
    ws.getCell('A1').value = meta.vendor_name || '';
    ws.getCell('A1').font = { bold: true, size: 12 };

    ws.getCell('A2').value = meta.vendor_address || '';
    ws.getCell('I2').value = 'PO #';       ws.getCell('I2').font = bold;
    ws.getCell('J2').value = meta.po_number || '';

    ws.getCell('A3').value = meta.vendor_contact || '';
    ws.getCell('I3').value = 'Invoice #';  ws.getCell('I3').font = bold;
    ws.getCell('J3').value = meta.invoice_number || '';

    ws.getCell('I4').value = 'Date';       ws.getCell('I4').font = bold;
    ws.getCell('J4').value = meta.date || new Date().toISOString().slice(0, 10);

    ws.getCell('A6').value = 'Manufacturer Name: ' + (meta.vendor_name || '');
    ws.getCell('I6').value = 'Shipping Mode'; ws.getCell('I6').font = bold;
    ws.getCell('J6').value = meta.shipping_mode || '';

    ws.getCell('A7').value = 'Manufacturer address: ' + (meta.vendor_address || '').split('\n')[0];
    ws.getCell('I7').value = 'Shipment #';  ws.getCell('I7').font = bold;
    ws.getCell('J7').value = meta.shipment_number || '';

    const addrLines = (meta.vendor_address || '').split('\n');
    ws.getCell('A8').value = addrLines[1] || '';
    ws.getCell('I8').value = 'ETA Date';    ws.getCell('I8').font = bold;
    ws.getCell('J8').value = meta.eta_date || '';

    ws.getCell('A9').value = meta.vendor_contact || '';
    ws.getCell('I9').value = 'Port of Loading'; ws.getCell('I9').font = bold;
    ws.getCell('J9').value = meta.port_of_loading || '';

    ws.getCell('I10').value = 'Port of Discharge'; ws.getCell('I10').font = bold;
    ws.getCell('J10').value = meta.port_of_discharge || '';

    ws.getCell('I11').value = 'Remarks';    ws.getCell('I11').font = bold;
    ws.getCell('J11').value = meta.remarks || '';

    ws.mergeCells('A12:H12');
    ws.getCell('A12').value = 'Commercial Invoice';
    ws.getCell('A12').font = { bold: true, size: 13 };
    ws.getCell('I12').value = 'Country of Origin'; ws.getCell('I12').font = bold;
    ws.getCell('J12').value = meta.country_of_origin || '';

    // ── Consignee / Notify Party (rows 14-18) ───────────────────────────
    ws.getCell('A14').value = 'Consignee';        ws.getCell('A14').font = bold;
    ws.getCell('D14').value = 'Notify Party';     ws.getCell('D14').font = bold;

    const conLines = (meta.consignee_name || '').split('\n').concat(
        (meta.consignee_address || '').split('\n')
    );
    const notifyLines = (meta.notify_party_name || '').split('\n').concat(
        (meta.notify_party_address || '').split('\n')
    );
    for (let i = 0; i < 4; i++) {
        if (conLines[i])    ws.getCell(`A${15 + i}`).value = conLines[i];
        if (notifyLines[i]) ws.getCell(`D${15 + i}`).value = notifyLines[i];
    }

    // ── Column headers (row 21) ──────────────────────────────────────────
    const colHeaders = [
        'PO#', 'SKU', 'UPC', 'Knit/Woven', 'Style Description', 'Color Description',
        'Category', 'Gender', 'Composition', 'HTS Code', 'Quantity',
        'Unit Price USD', 'Total USD',
    ];
    const row21 = ws.getRow(21);
    colHeaders.forEach((h, i) => {
        const cell = row21.getCell(i + 1);
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

    // ── Data rows (row 22+) ──────────────────────────────────────────────
    let dataRow = 22;
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
    ws.getCell(`H${dataRow + 2}`).value = (meta.vendor_address || '').toUpperCase();
    dataRow += 6;
    ws.getCell(`H${dataRow}`).value = '(Authorized Signature/ Company Mark)';

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
