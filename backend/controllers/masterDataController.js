const { suppliers, couriers, incoterms, statuses, warehouses, modes } = require('../models/MasterDataModel');

async function getSuppliers(req, res) {
    res.json(await suppliers.read().catch(() => []));
}
async function putSuppliers(req, res) {
    await suppliers.write(req.body);
    res.json({ success: true });
}

async function getCouriers(req, res) {
    res.json(await couriers.read().catch(() => []));
}
async function putCouriers(req, res) {
    await couriers.write(req.body);
    res.json({ success: true });
}

async function getIncoterms(req, res) {
    res.json(await incoterms.read().catch(() => []));
}
async function putIncoterms(req, res) {
    await incoterms.write(req.body);
    res.json({ success: true });
}

async function getStatuses(req, res) {
    res.json(await statuses.read().catch(() => []));
}
async function putStatuses(req, res) {
    await statuses.write(req.body);
    res.json({ success: true });
}

async function getWarehouses(req, res) {
    res.json(await warehouses.read().catch(() => []));
}
async function putWarehouses(req, res) {
    await warehouses.write(req.body);
    res.json({ success: true });
}

async function getModes(req, res) {
    res.json(await modes.read().catch(() => []));
}
async function putModes(req, res) {
    await modes.write(req.body);
    res.json({ success: true });
}

module.exports = {
    getSuppliers, putSuppliers,
    getCouriers,  putCouriers,
    getIncoterms, putIncoterms,
    getStatuses,  putStatuses,
    getWarehouses, putWarehouses,
    getModes,      putModes
};
