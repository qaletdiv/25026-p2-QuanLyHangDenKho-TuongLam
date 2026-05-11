const { history: HistoryModel, historyBookings: HistoryBookingsModel } = require('../models/HistoryModel');
const { enrichBookings } = require('../services/bookingService');
const { runHistorySweep } = require('../services/cronJobs');

async function getHistory(req, res) {
    try {
        const data = await HistoryModel.read();
        res.json(data);
    } catch (e) {
        // history.json might not exist yet if no items were archived
        res.json([]);
    }
}

async function getHistoryBookings(req, res) {
    try {
        const data = await HistoryBookingsModel.read();
        const enriched = await enrichBookings(data);
        res.json(enriched);
    } catch (e) {
        res.json([]);
    }
}

async function sweep(req, res) {
    const result = await runHistorySweep();
    res.json(result);
}

module.exports = { getHistory, getHistoryBookings, sweep };
