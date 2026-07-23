'use strict';

// mainline_bookings + mainline_booking_po_legs (M:N booking ↔ leg junction).
const BaseModel = require('../../../models/BaseModel');

const bookings = new BaseModel('migrated/mainline_bookings.json');
const bookingLegs = new BaseModel('migrated/mainline_booking_po_legs.json');

module.exports = {
  readBookings:     () => bookings.read(),
  writeBookings:    (d) => bookings.write(d),
  readBookingLegs:  () => bookingLegs.read(),
  writeBookingLegs: (d) => bookingLegs.write(d),
};
