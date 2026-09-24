'use strict';

// Derived, role-scoped notifications. Everything here is computed from current
// state at read-time — there is NO stored notification/log (same rule as the
// rest of the portal). A per-user "seen" set (notification_seen.json) drives the
// unread badge only. When a condition resolves (booking approved, PO shipped) its
// notification simply disappears on the next derive.
//
// Each notification carries a DETERMINISTIC `key` (type:entity) so the seen-state
// stays stable across recomputes, plus `supplierId` for vendor scoping.

const { poRollups, deriveStatus } = require('../sms/smsService');

const todayIso = () => new Date().toISOString().slice(0, 10);

// ── role → which notification types, and whether scoped to the user's supplier ──
// Admin/Logistics: everything. Production: planning items. Vendor: their supplier's
// SMS + their pending bookings. Freight Forwarder: mainline unbooked-past-CRD.
const ROLE_RULES = {
  'Admin':                 { types: '*', scoped: false },
  'Logistics Coordinator': { types: '*', scoped: false },
  'Production':            { types: ['leg_unbooked_past_crd', 'sms_overdue'], scoped: false },
  'Vendor':               { types: ['sms_overdue', 'sms_overship', 'sms_tracking_exception', 'booking_pending'], scoped: true },
  'Freight Forwarder':    { types: ['leg_unbooked_past_crd'], scoped: false },
};

// ── mainline derivations ─────────────────────────────────────────────────────
function mainlineNotifications(d, today) {
  const out = [];
  const statusName = new Map(d.statuses.map((s) => [s.id, s.name]));

  // 1 — bookings awaiting approval
  for (const b of d.bookings) {
    if (statusName.get(b.bookingStatusId) !== 'Booking Pending') continue;
    out.push({
      key: `booking_pending:${b.id}`,
      type: 'booking_pending', module: 'mainline', severity: 'info',
      title: 'Booking awaiting approval',
      message: `${b.bookingNumber || `Booking ${b.id}`} is pending approval.`,
      supplierId: b.supplierId || null,
      date: b.submittedAt || null,
      link: `/mainline/bookings/${b.id}`,
    });
  }

  // 2 — PO legs past CRD with no live booking covering them. This can be dozens
  // (a whole unbooked order book), so it rolls up into ONE summary alert rather
  // than flooding the bell with a notification per leg.
  const liveBookingIds = new Set(
    d.bookings.filter((b) => !['Cancelled', 'Rejected'].includes(statusName.get(b.bookingStatusId))).map((b) => b.id),
  );
  const bookedLegIds = new Set(
    d.bookingLegs.filter((bl) => liveBookingIds.has(bl.bookingId)).map((bl) => bl.legId),
  );
  const unbooked = d.legs.filter((leg) => leg.crd && leg.crd < today && !bookedLegIds.has(leg.id));
  if (unbooked.length) {
    const earliest = unbooked.map((l) => l.crd).sort()[0];
    const sample = [...new Set(unbooked.map((l) => l.poNumber).filter(Boolean))].slice(0, 3).join(', ');
    const n = unbooked.length;
    out.push({
      key: 'leg_unbooked_past_crd:summary',
      type: 'leg_unbooked_past_crd', module: 'mainline', severity: 'warning',
      title: `${n} PO ${n === 1 ? 'leg is' : 'legs are'} past CRD & unbooked`,
      message: `${n} mainline PO ${n === 1 ? 'leg' : 'legs'} past CRD, not yet booked${sample ? ` (e.g. ${sample})` : ''}. Earliest CRD ${earliest}.`,
      supplierId: null,
      date: earliest,
      link: '/mainline/purchase-orders',
    });
  }
  return out;
}

// ── SMS derivations ──────────────────────────────────────────────────────────
function smsNotifications(d, today) {
  const out = [];
  const rollups = poRollups(d);
  const poByNumber = new Map(d.pos.map((p) => [p.poNumber, p]));

  for (const po of d.pos) {
    const ordered  = rollups.ordered.get(po.poNumber) || 0;
    const shipped  = rollups.shipped.get(po.poNumber) || 0;
    // overdue: HOD passed and not fully shipped
    if (po.hod && po.hod < today && shipped < ordered) {
      out.push({
        key: `sms_overdue:${po.poNumber}`,
        type: 'sms_overdue', module: 'sms', severity: 'warning',
        title: 'SMS PO overdue',
        message: `${po.poNumber} — HOD ${po.hod} passed, ${shipped}/${ordered} units shipped.`,
        supplierId: po.supplierId || null,
        date: po.hod,
        link: `/sms/purchase-orders/${po.poNumber}`,
      });
    }
    // overship: shipped more than ordered
    if (ordered > 0 && shipped > ordered) {
      out.push({
        key: `sms_overship:${po.poNumber}`,
        type: 'sms_overship', module: 'sms', severity: 'alert',
        title: 'SMS PO over-shipped',
        message: `${po.poNumber} — ${shipped} units shipped vs ${ordered} ordered (+${shipped - ordered}).`,
        supplierId: po.supplierId || null,
        date: null,
        link: `/sms/purchase-orders/${po.poNumber}`,
      });
    }
  }

  // tracking exceptions: a shipment whose derived courier status = "Exception"
  const supplierOfShipment = (s) => {
    const j = d.shipmentPos.find((x) => x.shipmentId === s.id);
    return j ? (poByNumber.get(j.poNumber) || {}).supplierId || null : null;
  };
  for (const s of d.shipments) {
    const st = deriveStatus(s, d.eventsByShipment, d.codeMap, d.statusNameById);
    if (st.status !== 'Exception') continue;
    out.push({
      key: `sms_tracking_exception:${s.id}`,
      type: 'sms_tracking_exception', module: 'sms', severity: 'alert',
      title: 'Courier tracking exception',
      message: `Shipment ${s.trackingNumber || s.id} reported a courier exception.`,
      supplierId: supplierOfShipment(s),
      date: s.shipDate || null,
      link: `/sms/shipments/${s.id}`,
    });
  }
  return out;
}

function deriveAll(data) {
  const today = todayIso();
  return [...mainlineNotifications(data.mainline, today), ...smsNotifications(data.sms, today)];
}

// filter a derived list for a given user (role + resolved vendor supplier id)
function filterForUser(all, { role, vendorSupplierId }) {
  const rule = ROLE_RULES[role];
  if (!rule) return [];
  let list = rule.types === '*' ? all : all.filter((n) => rule.types.includes(n.type));
  if (rule.scoped) list = list.filter((n) => n.supplierId && n.supplierId === vendorSupplierId);
  return list;
}

const SEVERITY_RANK = { alert: 0, warning: 1, info: 2 };
function sortNotifications(list) {
  return [...list].sort((a, b) =>
    (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) ||
    String(b.date || '').localeCompare(String(a.date || '')));
}

module.exports = { deriveAll, filterForUser, sortNotifications, ROLE_RULES };
