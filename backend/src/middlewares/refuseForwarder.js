'use strict';

// Refuses Freight Forwarders on routes their permissions would otherwise reach
// but their scope doesn't: receipt matching. Item Receipts belong to POs, and a
// forwarder never sees POs (utils/forwarderScope). They hold
// `shipment_update_status` for their own consignments' dates and status, which
// is also the key the receipt routes check — so the key alone can't tell the two
// jobs apart. A route-level 403 reveals nothing about any record.

const { FORWARDER_ROLE } = require('../utils/forwarderScope');

module.exports = function refuseForwarder(req, res, next) {
  if (req.user && req.user.role === FORWARDER_ROLE) {
    return res.status(403).json({ success: false, error: 'Receipt matching is handled by Logistics.' });
  }
  return next();
};
