'use strict';
/**
 * One-time load of NRI billing history into the portal, so the Results page
 * covers the whole year rather than starting from the next upload.
 *
 *   node scripts/import-nri-billing-history.js <dir> [--dry-run]
 *
 * <dir> is the `nri-invoice-coder` export of `NRI CA_ALL Invoices 2026.xlsx`:
 *   data/invoices/*.csv   each invoice's lines, rebuilt from Summary_Coded
 *   data/overrides.csv    every Manual Class / GL override typed into the workbook
 *   data/orders.csv       the workbook's "NRI Order data" sheet (Order Type)
 * plus, when found beside it or in the repo root, the two rate-card workbooks
 * (NRI_USA_Rate_Card.xlsx, NRI_Canada_Rate_Card.xlsx).
 *
 * What it does, each step idempotent:
 *   1. rate cards  → nri_contract_rates / _terms (replaced per entity)
 *   2. order data  → nri_order_master, entity CA (UPSERT by order #, the same
 *                    rule as POST /nri-invoices/order-data)
 *   3. invoices    → nri_billing_files / _lines, entity CA, LOCKED — these months
 *                    are already booked, so the class rules must never recode them
 *                    (they code exactly as the workbook did: legend + overrides).
 *                    A file already held is replaced, never duplicated.
 *
 * The rebuilt CSVs carry no banner, so these files have no invoice number; they
 * are keyed by file name, which is the workbook's Source.Name.
 */

require('../src/config/env');
const fs = require('fs');
const path = require('path');
const { models, sequelize } = require('../src/models');
const { atomically } = require('../database/tx');
const { txOptions } = require('../database/txContext');
const parser = require('../src/lib/nriBillingParser');
const orderData = require('../src/lib/nriOrderData');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const DIR = args.find((a) => !a.startsWith('--'));
if (!DIR) { console.error('Usage: node scripts/import-nri-billing-history.js <nri-invoice-coder dir> [--dry-run]'); process.exit(1); }

const REPO = path.join(__dirname, '..', '..');
const norm = (v) => (v === undefined || v === null ? '' : String(v).trim());
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const slug = (s) => norm(s).replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase();

function findFile(name) {
    for (const d of [DIR, path.dirname(DIR), REPO]) {
        const p = path.join(d, name);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/** Plain CSV with a header row → objects (the coder's files are machine-written). */
function readCsv(file) {
    const rows = parser.csvRows(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const header = rows.shift().map(norm);
    return rows.filter((r) => r.some((c) => norm(c))).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

async function rateCards() {
    for (const name of ['NRI_Canada_Rate_Card.xlsx', 'NRI_USA_Rate_Card.xlsx']) {
        const p = findFile(name);
        if (!p) { console.log(`  rate card ${name}: not found — skipped`); continue; }
        const card = await parser.parseRateCard(fs.readFileSync(p));
        console.log(`  rate card ${card.entity}: ${card.rates.length} rates, ${card.terms.length} terms  (${p})`);
        if (DRY) continue;
        await models.nri_contract_rates.destroy({ where: { entity: card.entity }, ...txOptions() });
        await models.nri_contract_terms.destroy({ where: { entity: card.entity }, ...txOptions() });
        await models.nri_contract_rates.bulkCreate(card.rates, txOptions());
        await models.nri_contract_terms.bulkCreate(card.terms, txOptions());
    }
}

async function orders() {
    const p = path.join(DIR, 'data', 'orders.csv');
    if (!fs.existsSync(p)) { console.log('  order data: not found — skipped'); return; }
    const rows = await orderData.parseUploaded(fs.readFileSync(p), 'orders.csv');
    const existing = await models.nri_order_master.read();
    const byKey = new Map(existing.map((r) => [`${String(r.entity || 'US').toUpperCase()}|${String(r.orderNo || '').toUpperCase()}`, r]));
    let added = 0;
    let updated = 0;
    for (const r of rows) {
        const orderNo = norm(r.orderNo);
        if (!orderNo) continue;
        const k = `CA|${orderNo.toUpperCase()}`;
        const row = {
            entity: 'CA', orderNo,
            ref2: norm(r.ref2) || null,
            custCode: norm(r.custCode).toUpperCase() || null,
            custName: norm(r.custName).toUpperCase() || null,
            orderType: norm(r.orderType).toUpperCase() || null,
            country: norm(r.country).toUpperCase() || null,
            completed: orderData.isoDate(r.completed),
        };
        if (byKey.has(k)) { Object.assign(byKey.get(k), row); updated++; } else { byKey.set(k, row); added++; }
    }
    console.log(`  order data CA: ${rows.length} read, ${added} added, ${updated} updated`);
    if (!DRY) await models.nri_order_master.write([...byKey.values()]);
}

async function invoices() {
    const dir = path.join(DIR, 'data', 'invoices');
    const files = fs.readdirSync(dir).filter((f) => /\.csv$/i.test(f)).sort();

    const ov = new Map();
    const ovFile = path.join(DIR, 'data', 'overrides.csv');
    if (fs.existsSync(ovFile)) {
        for (const o of readCsv(ovFile)) {
            ov.set(`${o.source}|${norm(o.orderId)}|${norm(o.service)}`, {
                classOverride: norm(o.classOverride) || null,
                glOverride: norm(o.glOverride) ? Number(o.glOverride) : null,
            });
        }
    }

    let totalLines = 0;
    let totalOv = 0;
    let totalCharges = 0;
    const held = await models.nri_billing_files.findAll({ where: { entity: 'CA' }, raw: true, ...txOptions() });
    for (const fileName of files) {
        const parsed = parser.parseReportRows(parser.csvRows(fs.readFileSync(path.join(dir, fileName), 'utf8')));
        const id = held.find((h) => h.fileName === fileName)?.id || `nbf_ca_${slug(fileName)}`;
        let applied = 0;
        const lines = parsed.lines.map((l) => {
            const o = ov.get(`${fileName}|${norm(l.orderId)}|${norm(l.service)}`);
            if (o) applied++;
            return { ...l, id: `${id}_${l.seq}`, fileId: id, classOverride: o?.classOverride ?? null, glOverride: o?.glOverride ?? null };
        });
        const sum = (k) => r2(lines.reduce((s, l) => s + l[k], 0));
        const dates = lines.map((l) => l.completed).filter(Boolean).sort();
        totalLines += lines.length; totalOv += applied; totalCharges += sum('charges');
        console.log(`  ${fileName.padEnd(36)} ${String(lines.length).padStart(6)} lines  $${sum('charges').toFixed(2).padStart(10)}  ${String(applied).padStart(6)} overrides`);
        if (DRY) continue;
        await models.nri_billing_lines.destroy({ where: { fileId: id }, ...txOptions() });
        await models.nri_billing_files.destroy({ where: { id }, ...txOptions() });
        await models.nri_billing_files.create({
            id, entity: 'CA', fileName, invoiceNo: null,
            periodEnd: dates[dates.length - 1] || null, reportDate: null,
            lineCount: lines.length, charges: sum('charges'), taxes: sum('taxes'), invAmt: sum('invAmt'),
            locked: true, uploadedAt: new Date().toISOString(), uploadedBy: 'import: NRI CA_ALL Invoices 2026.xlsx',
            storedPath: null,
        }, txOptions());
        for (let i = 0; i < lines.length; i += 2000) await models.nri_billing_lines.bulkCreate(lines.slice(i, i + 2000), txOptions());
    }
    console.log(`  ── ${files.length} files, ${totalLines} lines, $${r2(totalCharges).toFixed(2)}, ${totalOv} of ${ov.size} overrides matched`);
}

async function main() {
    console.log(DRY ? 'DRY RUN — nothing is written\n' : '');
    await atomically(async () => {
        console.log('1. rate cards'); await rateCards();
        console.log('2. order data'); await orders();
        console.log('3. invoices'); await invoices();
    });
}

main()
    .then(() => sequelize.close())
    .catch(async (e) => { console.error(e); await sequelize.close(); process.exit(1); });
