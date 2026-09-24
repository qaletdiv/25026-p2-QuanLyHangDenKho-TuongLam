const { models } = require('../../models');
const ContactModel = models.contacts;

async function getAll(req, res) {
    res.json(await ContactModel.read());
}

module.exports = { getAll };
