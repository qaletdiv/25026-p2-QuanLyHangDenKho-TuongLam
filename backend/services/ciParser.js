'use strict';

const xlsx = require('xlsx');

/**
 * Default column mapping for the tentree fixed-format CI Excel template.
 *
 * dataStartRow      — 1-based row number where SKU data begins (row above is the header label row)
 * stopOnEmptySku    — (legacy) if true, stop on the first empty SKU. Superseded by
 *                     maxConsecutiveEmpty: the parser now skips individual blank rows and only
 *                     terminates after this many consecutive blank SKU cells in a row.
 *                     This allows blank separator rows within the line-item block.
 * maxConsecutiveEmpty — number of consecutive blank SKU rows that signals end-of-data (default 3)
 * columns           — Excel column letter for each field
 * metadata          — Excel cell reference for invoice header fields
 */
const DEFAULT_CONFIG = {
    dataStartRow: 11,      // SKU line items begin at row 11 (1-based)
    stopOnEmptySku: true,  // kept for backwards-compat; maxConsecutiveEmpty now governs termination
    maxConsecutiveEmpty: 3,
    columns: {
        sku_code:    'A',
        description: 'B',
        quantity:    'C',
        unit_price:  'D',
        total_price: 'E',
        weight_kg:   'F',
        cbm:         'G',
    },
    metadata: {
        invoice_number: 'B2',
        invoice_date:   'D2',
    },
    // PO-level shipping summary block (rows 4–8, one row per PO, up to 5)
    poSummary: {
        startRow: 4,
        endRow:   8,
        columns: {
            po_number:   'A',
            shipped_qty: 'B',
            cartons:     'C',
            weight_kg:   'D',
            cbm:         'E',
        },
    },
};

/**
 * Convert an Excel column letter (or letters) to a 0-based column index.
 * A → 0, B → 1, Z → 25, AA → 26, etc.
 *
 * @param {string} letter
 * @returns {number}
 */
function colLetterToIndex(letter) {
    const upper = letter.toUpperCase();
    let idx = 0;
    for (let i = 0; i < upper.length; i++) {
        idx = idx * 26 + (upper.charCodeAt(i) - 64);
    }
    return idx - 1;
}

/**
 * Read the raw value of a single cell by its A1 reference (e.g. 'B2').
 * Returns null when the cell is empty or missing.
 *
 * @param {object} sheet  — xlsx worksheet object
 * @param {string} ref    — cell reference string
 * @returns {*}
 */
function getCellValue(sheet, ref) {
    const cell = sheet[ref];
    if (!cell) return null;
    return cell.v ?? null;
}

/**
 * Normalise an Excel date value to an ISO date string (YYYY-MM-DD).
 * Handles JS Date objects (when cellDates:true), serial integers, and strings.
 *
 * String handling:
 *   - ISO format "2026-04-15"         → returned as-is
 *   - DD/MM/YYYY "15/04/2026"         → normalised to "2026-04-15"
 *   - MM/DD/YYYY "04/15/2026"         → normalised to "2026-04-15" (ambiguous — treated as DD/MM)
 *   - Any other unrecognised format   → returned trimmed (may display incorrectly in UI)
 *
 * @param {*} raw
 * @returns {string|null}
 */
function parseExcelDate(raw) {
    if (!raw) return null;
    if (raw instanceof Date) {
        // Avoid timezone shifting: use UTC date parts
        const y = raw.getUTCFullYear();
        const m = String(raw.getUTCMonth() + 1).padStart(2, '0');
        const d = String(raw.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    if (typeof raw === 'number') {
        // Excel serial date — convert via xlsx helper
        const d = xlsx.SSF.parse_date_code(raw);
        return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    }
    // String path — attempt normalisation
    const s = String(raw).trim();
    if (!s) return null;

    // Already ISO: YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

    // DD/MM/YYYY or MM/DD/YYYY (treated as DD/MM — most common in vendor templates)
    const slashParts = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashParts) {
        const [, dd, mm, yyyy] = slashParts;
        return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }

    // Fallback — return trimmed string; UI may display incorrectly for non-standard formats
    return s;
}

/**
 * Parse a CI Excel file buffer and return structured invoice data.
 *
 * The caller can pass a partial `config` object to override individual keys
 * in DEFAULT_CONFIG; both `columns` and `metadata` sub-objects are deep-merged.
 *
 * @param {Buffer} fileBuffer       — raw Excel bytes (from multer memory storage)
 * @param {object} [config={}]      — optional overrides for DEFAULT_CONFIG
 * @returns {{ header: object, lineItems: object[] }}
 * @throws {Error} if the buffer cannot be parsed or the workbook has no sheets
 */
function parseCIExcel(fileBuffer, config = {}) {
    // Deep merge with DEFAULT_CONFIG
    const cfg = {
        ...DEFAULT_CONFIG,
        ...config,
        // maxConsecutiveEmpty: caller override or default
        maxConsecutiveEmpty: config.maxConsecutiveEmpty ?? DEFAULT_CONFIG.maxConsecutiveEmpty,
        columns:   { ...DEFAULT_CONFIG.columns,   ...(config.columns   || {}) },
        metadata:  { ...DEFAULT_CONFIG.metadata,  ...(config.metadata  || {}) },
        poSummary: {
            ...DEFAULT_CONFIG.poSummary,
            ...(config.poSummary || {}),
            columns: {
                ...DEFAULT_CONFIG.poSummary.columns,
                ...((config.poSummary || {}).columns || {}),
            },
        },
    };

    // Parse workbook
    let workbook;
    try {
        workbook = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
    } catch (e) {
        throw new Error(`ciParser: could not read Excel file — ${e.message}`);
    }

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
        throw new Error('ciParser: workbook contains no sheets');
    }

    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    // ── Extract invoice header metadata ──────────────────────────────────────
    const rawInvoiceNumber = getCellValue(sheet, cfg.metadata.invoice_number);
    const rawInvoiceDate   = getCellValue(sheet, cfg.metadata.invoice_date);

    const header = {
        invoice_number: rawInvoiceNumber ? String(rawInvoiceNumber).trim() : null,
        invoice_date:   parseExcelDate(rawInvoiceDate),
        total_value:    0,   // filled in below from summing line items
    };

    // ── Build column index map ────────────────────────────────────────────────
    const colIdx = {
        sku_code:    colLetterToIndex(cfg.columns.sku_code),
        description: colLetterToIndex(cfg.columns.description),
        quantity:    colLetterToIndex(cfg.columns.quantity),
        unit_price:  colLetterToIndex(cfg.columns.unit_price),
        total_price: colLetterToIndex(cfg.columns.total_price),
        weight_kg:   colLetterToIndex(cfg.columns.weight_kg),
        cbm:         colLetterToIndex(cfg.columns.cbm),
    };

    const psColIdx = {
        po_number:   colLetterToIndex(cfg.poSummary.columns.po_number),
        shipped_qty: colLetterToIndex(cfg.poSummary.columns.shipped_qty),
        cartons:     colLetterToIndex(cfg.poSummary.columns.cartons),
        weight_kg:   colLetterToIndex(cfg.poSummary.columns.weight_kg),
        cbm:         colLetterToIndex(cfg.poSummary.columns.cbm),
    };

    // ── Read all rows as a 2-D array ─────────────────────────────────────────
    const allRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    const dataStartIdx = cfg.dataStartRow - 1;  // convert 1-based to 0-based

    // ── Parse PO summary block (rows 4–8 by default) ─────────────────────────
    const poSummary = [];
    for (let r = cfg.poSummary.startRow - 1; r <= cfg.poSummary.endRow - 1; r++) {
        const row = allRows[r];
        if (!row) continue;
        const poNum = String(row[psColIdx.po_number] ?? '').trim();
        if (!poNum) continue;  // skip empty rows
        poSummary.push({
            po_number:   poNum,
            shipped_qty: parseInt(row[psColIdx.shipped_qty])  || 0,
            cartons:     parseInt(row[psColIdx.cartons])      || 0,
            weight_kg:   parseFloat(row[psColIdx.weight_kg])  || 0,
            cbm:         parseFloat(row[psColIdx.cbm])        || 0,
        });
    }

    const lineItems = [];
    let runningTotal = 0;
    // Tracks consecutive blank-SKU rows so we can skip internal blank separator rows
    // but still terminate when we reach the true end of the data block.
    let consecutiveEmpty = 0;

    for (let i = dataStartIdx; i < allRows.length; i++) {
        const row = allRows[i];
        const skuRaw = String(row[colIdx.sku_code] ?? '').trim();

        if (!skuRaw) {
            consecutiveEmpty++;
            // Terminate only after maxConsecutiveEmpty blank rows in a row.
            // This allows single blank separator rows within the data block while
            // still stopping cleanly at the end of the line-item section.
            if (consecutiveEmpty >= cfg.maxConsecutiveEmpty) break;
            continue;
        }
        // Non-empty SKU — reset the blank-row counter
        consecutiveEmpty = 0;

        const qty       = parseInt(row[colIdx.quantity])   || 0;
        const unitPrice = parseFloat(row[colIdx.unit_price]) || 0;
        // Use the cell's own total if present; otherwise compute it
        const cellTotal = parseFloat(row[colIdx.total_price]);
        const total     = !isNaN(cellTotal) && cellTotal > 0
            ? parseFloat(cellTotal.toFixed(2))
            : parseFloat((qty * unitPrice).toFixed(2));

        runningTotal += total;

        lineItems.push({
            sku_code:    skuRaw,
            description: String(row[colIdx.description] ?? '').trim(),
            qty,
            unit_price:  unitPrice,
            total,
            weight_kg:   parseFloat(row[colIdx.weight_kg]) || 0,
            cbm:         parseFloat(row[colIdx.cbm]) || 0,
        });
    }

    header.total_value = parseFloat(runningTotal.toFixed(2));

    return { header, poSummary, lineItems };
}

module.exports = { parseCIExcel, DEFAULT_CONFIG };
