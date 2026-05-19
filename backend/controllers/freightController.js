'use strict';

const crypto = require('crypto');
const FreightModel = require('../models/FreightModel');
const { parseTemplate, generateTemplate } = require('../services/freightParserService');
const { generateFreightXlsx }             = require('../services/freightExportService');

/** GET /freights/template  — download blank rate template */
function downloadTemplate(req, res) {
    const buffer = generateTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="freight_rate_template.xlsx"');
    res.send(buffer);
}

/** POST /freights/parse  (multipart: file .xlsx/.xls/.csv, forwarder?, region?, quote_ref?, effective_date?, expiry_date?) */
async function parse(req, res) {
    if (!req.file) {
        const err = new Error('No file uploaded');
        err.statusCode = 400;
        throw err;
    }

    const forwarder      = (req.body.forwarder      || '').trim();
    const region         = (req.body.region         || '').trim();
    const quote_ref      = (req.body.quote_ref      || '').trim() || null;
    const effective_date = (req.body.effective_date || '').trim() || null;
    const expiry_date    = (req.body.expiry_date    || '').trim() || null;

    const { rates } = parseTemplate(req.file.buffer);

    const record = {
        id:             crypto.randomUUID(),
        forwarder:      forwarder || 'Unknown',
        region:         region    || 'Unknown',
        quote_ref,
        effective_date,
        expiry_date,
        rates,
        file_name:      req.file.originalname,
        parsed_at:      new Date().toISOString(),
    };

    const records = await FreightModel.read();
    records.push(record);
    await FreightModel.write(records);

    res.status(201).json(record);
}

/** GET /freights  — list all saved records (rates stripped for brevity) */
async function getAll(req, res) {
    const records = await FreightModel.read();
    const list = records.map(({ rates, ...meta }) => ({
        ...meta,
        rate_count: Array.isArray(rates) ? rates.length : 0,
    }));
    res.json(list.reverse());
}

/** GET /freights/:id  — full record with rates */
async function getOne(req, res) {
    const records = await FreightModel.read();
    const record  = records.find(r => r.id === req.params.id);
    if (!record) {
        const err = new Error('Freight record not found');
        err.statusCode = 404;
        throw err;
    }
    res.json(record);
}

/** GET /freights/:id/export  — generate xlsx and return file_url */
async function exportXlsx(req, res) {
    const records = await FreightModel.read();
    const record  = records.find(r => r.id === req.params.id);
    if (!record) {
        const err = new Error('Freight record not found');
        err.statusCode = 404;
        throw err;
    }
    const file_url = generateFreightXlsx(record);
    res.json({ file_url });
}

/** DELETE /freights/:id */
async function remove(req, res) {
    let records = await FreightModel.read();
    if (!records.some(r => r.id === req.params.id)) {
        const err = new Error('Freight record not found');
        err.statusCode = 404;
        throw err;
    }
    records = records.filter(r => r.id !== req.params.id);
    await FreightModel.write(records);
    res.status(204).send();
}

module.exports = { downloadTemplate, parse, getAll, getOne, exportXlsx, remove };
