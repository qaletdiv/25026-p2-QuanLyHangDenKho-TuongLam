'use strict';

const XLSX = require('xlsx');
const path = require('path');
const fs   = require('fs');

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');

/**
 * Generate a freight rates Excel workbook with 4 sheets:
 *   1. All Rates
 *   2. FCL only
 *   3. LCL only
 *   4. Meta (quote metadata)
 *
 * @param {object} record  Freight record from freights.json
 * @returns {string}       file_url relative path e.g. "/uploads/freight_<id>.xlsx"
 */
function generateFreightXlsx(record) {
    const { id, forwarder, region, quote_ref, effective_date, expiry_date, rates = [], file_name, parsed_at } = record;

    const wb = XLSX.utils.book_new();

    // ── Sheet 1: All Rates ─────────────────────────────────────────────────────
    const allRows = rates.map(r => ({
        Origin:         r.origin,
        Destination:    r.destination,
        'Move Type':    r.moveType,
        'Container':    r.containerType,
        'Rate (USD)':   r.rateUSD,
        Unit:           r.unit,
        'Transit':      r.transitDays,
        'Change %':     r.changePercent != null ? `${r.changePercent > 0 ? '+' : ''}${r.changePercent}%` : '',
    }));
    const wsAll = XLSX.utils.json_to_sheet(allRows);
    wsAll['!cols'] = [20, 20, 10, 14, 12, 16, 16, 10].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, wsAll, 'All Rates');

    // ── Sheet 2: FCL ───────────────────────────────────────────────────────────
    const fclRows = rates.filter(r => r.moveType === 'FCL').map(r => ({
        Origin:        r.origin,
        Destination:   r.destination,
        Container:     r.containerType,
        'Rate (USD)':  r.rateUSD,
        Transit:       r.transitDays,
        'Change %':    r.changePercent != null ? `${r.changePercent > 0 ? '+' : ''}${r.changePercent}%` : '',
    }));
    const wsFcl = XLSX.utils.json_to_sheet(fclRows);
    wsFcl['!cols'] = [20, 20, 14, 12, 16, 10].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, wsFcl, 'FCL');

    // ── Sheet 3: LCL ───────────────────────────────────────────────────────────
    const lclRows = rates.filter(r => r.moveType === 'LCL').map(r => ({
        Origin:        r.origin,
        Destination:   r.destination,
        'Rate (USD)':  r.rateUSD,
        Unit:          r.unit,
        Transit:       r.transitDays,
        'Change %':    r.changePercent != null ? `${r.changePercent > 0 ? '+' : ''}${r.changePercent}%` : '',
    }));
    const wsLcl = XLSX.utils.json_to_sheet(lclRows);
    wsLcl['!cols'] = [20, 20, 12, 16, 16, 10].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, wsLcl, 'LCL');

    // ── Sheet 4: Meta ──────────────────────────────────────────────────────────
    const metaRows = [
        { Field: 'Forwarder',          Value: forwarder || '' },
        { Field: 'Region',             Value: region    || '' },
        { Field: 'Quote Reference',    Value: quote_ref || '' },
        { Field: 'Effective Date',     Value: effective_date || '' },
        { Field: 'Expiry Date',        Value: expiry_date   || '' },
        { Field: 'Total Rates',        Value: rates.length },
        { Field: 'FCL Rates',          Value: rates.filter(r => r.moveType === 'FCL').length },
        { Field: 'LCL Rates',          Value: rates.filter(r => r.moveType === 'LCL').length },
        { Field: 'Source File',        Value: file_name || '' },
        { Field: 'Exported At',        Value: new Date().toISOString() },
    ];
    const wsMeta = XLSX.utils.json_to_sheet(metaRows);
    wsMeta['!cols'] = [{ wch: 18 }, { wch: 32 }];
    XLSX.utils.book_append_sheet(wb, wsMeta, 'Meta');

    // ── Write file ─────────────────────────────────────────────────────────────
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

    const safeForwarder = (forwarder || 'freight').replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeRegion    = (region    || 'region').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename      = `freight_${safeForwarder}_${safeRegion}_${id}.xlsx`;
    const filePath      = path.join(UPLOADS_DIR, filename);

    XLSX.writeFile(wb, filePath);

    return `/uploads/${filename}`;
}

module.exports = { generateFreightXlsx };
