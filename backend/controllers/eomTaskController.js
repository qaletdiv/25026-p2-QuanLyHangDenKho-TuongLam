const EomTaskModel = require('../models/EomTaskModel');

async function getAll(req, res) {
    let data = await EomTaskModel.read();
    if (req.query.month) {
        data = data.filter(t => t.month === req.query.month);
    }
    res.json(data);
}

async function bulkCreate(req, res) {
    const data = await EomTaskModel.read();
    const newTasks = req.body.map(t => ({ id: Math.random().toString(36).substr(2, 9), ...t }));
    const combined = [...data, ...newTasks];
    await EomTaskModel.write(combined);
    res.status(201).json(newTasks);
}

async function update(req, res) {
    const data = await EomTaskModel.read();
    const idx = data.findIndex(s => s.id === req.params.id);
    if (idx > -1) {
        data[idx] = { ...data[idx], ...req.body };
        await EomTaskModel.write(data);
        res.json(data[idx]);
    } else {
        const err = new Error('Not found');
        err.statusCode = 404;
        throw err;
    }
}

module.exports = { getAll, bulkCreate, update };
