'use strict';

// GET  /notifications        → derived, role-scoped notifications + unread count
// POST /notifications/seen   → mark the caller's current active notifications read
//
// Notifications are DERIVED per request (notificationService). The only stored
// state is a per-user set of "seen" keys (notification_seen.json), used solely to
// compute the unread badge; it's pruned to currently-active keys on every write.

const BaseModel = require('../../models/BaseModel');
const svc = require('./notificationService');
const { resolveVendorSupplierId } = require('../../utils/vendorScope');

const readM = (f) => new BaseModel(`migrated/${f}.json`).read().catch(() => []);   // normalized tables
const read  = (f) => new BaseModel(`${f}.json`).read().catch(() => []);            // legacy master data (data/ root)
const SeenModel = new BaseModel('notification_seen.json');

// Resolve a Vendor's supplier_id (utils/vendorScope — one copy, was four).
// Read path, so onUnlinked:'deny' → the NO_SUPPLIER sentinel matches no row and
// the bell renders empty, rather than 403-ing the whole top bar.
const vendorSupplierId = (user) => resolveVendorSupplierId(user, { onUnlinked: 'deny' });

async function loadData() {
  const [legs, legLines, orders, masters, bookings, bookingLegs, statuses, suppliers,
         pos, poLines, shipments, shipmentPos, trackingEvents, receipts, receiptLines, packingCartons, codeRows] =
    await Promise.all([
      readM('mainline_po_legs'), readM('mainline_po_leg_lines'), readM('po_orders'), readM('po_masters'),
      readM('mainline_bookings'), readM('mainline_booking_po_legs'), readM('statuses'), read('suppliers'),
      readM('sms_pos'), readM('sms_po_lines'), readM('sms_shipments'), readM('sms_shipment_pos'),
      readM('sms_tracking_events'), readM('sms_item_receipts'), readM('sms_item_receipt_lines'),
      readM('sms_packing_cartons'), readM('courier_status_map'),
    ]);
  return {
    mainline: { legs, legLines, orders, masters, bookings, bookingLegs, statuses, suppliers },
    sms: {
      pos, poLines, shipments, shipmentPos, packingCartons, receipts, receiptLines,
      codeMap: new Map(codeRows.map((r) => [`${r.courier_id}|${r.courier_code}`, r.status_id])),
      statusNameById: new Map(statuses.map((s) => [s.id, s.name])),
      eventsByShipment: trackingEvents.reduce((m, e) => ((m[e.shipment_id] = m[e.shipment_id] || []).push(e), m), {}),
    },
  };
}

async function myNotifications(user) {
  const [data, vendorSid] = await Promise.all([loadData(), vendorSupplierId(user)]);
  const all = svc.deriveAll(data);
  return svc.sortNotifications(svc.filterForUser(all, { role: user.role, vendorSupplierId: vendorSid }));
}

async function list(req, res) {
  const notifications = await myNotifications(req.user);
  const seenMap = await SeenModel.read().catch(() => ({}));
  const seen = new Set(seenMap[req.user.id] || []);
  const withRead = notifications.map((n) => ({ ...n, unread: !seen.has(n.key) }));
  res.json({ notifications: withRead, unread_count: withRead.filter((n) => n.unread).length });
}

async function markSeen(req, res) {
  const notifications = await myNotifications(req.user);
  const activeKeys = notifications.map((n) => n.key);
  const seenMap = await SeenModel.read().catch(() => ({}));
  // store exactly the currently-active keys (prune resolved ones) so a NEW
  // notification later shows as unread again
  seenMap[req.user.id] = activeKeys;
  await SeenModel.write(seenMap);
  res.json({ ok: true, unread_count: 0 });
}

module.exports = { list, markSeen };
