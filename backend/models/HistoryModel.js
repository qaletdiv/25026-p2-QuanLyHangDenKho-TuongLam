const BaseModel = require('./BaseModel');

const history         = new BaseModel('history.json');
const historyBookings = new BaseModel('history-bookings.json');

module.exports = { history, historyBookings };
