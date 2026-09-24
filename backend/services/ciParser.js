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
    { key: 'ctnNumber',       patterns: [/\bctn\b/i, /\bcarton\b/i] },
    { key: 'sku',              patterns: [/\bsku\b/i] },
    { key: 'upc',              patterns: [/\bupc\b/i, /\bbarcode\b/i] },
    { key: 'knitWoven',       patterns: [/\bknit\b/i, /\bwoven\b/i] },
    { key: 'style_description',patterns: [/\bstyle\b/i] },
    { key: 'color_description',patterns: [/\bcolor\b/i] },
    { key: 'category',         patterns: [/\bcategory\b/i] },
    { key: 'gender',           patterns: [/\bgender\b/i] },
    { key: 'composition',      patterns: [/\bcomposition\b/i, /\bmaterial\b/i] },
    { key: 'htsCode',         patterns: [/\bhts\b/i, /\btariff\b/i] },
    { key: 'totalUsd',        patterns: [/\btotal\b/i] },
    { key: 'unitPrice',       patterns: [/unit\s*price/i, /price/i] },
    { key: 'pcsPerCtn',      patterns: [/\bpcs\b/i] },
    { key: 'netWeightKgs',   patterns: [/n\/w/i, /\bnet\b/i] },
    { key: 'grossWeightKgs', patterns: [/g\/w/i, /\bgross\b/i] },
    { key: 'measureCm',       patterns: [/\bmeasure\b/i, /\bdimension\b/i] },
    // poNumber checked last — "PO" appears in "COMPOSITION" so we exclude that
    { key: 'poNumber',        patterns: [/^po\s*#?$/i, /^po\s*number$/i, /^po$/i, /\bpo\s*#/i] },
];

const REQUIRED_COLUMNS = ['ctnNumber', 'poNumber', 'sku', 'unitPrice', 'pcsPerCtn'];
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

        const pcs = toInt(raw[colMap.pcsPerCtn]);
        const unitPrice = toNum(raw[colMap.unitPrice]);
        let totalUsd = colMap.totalUsd !== undefined ? toNum(raw[colMap.totalUsd]) : 0;
        if (!totalUsd && pcs && unitPrice) {
            totalUsd = parseFloat((pcs * unitPrice).toFixed(2));
        }

        rows.push({
            ctnNumber:        toInt(raw[colMap.ctnNumber]),
            poNumber:         toStr(raw[colMap.poNumber]),
            sku,
            upc:               colMap.upc !== undefined ? toStr(raw[colMap.upc]) : null,
            knitWoven:        colMap.knitWoven !== undefined ? toStr(raw[colMap.knitWoven]) : null,
            style_description: colMap.style_description !== undefined ? toStr(raw[colMap.style_description]) : '',
            color_description: colMap.color_description !== undefined ? toStr(raw[colMap.color_description]) : '',
            category:          colMap.category !== undefined ? toStr(raw[colMap.category]) : null,
            gender:            colMap.gender !== undefined ? toStr(raw[colMap.gender]) : null,
            composition:       colMap.composition !== undefined ? toStr(raw[colMap.composition]) : null,
            htsCode:          colMap.htsCode !== undefined ? toStr(raw[colMap.htsCode]) : null,
            unitPrice:        unitPrice,
            totalUsd:         totalUsd,
            pcsPerCtn:       pcs,
            netWeightKgs:    colMap.netWeightKgs !== undefined ? toNum(raw[colMap.netWeightKgs]) : 0,
            grossWeightKgs:  colMap.grossWeightKgs !== undefined ? toNum(raw[colMap.grossWeightKgs]) : 0,
            measureCm:        colMap.measureCm !== undefined ? toStr(raw[colMap.measureCm]).replace(/cm$/i, '').trim() : '',
        });
    }

    // ── Compute summary ─────────────────────────────────────────────────
    // Weight and measure are per-carton (only count first occurrence of each ctnNumber)
    const seenCartons = new Set();
    let totalPcs = 0;
    let totalValue = 0;
    let totalNetWeight = 0;
    let totalGrossWeight = 0;
    let totalCbm = 0;

    for (const row of rows) {
        totalPcs += row.pcsPerCtn;
        totalValue += row.totalUsd;

        if (!seenCartons.has(row.ctnNumber)) {
            seenCartons.add(row.ctnNumber);
            totalNetWeight += row.netWeightKgs;
            totalGrossWeight += row.grossWeightKgs;
            totalCbm += measureToCbm(row.measureCm);
        }
    }

    const summary = {
        totalPcs:          totalPcs,
        totalCartons:      seenCartons.size,
        totalValue:        parseFloat(totalValue.toFixed(2)),
        totalNetWeight:   parseFloat(totalNetWeight.toFixed(2)),
        totalGrossWeight: parseFloat(totalGrossWeight.toFixed(2)),
        totalCbm:          parseFloat(totalCbm.toFixed(3)),
    };

    return { rows, summary };
}

// ─── CI Template Parser ────────────────────────────────────────────────────
// Parses the tentree CI Template Excel (header metadata in rows 1-20,
// column headers in row 21, data in rows 22+).
// Falls back to auto-detect mode if the template layout is not recognized.

// Column letters in the CI template (row 21 headers)
const CI_TEMPLATE_COLS = {
    poNumber:  0, // A
    skuCode:   1, // B
    upc:        2, // C
    knitWoven: 3, // D
    style_desc: 4, // E
    color_desc: 5, // F
    category:   6, // G
    gender:     7, // H
    composition:8, // I
    htsCode:   9, // J
    quantity:  10, // K
    unitPrice:11, // L
    totalUsd: 12, // M
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

    let header = { invoiceNumber: null, invoiceDate: null, totalValue: 0 };
    let lineItems = [];

    if (isCiTemplateLayout(allRows)) {
        // ── tentree CI Template layout ──────────────────────────────────
        // Extract metadata from header block (rows 1-20, 0-indexed 0-19)
        const invoiceNum = readMetaField(allRows, /invoice\s*#?/i, [1, 5]);
        const invoiceDate = readMetaField(allRows, /^date$/i, [1, 5]);
        const poNum = readMetaField(allRows, /^po\s*#?$/i, [1, 5]);

        header.invoiceNumber = invoiceNum ? String(invoiceNum).trim() : null;
        header.invoiceDate = invoiceDate
            ? (invoiceDate instanceof Date
                ? invoiceDate.toISOString().slice(0, 10)
                : String(invoiceDate).trim())
            : null;

        // Parse data rows starting at row 22 (0-indexed 21)
        let consecutiveEmpty = 0;
        for (let i = 21; i < allRows.length; i++) {
            const raw = allRows[i];
            const sku = toStr(raw[CI_TEMPLATE_COLS.skuCode]);
            if (!sku) {
                consecutiveEmpty++;
                if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) break;
                continue;
            }
            consecutiveEmpty = 0;

            const qty = toInt(raw[CI_TEMPLATE_COLS.quantity]);
            const unitPrice = toNum(raw[CI_TEMPLATE_COLS.unitPrice]);
            let total = toNum(raw[CI_TEMPLATE_COLS.totalUsd]);
            if (!total && qty && unitPrice) {
                total = parseFloat((qty * unitPrice).toFixed(2));
            }

            lineItems.push({
                skuCode:    sku,
                description: toStr(raw[CI_TEMPLATE_COLS.style_desc]) || toStr(raw[CI_TEMPLATE_COLS.color_desc]) || sku,
                qty,
                unitPrice: unitPrice,
                total,
                weightKg:  0,
                cbm:        0,
                poNumber:  toStr(raw[CI_TEMPLATE_COLS.poNumber]) || (poNum ? String(poNum).trim() : ''),
            });
        }
    } else {
        // ── Auto-detect layout (flat table, similar to shipment data) ───
        // Try to find a header row with SKU + quantity-like columns
        let headerRowIdx = -1;
        let colMap = {};

        for (let i = 0; i < Math.min(allRows.length, 30); i++) {
            const testMap = detectColumns(allRows[i]);
            if (testMap.sku && (testMap.pcsPerCtn !== undefined || testMap.unitPrice !== undefined)) {
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
                    header.invoiceNumber = String(row[c + 1]).trim();
                }
                if (/^date\s*:?\s*$/i.test(cell) && row[c + 1]) {
                    const d = row[c + 1];
                    header.invoiceDate = d instanceof Date
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

            const qty = colMap.pcsPerCtn !== undefined ? toInt(raw[colMap.pcsPerCtn]) : 0;
            const unitPrice = colMap.unitPrice !== undefined ? toNum(raw[colMap.unitPrice]) : 0;
            let total = colMap.totalUsd !== undefined ? toNum(raw[colMap.totalUsd]) : 0;
            if (!total && qty && unitPrice) {
                total = parseFloat((qty * unitPrice).toFixed(2));
            }

            lineItems.push({
                skuCode:    sku,
                description: colMap.style_description !== undefined ? toStr(raw[colMap.style_description]) : sku,
                qty,
                unitPrice: unitPrice,
                total,
                weightKg:  colMap.netWeightKgs !== undefined ? toNum(raw[colMap.netWeightKgs]) : 0,
                cbm:        colMap.measureCm !== undefined ? measureToCbm(raw[colMap.measureCm]) : 0,
                poNumber:  colMap.poNumber !== undefined ? toStr(raw[colMap.poNumber]) : '',
            });
        }
    }

    // ── Compute totals and build PO summary ────────────────────────────
    header.totalValue = parseFloat(lineItems.reduce((s, li) => s + (li.total || 0), 0).toFixed(2));

    // Group by PO number for poSummary
    const poGroups = {};
    for (const li of lineItems) {
        const po = li.poNumber || 'UNKNOWN';
        if (!poGroups[po]) poGroups[po] = { shippedQty: 0, cartons: 0, weightKg: 0, cbm: 0 };
        poGroups[po].shippedQty += li.qty;
        poGroups[po].weightKg += li.weightKg;
        poGroups[po].cbm += li.cbm;
    }
    const poSummary = Object.entries(poGroups).map(([poNumber, g]) => ({
        poNumber,
        shippedQty: g.shippedQty,
        cartons: 0,
        weightKg: parseFloat(g.weightKg.toFixed(2)),
        cbm: parseFloat(g.cbm.toFixed(3)),
    }));

    return { header, poSummary, lineItems };
}

module.exports = { parseShipmentData, parseCIExcel };
