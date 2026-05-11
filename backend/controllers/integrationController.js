const integrationService = require('../services/integrationService');

async function getNetSuitePOs(req, res) {
    const pos = await integrationService.fetchNetSuitePOs();
    res.json(pos);
}

module.exports = { getNetSuitePOs };
