'use strict';

const xlsx = require('xlsx');

/**
 * Maps WIP "Ship To Name" values to portal receiving_warehouse values.
 * WIP uses long NetSuite location names; portal uses short master-data names.
 */
const SHIP_TO_WAREHOUSE_MAP = {
    'NRI Warehouse NRI Reserved':               'NRI US Reserved',
    'NRI CA Warehouse : NRI CA Reserved':       'NRI CA Reserved',
    'NRI Warehouse NRI First Inventory':        'NRI US First',
    'NRI CA Warehouse : NRI CA First Inventory': 'NRI CA First',
    'CA DIRECT':                                'Direct CAN',
    'US DIRECT':                                'Direct US',
};

/**
 * Parse an Excel date value (serial number, JS Date, or string) into YYYY-MM-DD.
 * Returns '' for empty/invalid values.
 */
function parseDate(value) {
    if (!value) return '';
    // JS Date object (xlsx with cellDates: true)
    if (value instanceof Date) return value.toISOString().split('T')[0];
    // Excel serial integer
    if (typeof value === 'number') {
        const parsed = xlsx.SSF.parse_date_code(value);
        if (!parsed) return '';
        const mm = String(parsed.m).padStart(2, '0');
        const dd = String(parsed.d).padStart(2, '0');
        return `${parsed.y}-${mm}-${dd}`;
    }
    // String — try MM/DD/YYYY first, then ISO
    if (typeof value === 'string' && value.trim()) {
        const mmddyyyy = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (mmddyyyy) {
            const [, m, d, y] = mmddyyyy;
            return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        }
        // ISO or YYYY-MM-DD
        const d = new Date(value);
        if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    }
    return '';
}

/**
 * Add N calendar days to a YYYY-MM-DD string. Returns '' if input is empty.
 */
function addDays(dateStr, n) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    d.setDate(d.getDate() + n);
    return d.toISOString().split('T')[0];
}

/**
 * Parse a WIP Excel buffer and return an array of PO objects ready to upsert.
 *
 * Each PO object contains:
 *   - All PO-level fields (mapped from first row of that PO group)
 *   - line_items[] — one entry per SKU row
 *
 * @param {Buffer} buffer  — raw Excel file buffer
 * @returns {{ pos: object[], errors: string[] }}
 */
function parseWipBuffer(buffer) {
    const wb = xlsx.read(buffer, { type: 'buffer', cellDates: false });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });

    const errors = [];
    // Group by po_number + mode + CRD so different delivery dates become separate records
    const poMap = new Map(); // "po_number|mode|crd" → PO object

    rows.forEach((row, i) => {
        const poNumber = (row['PO Number'] || '').toString().trim();
        if (!poNumber) {
            errors.push(`Row ${i + 2}: missing PO Number — skipped`);
            return;
        }

        const skuCode = (row['SKU Number'] || '').toString().trim();
        if (!skuCode) {
            errors.push(`Row ${i + 2} (${poNumber}): missing SKU Number — line item skipped`);
        }

        const shippingMethod = (row['Shipping Method'] || '').toString().trim();
        const crd     = parseDate(row['CRD']);
        const eDel    = parseDate(row['In DC ETA']);
        const ata     = parseDate(row['Actual Time of Arrival']);
        const atd     = parseDate(row['Actual Time of Departure (from Shipments)']);
        const shipTo  = (row['Ship To Name'] || '').toString().trim();
        const receivingWarehouse = SHIP_TO_WAREHOUSE_MAP[shipTo] || shipTo;

        const ddp = (row['DDP'] || '').toString().trim();
        const mapKey = `${poNumber}|${shippingMethod}|${crd}`;

        if (!poMap.has(mapKey)) {
            // Initialise PO from first row of this PO+mode group
            poMap.set(mapKey, {
                po_number:            poNumber,
                trn_number:           (row['Tentree Internal PO #'] || '').toString().trim(),
                // strip a leading NetSuite vendor-code prefix (e.g. "VEN1421 ") so the
                // name matches the suppliers master list
                supplier:             (row['Vendor Name'] || '').toString().trim().replace(/^VEN\d+\s+/i, ''),
                season:               (row['Season'] || '').toString().trim(),
                main_shoulder:        (row['Main/Shoulder'] || '').toString().trim(),
                receiving_warehouse:  receivingWarehouse,
                coo:                  (row['COO'] || '').toString().trim(),
                incoterm:             ddp.toLowerCase() === 'yes' ? 'DDP' : '',
                crd:                  crd,
                etd_pol:              atd,
                e_del:                eDel,
                received_in_netsuite: ata || addDays(eDel, 5),
                mode:                 shippingMethod,
                type:                 'mainline',
                // Fields not in WIP — preserve existing or leave blank
                etd:           '',
                eta_pod:       '',
                cargo_received_date: '',
                line_items:    [],
            });
        }

        // Append line item (skip rows with no SKU)
        if (skuCode) {
            poMap.get(mapKey).line_items.push({
                sku_code:    skuCode,
                style_color: (row['Style Color Number'] || '').toString().trim(),
                item_name:   (row['Item Name'] || '').toString().trim(),
                colorway:    (row['Colorway'] || '').toString().trim(),
                mode:        shippingMethod,
                expected_qty: Number(row['Delivery Item Quantity']) || 0,
                unit_price:  parseFloat(row['Price']) || 0,
            });
        }
    });

    // Post-process: compute PO-level expected_qty from line items
    for (const po of poMap.values()) {
        po.expected_qty = po.line_items.reduce((sum, li) => sum + (li.expected_qty || 0), 0);
    }

    return { pos: Array.from(poMap.values()), errors };
}

module.exports = { parseWipBuffer, SHIP_TO_WAREHOUSE_MAP };
