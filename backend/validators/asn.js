const Joi = require('joi');

/**
 * ASN validator — POST body is empty (all data derived from the booking record).
 * Schema is intentionally permissive; it only guards against malformed payloads.
 */
const generate = Joi.object({}).unknown(true);

module.exports = { generate };
