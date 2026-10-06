'use strict';
/**
 * Readers for the two documents the NRI billing flow consumes.
 *
 * 1. NRI's "Invoice Details Report" — what NRI CA / NRI US send twice a month
 *    (`NRI CA Invoice Sept 15 2026.csv`). It is a PRINTED report exported to CSV,
 *    not a table, so the workbook's Power Query had to clean it and this does the
 *    same, explicitly:
 *      - four banner rows above the header (vendor, report name, client,
 *        `Invoice:,,50020 ( Ending 9/15/2026 11:59:59 PM )`) — the invoice number
 *        and period end live ONLY there;
 *      - an UNNAMED column between `Client Ref 1` and `Client Ref 2` (always blank);
 *      - money as text (`$1,234.56`), dates as `MM/DD/YYYY`;
 *      - a page footer (`"Monday, September 21, 2026",,,…,Page:,01-Jan`) and, on
 *        multi-page exports, the header row repeated — the workbook's combined
 *        table carried 66 repeated headers and 14 blank rows for exactly this
 *        reason. Both are dropped here (a line needs a Service).
 *    The header row is FOUND, never assumed at a fixed offset: NRI has moved its
 *    banner before (see docs/NRI_INVOICE_MODULE.md, "Deliberate deviation").
 *
 * 2. The warehouse RATE CARD workbook (`NRI_Canada_Rate_Card.xlsx`): sheets
 *    "Contract Info", "Rate Card", "Validation Rules", each a plain table with its
 *    header on row 1. Columns are matched by NAME.
 */

const ExcelJS = require('exceljs');
const XLSX = require('xlsx');

const norm = (v) => (v === undefined || v === null ? '' : String(v).replace(/\s+/g, ' ').trim());
const key = (v) => norm(v).toLowerCase();

// ─── CSV ─────────────────────────────────────────────────────────────────────

/** RFC-4180 rows: quoted fields may hold commas, doubled quotes and newlines. */
function csvRows(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
            } else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(cell); rows.push(row); row = []; cell = '';
        } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
}

/** `$1,234.56` · `($5.00)` · `-$5.00` · `1234.5` → number; blank → 0. */
function money(v) {
    if (typeof v === 'number') return v;
    const s = norm(v);
    if (!s) return 0;
    const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
    const n = Number(s.replace(/[()$,\s-]/g, ''));
    if (!Number.isFinite(n)) return 0;
    return neg ? -n : n;
}

/** `09/15/2026` · `9/1/26` · `2026-09-15` · Date · Excel serial → `YYYY-MM-DD`, else null. */
function isoDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
    if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    const s = norm(v);
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
        const y = m[3].length === 2 ? `20${m[3]}` : m[3];
        return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    }
    return null;
}

// The report's columns, by header text. `Order` was renamed `OrderID` by the
// workbook's query; both spellings are accepted.
const COLUMNS = {
    orderId:    ['order', 'orderid', 'order #'],
    clientRef1: ['client ref 1'],
    clientRef2: ['client ref 2'],
    customer:   ['customer'],
    poNumber:   ['po number'],
    docDate:    ['doc. date', 'doc date'],
    completed:  ['completed'],
    units:      ['units'],
    value:      ['value'],
    service:    ['service'],
    charges:    ['charges'],
    taxes:      ['taxes'],
    invAmt:     ['inv. amt', 'inv amt', 'invoice amount'],
};
const REQUIRED = ['service', 'charges'];

function headerMap(cells) {
    const at = {};
    cells.forEach((c, i) => {
        const k = key(c);
        for (const [field, names] of Object.entries(COLUMNS)) {
            if (at[field] === undefined && names.includes(k)) at[field] = i;
        }
    });
    return REQUIRED.every((f) => at[f] !== undefined) ? at : null;
}

/**
 * Parse a report already split into rows of cells.
 * @returns {{ invoiceNo, periodEnd, reportDate, lines: object[], skipped: object }}
 */
function parseReportRows(rows) {
    let invoiceNo = null;
    let periodEnd = null;
    let reportDate = null;
    let at = null;
    let headerCount = 0;
    const lines = [];
    const skipped = { repeatedHeader: 0, blankService: 0, footer: 0 };

    for (const raw of rows) {
        const cells = raw.map(norm);
        if (!cells.some(Boolean)) continue;

        if (!at) {
            // banner: `Invoice:,,50020 ( Ending 9/15/2026 11:59:59 PM )`
            if (/^invoice:?$/i.test(cells[0])) {
                const joined = cells.slice(1).join(' ');
                const m = joined.match(/(\d+)\s*\(\s*ending\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
                if (m) { invoiceNo = m[1]; periodEnd = isoDate(m[2]); }
                else if (joined.match(/\d+/)) invoiceNo = joined.match(/\d+/)[0];
                continue;
            }
            // the report's print date sits at the end of the "Invoice Details Report" row
            if (/invoice details report/i.test(cells[0])) {
                reportDate = isoDate(cells.filter(Boolean).slice(-1)[0]);
                continue;
            }
            const h = headerMap(cells);
            if (h) { at = h; headerCount++; }
            continue;
        }

        if (headerMap(cells)) { skipped.repeatedHeader++; continue; }
        if (cells.includes('Page:')) { skipped.footer++; continue; }
        const service = cells[at.service];
        if (!service) { skipped.blankService++; continue; }
        // a repeated page header whose other cells were coerced away (the workbook's
        // combined table holds 66 of these) still names its own column
        if (/^service$/i.test(service)) { skipped.repeatedHeader++; continue; }

        const get = (f) => (at[f] === undefined ? '' : cells[at[f]]);
        lines.push({
            seq: lines.length + 1,
            orderId: get('orderId') || null,
            clientRef1: get('clientRef1') || null,
            clientRef2: get('clientRef2') || null,
            customer: get('customer') || null,
            poNumber: get('poNumber') || null,
            docDate: isoDate(get('docDate')),
            completed: isoDate(get('completed')),
            units: money(get('units')),
            value: money(get('value')),
            service,
            charges: money(get('charges')),
            taxes: money(get('taxes')),
            invAmt: money(get('invAmt')),
        });
    }

    if (!headerCount) {
        const e = new Error('No header row found — expected a row naming at least "Service" and "Charges". Is this an NRI Invoice Details Report?');
        e.status = 400;
        throw e;
    }
    return { invoiceNo, periodEnd, reportDate, lines, skipped };
}

/**
 * @param {Buffer} buffer
 * @param {string} fileName  decides CSV vs workbook
 */
function parseInvoiceReport(buffer, fileName = '') {
    if (/\.(xlsx|xlsm|xls)$/i.test(fileName)) {
        const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        return parseReportRows(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }));
    }
    return parseReportRows(csvRows(decodeText(buffer)));
}

/**
 * NRI exports its reports in WINDOWS-1252, not UTF-8 (Sept 15 2026: 352 accented
 * bytes — "Hélène", "Frédérique" — and the file is not valid UTF-8). Reading it as
 * UTF-8 turns every accent into U+FFFD, which is where the workbook's
 * "STÃ‰"-style mojibake came from. Strict UTF-8 first (a re-saved file may be
 * UTF-8), Windows-1252 otherwise.
 */
function decodeText(buffer) {
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        text = new TextDecoder('windows-1252').decode(buffer);
    }
    return text.replace(/^﻿/, '');
}

// ─── Rate card workbook ──────────────────────────────────────────────────────

function cellValue(c) {
    if (c === null || c === undefined) return null;
    if (c instanceof Date) return c.toISOString().slice(0, 10);
    if (typeof c === 'object') {
        if ('result' in c) return cellValue(c.result);
        if ('richText' in c) return c.richText.map((t) => t.text).join('');
        if ('text' in c) return c.text;
        if ('error' in c) return null;
    }
    return c;
}

function sheetObjects(ws) {
    const out = [];
    let header = null;
    ws.eachRow({ includeEmpty: false }, (row) => {
        const vals = row.values.slice(1).map(cellValue);
        if (!header) { header = vals.map(key); return; }
        const o = {};
        header.forEach((h, i) => { if (h) o[h] = vals[i] ?? null; });
        if (Object.values(o).some((v) => v !== null && v !== '')) out.push(o);
    });
    return out;
}

const findSheet = (wb, re) => wb.worksheets.find((ws) => re.test(ws.name));
const txt = (v) => (v === null || v === undefined || v === '' ? null : String(v).trim());

/**
 * @returns {{ entity, rates: object[], terms: object[] }}
 *   entity is read from the Rate Code prefix (`CA-FUL-01` → CA); `entityHint`
 *   wins only when the codes carry none.
 */
async function parseRateCard(buffer, entityHint = null) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const card = findSheet(wb, /rate\s*card/i);
    if (!card) {
        const e = new Error('No "Rate Card" sheet in this workbook.');
        e.status = 400;
        throw e;
    }

    const rateRows = sheetObjects(card).filter((r) => txt(r['rate code']));
    const prefixes = new Set(rateRows.map((r) => String(r['rate code']).split('-')[0].toUpperCase()));
    const entity = prefixes.size === 1 ? [...prefixes][0] : (entityHint || '').toUpperCase();
    if (!['US', 'CA'].includes(entity)) {
        const e = new Error(`Cannot tell which warehouse this card is for (rate code prefixes: ${[...prefixes].join(', ') || 'none'}).`);
        e.status = 400;
        throw e;
    }

    const rates = rateRows.map((r, i) => {
        const raw = r.rate;
        const isNum = typeof raw === 'number' || (raw !== null && raw !== '' && Number.isFinite(Number(raw)));
        return {
            id: String(r['rate code']).trim(),
            entity,
            section: txt(r.section),
            service: txt(r['service / charge'] ?? r.service),
            productGroup: txt(r['product group']),
            uom: txt(r.uom),
            rate: isNum ? Number(raw) : null,
            rateText: isNum ? null : txt(raw),
            currency: txt(r.currency),
            rateType: txt(r['rate type']),
            conditions: txt(r['billing basis / conditions']),
            source: txt(r.source),
            seq: i + 1,
        };
    });

    const terms = [];
    const info = findSheet(wb, /contract\s*info/i);
    if (info) {
        sheetObjects(info).forEach((r, i) => terms.push({
            id: `nct_${entity}_info_${i + 1}`, entity, kind: 'info', code: null,
            label: txt(r.field), value: txt(r.value), detail: txt(r.note),
            validationUse: null, source: null, seq: i + 1,
        }));
    }
    const rules = findSheet(wb, /validation\s*rules/i);
    if (rules) {
        sheetObjects(rules).forEach((r, i) => terms.push({
            id: `nct_${entity}_rule_${i + 1}`, entity, kind: 'rule', code: txt(r['rule code']),
            label: txt(r.topic), value: txt(r.value), detail: txt(r['rule / threshold']),
            validationUse: txt(r['validation use']), source: txt(r.source), seq: i + 1,
        }));
    }
    return { entity, rates, terms };
}

module.exports = { parseInvoiceReport, parseReportRows, parseRateCard, csvRows, decodeText, money, isoDate };
