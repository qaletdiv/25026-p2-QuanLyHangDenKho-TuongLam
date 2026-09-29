'use strict';

const XLSX = require('xlsx');

/**
 * Column header aliases → internal field names.
 * Keys are lowercased/trimmed header strings from the uploaded file.
 */
const COLUMN_MAP = {
    'origin':          'origin',
    'destination':     'destination',
    'move type':       'moveType',
    'movetype':        'moveType',
    'type':            'moveType',
    'container type':  'containerType',
    'containertype':   'containerType',
    'container':       'containerType',
    'rate usd':        'rateUSD',
    'rate (usd)':      'rateUSD',
    'rateusd':         'rateUSD',
    'rate':            'rateUSD',
    'unit':            'unit',
    'transit days':    'transitDays',
    'transitdays':     'transitDays',
    'transit':         'transitDays',
    'change %':        'changePercent',
    'change%':         'changePercent',
    'changepercent':   'changePercent',
    'delta':           'changePercent',
    'Δ chg':           'changePercent',
};

/**
 * Parse an uploaded Excel (.xlsx/.xls) or CSV buffer.
 * Expects:
 *   Row 1  — column headers (order-independent, alias-tolerant)
 *   Row 2+ — one freight rate per row; empty rows are skipped
 *
 * @param {Buffer} buffer
 * @returns {{ rates: FreightRate[] }}
 */
function parseTemplate(buffer) {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    if (!rows || rows.length < 2) {
        const err = new Error('Template appears empty — make sure the file has a header row and at least one data row.');
        err.statusCode = 422;
        throw err;
    }

    // Map header labels → column indices
    const rawHeaders = rows[0].map(h => String(h).toLowerCase().trim());
    const colIndex = {};
    rawHeaders.forEach((h, i) => {
        const field = COLUMN_MAP[h];
        if (field && !(field in colIndex)) colIndex[field] = i;
    });

    const required = ['origin', 'destination', 'rateUSD'];
    const missing  = required.filter(f => !(f in colIndex));
    if (missing.length) {
        const err = new Error(
            `Missing required columns: ${missing.join(', ')}. ` +
            `Expected headers: Origin, Destination, Rate USD (and optionally Move Type, Container Type, Unit, Transit Days, Change %)`
        );
        err.statusCode = 422;
        throw err;
    }

    const rates = [];
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.every(cell => cell === '' || cell === null || cell === undefined)) continue;

        const get = field => (colIndex[field] !== undefined ? row[colIndex[field]] : '');

        const moveTypeRaw = String(get('moveType') || '').toUpperCase().trim();
        const moveType    = moveTypeRaw === 'LCL' ? 'LCL' : 'FCL';
        const rateRaw     = get('rateUSD');
        const rateUSD     = parseFloat(String(rateRaw).replace(/[^0-9.\-]/g, '')) || 0;
        const chgRaw      = get('changePercent');
        const changePercent =
            chgRaw !== '' && chgRaw !== null && chgRaw !== undefined
                ? (parseFloat(String(chgRaw).replace(/[^0-9.\-+]/g, '')) || null)
                : null;

        const origin      = String(get('origin')      || '').trim();
        const destination = String(get('destination') || '').trim();
        if (!origin && !destination) continue;

        rates.push({
            origin,
            destination,
            moveType,
            containerType: String(get('containerType') || (moveType === 'LCL' ? 'LCL' : "40' HC")).trim(),
            rateUSD,
            unit:           String(get('unit') || (moveType === 'LCL' ? 'per W/M' : 'per container')).trim(),
            transitDays:    String(get('transitDays') || '').trim(),
            changePercent,
        });
    }

    if (rates.length === 0) {
        const err = new Error('No rate rows found. Fill in data starting from row 2.');
        err.statusCode = 422;
        throw err;
    }

    return { rates };
}

/**
 * Generate a blank freight rate template xlsx buffer.
 * Returns a Node.js Buffer ready to stream to the client.
 */
function generateTemplate() {
    const wb = XLSX.utils.book_new();

    const data = [
        ['Origin', 'Destination', 'Move Type', 'Container Type', 'Rate USD', 'Unit', 'Transit Days', 'Change %'],
        ['Shanghai, CN',     'Vancouver, BC', 'FCL', "20' STD",  2400, 'per container', '20-22 days',  null],
        ['Shanghai, CN',     'Vancouver, BC', 'FCL', "40' HC",   2800, 'per container', '20-22 days',    -4],
        ['Shanghai, CN',     'Vancouver, BC', 'LCL', 'LCL',       145, 'per W/M',       '22-25 days',  null],
        ['Ho Chi Minh, VN',  'Vancouver, BC', 'FCL', "40' HC",   3100, 'per container', '25-28 days',   18],
        ['Ho Chi Minh, VN',  'Toronto, CA',   'FCL', "40' HC",   3400, 'per container', '30-33 days',  null],
    ];

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [22, 18, 12, 16, 12, 16, 16, 12].map(w => ({ wch: w }));

    // Bold header row styling hint (xlsx doesn't render styles in all viewers, but set it anyway)
    const headerRange = XLSX.utils.decode_range('A1:H1');
    for (let c = headerRange.s.c; c <= headerRange.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
        if (cell) cell.s = { font: { bold: true } };
    }

    XLSX.utils.book_append_sheet(wb, ws, 'Freight Rates');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { parseTemplate, generateTemplate };
