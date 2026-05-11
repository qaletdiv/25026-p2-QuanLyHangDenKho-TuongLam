const BaseModel = require('./BaseModel');

const suppliers  = new BaseModel('suppliers.json');
const couriers   = new BaseModel('couriers.json');
const incoterms  = new BaseModel('incoterms.json');
const statuses   = new BaseModel('statuses.json');

module.exports = { suppliers, couriers, incoterms, statuses };
