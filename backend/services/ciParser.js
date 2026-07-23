'use strict';

const xlsx = require('xlsx');

/**
 * Flat shipment-data parser.
 *
 * Reads a single-sheet Excel workbook where row 1 is column headers and
 * row 2+ is carton-level data (one row per SKU per carton).
 *
 * Columns are auto-detected by matching header text case-insensitively.
 */

// ─── Header detection patterns ──────────────────────────────────────────────
// Order matters: more specific patterns are checked first.
const HEADER_PATTERNS = [
    { key: 'ctn_number',       patterns: [/\bctn\b/i, /\bcarton\b/i] },
    { key: 'sku',              patterns: [/\bsku\b/i] },
    { key: 'upc',              patterns: [/\bupc\b/i, /\bbarcode\b/i] },
    { key: 'knit_woven',       patterns: [/\bknit\b/i, /\bwoven\b/i] },
    { key: 'style_description',patterns: [/\bstyle\b/i] },
    { key: 'color_description',patterns: [/\bcolor\b/i] },
    { key: 'category',         patterns: [/\bcategory\b/i] },
    { key: 'gender',           patterns: [/\bgender\b/i] },
    { key: 'composition',      patterns: [/\bcomposition\b/i, /\bmaterial\b/i] },
    { key: 'hts_code',         patterns: [/\bhts\b/i, /\btariff\b/i] },
    { key: 'total_usd',        patterns: [/\btotal\b/i] },
    { key: 'unit_price',       patterns: [/unit\s*price/i, /price/i] },
    { key: 'pcs_per_ctn',      patterns: [/\bpcs\b/i] },
    { key: 'net_weight_kgs',   patterns: [/n\/w/i, /\bnet\b/i] },
    { key: 'gross_weight_kgs', patterns: [/g\/w/i, /\bgross\b/i] },
    { key: 'measure_cm',       patterns: [/\bmeasure\b/i, /\bdimension\b/i] },
    // po_number checked last — "PO" appears in "COMPOSITION" so we exclude that
    { key: 'po_number',        patterns: [/^po\s*#?$/i, /^po\s*number$/i, /^po$/i, /\bpo\s*#/i] },
];

const REQUIRED_COLUMNS = ['ctn_number', 'po_number', 'sku', 'unit_price', 'pcs_per_ctn'];
const MAX_CONSECUTIVE_EMPTY = 3;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Auto-detect column mapping from header row.
 * Returns { key → columnIndex } for matched columns.
 */
function detectColumns(headerRow) {
    const mapping = {};
    const used = new Set(); // track which columns are already mapped

    for (const { key, patterns } of HEADER_PATTERNS) {
        if (mapping[key] !== undefined) continue;
        for (let col = 0; col < headerRow.length; col++) {
            if (used.has(col)) continue;
            const text = String(headerRow[col] ?? '').trim();
            if (!text) continue;
            for (const pat of patterns) {
                if (pat.test(text)) {
                    mapping[key] = col;
                    used.add(col);
                    break;
                }
            }
            if (mapping[key] !== undefined) break;
        }
    }
    return mapping;
}

/**
 * Parse a MEASURE string like "52X34X40" into CBM (cubic metres).
 */
function measureToCbm(raw) {
    if (!raw) return 0;
    const s = String(raw).replace(/cm$/i, '').trim();
    const parts = s.split(/[*×xX]/).map(p => parseFloat(p.trim()));
    if (parts.length !== 3 || parts.some(isNaN)) return 0;
    return (parts[0] * parts[1] * parts[2]) / 1_000_000;
}

/**
 * Safely parse a number, stripping currency symbols and commas.
 */
function toNum(val) {
    if (val == null) return 0;
    if (typeof val === 'number') return val;
    const cleaned = String(val).replace(/[$,\s]/g, '');
    const n = parseFloat(cleaned);
    return isNaN(n) ? 0 : n;
}

function toInt(val) {
    if (val == null) return 0;
    if (typeof val === 'number') return Math.round(val);
    const cleaned = String(val).replace(/[$,\s#]/g, '');
    const n = parseInt(cleaned, 10);
    return isNaN(n) ? 0 : n;
}

function toStr(val) {
    if (val == null) return '';
    return String(val).trim();
}

// ─── Main parser ────────────────────────────────────────────────────────────

/**
 * Parse a flat shipment-data Excel workbook.
 *
 * @param {Buffer} fileBuffer
 * @returns {{ rows: object[], summary: object }}
 */
function parseShipmentData(fileBuffer) {
    let workbook;
    try {
        workbook = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
    } catch (e) {
        throw new Error(`Could not read Excel file — ${e.message}`);
    }
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
        throw new Error('Workbook contains no sheets');
    }

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const allRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (allRows.length < 1) {
        throw new Error('Workbook is empty — no header row found');
    }

    // ── Detect columns from header row ──────────────────────────────────
    const headerRow = allRows[0];
    const colMap = detectColumns(headerRow);

    // Validate required columns
    const missing = REQUIRED_COLUMNS.filter(k => colMap[k] === undefined);
    if (missing.length > 0) {
        throw new Error(
            `Missing required columns: ${missing.join(', ')}. ` +
            `Detected: ${Object.keys(colMap).join(', ')}`
        );
    }

    // ── Parse data rows ─────────────────────────────────────────────────
    const rows = [];
    let consecutiveEmpty = 0;

    for (let i = 1; i < allRows.length; i++) {
        const raw = allRows[i];
        const sku = toStr(raw[colMap.sku]);

        if (!sku) {
            consecutiveEmpty++;
            if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) break;
            continue;
        }
        consecutiveEmpty = 0;

        const pcs = toInt(raw[colMap.pcs_per_ctn]);
        const unitPrice = toNum(raw[colMap.unit_price]);
        let totalUsd = colMap.total_usd !== undefined ? toNum(raw[colMap.total_usd]) : 0;
        if (!totalUsd && pcs && unitPrice) {
            totalUsd = parseFloat((pcs * unitPrice).toFixed(2));
        }

        rows.push({
            ctn_number:        toInt(raw[colMap.ctn_number]),
            po_number:         toStr(raw[colMap.po_number]),
            sku,
            upc:               colMap.upc !== undefined ? toStr(raw[colMap.upc]) : null,
            knit_woven:        colMap.knit_woven !== undefined ? toStr(raw[colMap.knit_woven]) : null,
            style_description: colMap.style_description !== undefined ? toStr(raw[colMap.style_description]) : '',
            color_description: colMap.color_description !== undefined ? toStr(raw[colMap.color_description]) : '',
            category:          colMap.category !== undefined ? toStr(raw[colMap.category]) : null,
            gender:            colMap.gender !== undefined ? toStr(raw[colMap.gender]) : null,
            composition:       colMap.composition !== undefined ? toStr(raw[colMap.composition]) : null,
            hts_code:          colMap.hts_code !== undefined ? toStr(raw[colMap.hts_code]) : null,
            unit_price:        unitPrice,
            total_usd:         totalUsd,
            pcs_per_ctn:       pcs,
            net_weight_kgs:    colMap.net_weight_kgs !== undefined ? toNum(raw[colMap.net_weight_kgs]) : 0,
            gross_weight_kgs:  colMap.gross_weight_kgs !== undefined ? toNum(raw[colMap.gross_weight_kgs]) : 0,
            measure_cm:        colMap.measure_cm !== undefined ? toStr(raw[colMap.measure_cm]).replace(/cm$/i, '').trim() : '',
        });
    }

    // ── Compute summary ─────────────────────────────────────────────────
    // Weight and measure are per-carton (only count first occurrence of each ctn_number)
    const seenCartons = new Set();
    let totalPcs = 0;
    let totalValue = 0;
    let totalNetWeight = 0;
    let totalGrossWeight = 0;
    let totalCbm = 0;

    for (const row of rows) {
        totalPcs += row.pcs_per_ctn;
        totalValue += row.total_usd;

        if (!seenCartons.has(row.ctn_number)) {
            seenCartons.add(row.ctn_number);
            totalNetWeight += row.net_weight_kgs;
            totalGrossWeight += row.gross_weight_kgs;
            totalCbm += measureToCbm(row.measure_cm);
        }
    }

    const summary = {
        total_pcs:          totalPcs,
        total_cartons:      seenCartons.size,
        total_value:        parseFloat(totalValue.toFixed(2)),
        total_net_weight:   parseFloat(totalNetWeight.toFixed(2)),
        total_gross_weight: parseFloat(totalGrossWeight.toFixed(2)),
        total_cbm:          parseFloat(totalCbm.toFixed(3)),
    };

    return { rows, summary };
}

// ─── CI Template Parser ────────────────────────────────────────────────────
// Parses the tentree CI Template Excel (header metadata in rows 1-20,
// column headers in row 21, data in rows 22+).
// Falls back to auto-detect mode if the template layout is not recognized.

// Column letters in the CI template (row 21 headers)
const CI_TEMPLATE_COLS = {
    po_number:  0, // A
    sku_code:   1, // B
    upc:        2, // C
    knit_woven: 3, // D
    style_desc: 4, // E
    color_desc: 5, // F
    category:   6, // G
    gender:     7, // H
    composition:8, // I
    hts_code:   9, // J
    quantity:  10, // K
    unit_price:11, // L
    total_usd: 12, // M
};

/**
 * Try to read a metadata value from the CI template header block.
 * The template puts labels in column I and values in merged J:K.
 */
function readMetaField(allRows, labelPattern, rowRange) {
    for (let r = rowRange[0]; r <= rowRange[1]; r++) {
        const row = allRows[r];
        if (!row) continue;
        // Label is in col I (index 8), value in col J (index 9)
        const label = String(row[8] ?? '').trim();
        if (labelPattern.test(label)) {
            return row[9] ?? row[10] ?? '';
        }
    }
    return null;
}

/**
 * Detect whether row 21 (0-indexed row 20) looks like the CI template header.
 */
function isCiTemplateLayout(allRows) {
    if (allRows.length < 22) return false;
    const headerRow = allRows[20]; // row 21 (0-indexed)
    if (!headerRow) return false;
    const first = String(headerRow[0] ?? '').trim().toLowerCase();
    const second = String(headerRow[1] ?? '').trim().toLowerCase();
    return (first.includes('po') && second.includes('sku'));
}

/**
 * Parse a CI Excel file (tentree template or auto-detect).
 *
 * @param {Buffer} fileBuffer
 * @param {object} config - optional overrides
 * @returns {{ header, poSummary, lineItems }}
 */
function parseCIExcel(fileBuffer, config = {}) {
    let workbook;
    try {
        workbook = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
    } catch (e) {
        throw new Error(`Could not read Excel file — ${e.message}`);
    }
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
        throw new Error('Workbook contains no sheets');
    }

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const allRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    let header = { invoice_number: null, invoice_date: null, total_value: 0 };
    let lineItems = [];

    if (isCiTemplateLayout(allRows)) {
        // ── tentree CI Template layout ──────────────────────────────────
        // Extract metadata from header block (rows 1-20, 0-indexed 0-19)
        const invoiceNum = readMetaField(allRows, /invoice\s*#?/i, [1, 5]);
        const invoiceDate = readMetaField(allRows, /^date$/i, [1, 5]);
        const poNum = readMetaField(allRows, /^po\s*#?$/i, [1, 5]);

        header.invoice_number = invoiceNum ? String(invoiceNum).trim() : null;
        header.invoice_date = invoiceDate
            ? (invoiceDate instanceof Date
                ? invoiceDate.toISOString().slice(0, 10)
                : String(invoiceDate).trim())
            : null;

        // Parse data rows starting at row 22 (0-indexed 21)
        let consecutiveEmpty = 0;
        for (let i = 21; i < allRows.length; i++) {
            const raw = allRows[i];
            const sku = toStr(raw[CI_TEMPLATE_COLS.sku_code]);
            if (!sku) {
                consecutiveEmpty++;
                if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) break;
                continue;
            }
            consecutiveEmpty = 0;

            const qty = toInt(raw[CI_TEMPLATE_COLS.quantity]);
            const unitPrice = toNum(raw[CI_TEMPLATE_COLS.unit_price]);
            let total = toNum(raw[CI_TEMPLATE_COLS.total_usd]);
            if (!total && qty && unitPrice) {
                total = parseFloat((qty * unitPrice).toFixed(2));
            }

            lineItems.push({
                sku_code:    sku,
                description: toStr(raw[CI_TEMPLATE_COLS.style_desc]) || toStr(raw[CI_TEMPLATE_COLS.color_desc]) || sku,
                qty,
                unit_price: unitPrice,
                total,
                weight_kg:  0,
                cbm:        0,
                po_number:  toStr(raw[CI_TEMPLATE_COLS.po_number]) || (poNum ? String(poNum).trim() : ''),
            });
        }
    } else {
        // ── Auto-detect layout (flat table, similar to shipment data) ───
        // Try to find a header row with SKU + quantity-like columns
        let headerRowIdx = -1;
        let colMap = {};

        for (let i = 0; i < Math.min(allRows.length, 30); i++) {
            const testMap = detectColumns(allRows[i]);
            if (testMap.sku && (testMap.pcs_per_ctn !== undefined || testMap.unit_price !== undefined)) {
                colMap = testMap;
                headerRowIdx = i;
                break;
            }
        }

        if (headerRowIdx === -1) {
            throw new Error('Could not detect column headers. Upload a tentree CI Template or a flat Excel with SKU, Quantity, and Price columns.');
        }

        // Try to find invoice metadata in rows above the header
        for (let i = 0; i < headerRowIdx; i++) {
            const row = allRows[i];
            if (!row) continue;
            for (let c = 0; c < row.length; c++) {
                const cell = String(row[c] ?? '').trim();
                if (/invoice\s*#?\s*:?\s*$/i.test(cell) && row[c + 1]) {
                    header.invoice_number = String(row[c + 1]).trim();
                }
                if (/^date\s*:?\s*$/i.test(cell) && row[c + 1]) {
                    const d = row[c + 1];
                    header.invoice_date = d instanceof Date
                        ? d.toISOString().slice(0, 10)
                        : String(d).trim();
                }
            }
        }

        // Parse data rows
        let consecutiveEmpty = 0;
        for (let i = headerRowIdx + 1; i < allRows.length; i++) {
            const raw = allRows[i];
            const sku = toStr(raw[colMap.sku]);
            if (!sku) {
                consecutiveEmpty++;
                if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) break;
                continue;
            }
            consecutiveEmpty = 0;

            const qty = colMap.pcs_per_ctn !== undefined ? toInt(raw[colMap.pcs_per_ctn]) : 0;
            const unitPrice = colMap.unit_price !== undefined ? toNum(raw[colMap.unit_price]) : 0;
            let total = colMap.total_usd !== undefined ? toNum(raw[colMap.total_usd]) : 0;
            if (!total && qty && unitPrice) {
                total = parseFloat((qty * unitPrice).toFixed(2));
            }

            lineItems.push({
                sku_code:    sku,
                description: colMap.style_description !== undefined ? toStr(raw[colMap.style_description]) : sku,
                qty,
                unit_price: unitPrice,
                total,
                weight_kg:  colMap.net_weight_kgs !== undefined ? toNum(raw[colMap.net_weight_kgs]) : 0,
                cbm:        colMap.measure_cm !== undefined ? measureToCbm(raw[colMap.measure_cm]) : 0,
                po_number:  colMap.po_number !== undefined ? toStr(raw[colMap.po_number]) : '',
            });
        }
    }

    // ── Compute totals and build PO summary ────────────────────────────
    header.total_value = parseFloat(lineItems.reduce((s, li) => s + (li.total || 0), 0).toFixed(2));

    // Group by PO number for poSummary
    const poGroups = {};
    for (const li of lineItems) {
        const po = li.po_number || 'UNKNOWN';
        if (!poGroups[po]) poGroups[po] = { shipped_qty: 0, cartons: 0, weight_kg: 0, cbm: 0 };
        poGroups[po].shipped_qty += li.qty;
        poGroups[po].weight_kg += li.weight_kg;
        poGroups[po].cbm += li.cbm;
    }
    const poSummary = Object.entries(poGroups).map(([po_number, g]) => ({
        po_number,
        shipped_qty: g.shipped_qty,
        cartons: 0,
        weight_kg: parseFloat(g.weight_kg.toFixed(2)),
        cbm: parseFloat(g.cbm.toFixed(3)),
    }));

    return { header, poSummary, lineItems };
}

module.exports = { parseShipmentData, parseCIExcel };
