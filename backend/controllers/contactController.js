const ContactModel = require('../models/ContactModel');

async function getAll(req, res) {
    res.json(await ContactModel.read());
}

module.exports = { getAll };
