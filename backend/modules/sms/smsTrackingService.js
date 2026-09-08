'use strict';

// SMS tracking poll — pulls FedEx scan events for every FedEx consignment with
// a tracking number and APPENDS new rows to sms_tracking_events (immutable log,
// deduped on shipment+time+code). The displayed status stays DERIVED at read
// time (latest event via courier_status_map — see smsService.deriveStatus);
// this service never writes a status. ETA is returned to the caller only —
// never stored (derived-data rule).
//
// DHL: no credentials yet — DHL consignments keep their manual status until a
// dhlService lands; the poll simply skips them.

const M = require('./SmsModels');
const fedex = require('../../services/fedexService');
const { deriveStatus } = require('./smsService');

const norm = (s) => (s == null ? '' : String(s).trim().toLowerCase());

// Terminal statuses never change again, so there is nothing left to poll — a
// Delivered consignment is done. Exception stays active (it can still resolve).
// Keeps FedEx call volume flat as delivered-shipment history grows.
// 'sms_received' (Delivered + a NetSuite Item Receipt) is listed for completeness:
// this poll doesn't pass the receipt map to deriveStatus, so a received
// consignment reads back as Delivered here and is skipped either way.
const TERMINAL_STATUS_IDS = new Set(['sms_delivered', 'sms_received']);

// ---- pure core (unit-testable) ----------------------------------------------
// trackResults: fedexService.track() output. Returns { newEvents, perShipment }.
function foldEvents(shipments, trackResults, existingEvents) {
  const byTracking = new Map(trackResults.map((r) => [r.tracking_number, r]));
  const seen = new Set(existingEvents.map((e) => `${e.shipment_id}|${e.event_time}|${e.courier_code}`));
  let seq = existingEvents.reduce((mx, e) => Math.max(mx, +String(e.id).replace(/\D/g, '') || 0), 0);

  const newEvents = [];
  const perShipment = [];
  for (const s of shipments) {
    const r = byTracking.get(s.tracking_number);
    if (!r) continue;
    let added = 0;
    for (const e of r.events) {
      const key = `${s.id}|${e.event_time}|${e.courier_code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      newEvents.push({ id: `ste_${++seq}`, shipment_id: s.id, event_time: e.event_time, courier_code: e.courier_code, description: e.description, location: e.location });
      added++;
    }
    perShipment.push({
      shipment_id: s.id,
      tracking_number: s.tracking_number,
      events_added: added,
      latest_code: r.latest_code,
      eta: r.eta,                    // surfaced to the caller; never stored
      error: r.error || null,
    });
  }
  return { newEvents, perShipment };
}

// ---- IO entrypoint ------------------------------------------------------------
async function poll({ trackFn } = {}) {
  const [shipments, couriers, events, codeRows, statuses] = await Promise.all([
    M.shipments.read(), M.couriers.read().catch(() => []), M.trackingEvents.read().catch(() => []),
    M.courierStatusMap.read().catch(() => []), M.statuses.read().catch(() => []),
  ]);
  const fedexId = (couriers.find((c) => norm(c.name) === 'fedex') || {}).id;

  // Derive each shipment's current status (same rule as the read path) so we can
  // skip terminal ones — a Delivered consignment will never produce new scans.
  const codeMap = new Map(codeRows.map((r) => [`${r.courier_id}|${r.courier_code}`, r.status_id]));
  const statusNameById = new Map(statuses.map((s) => [s.id, s.name]));
  const eventsByShipment = events.reduce((m, e) => ((m[e.shipment_id] = m[e.shipment_id] || []).push(e), m), {});
  const isTerminal = (s) => TERMINAL_STATUS_IDS.has(deriveStatus(s, eventsByShipment, codeMap, statusNameById).status_id);

  const fedexWithTracking = shipments.filter((s) => s.courier_id === fedexId && s.tracking_number);
  const targets = fedexWithTracking.filter((s) => !isTerminal(s));
  const skipped_delivered = fedexWithTracking.length - targets.length;
  const skipped_dhl = shipments.filter((s) => s.courier_id !== fedexId && s.tracking_number).length;
  if (!targets.length) return { polled: 0, events_added: 0, skipped_delivered, skipped_non_fedex: skipped_dhl, note: 'no active FedEx consignments to poll' };

  const doTrack = trackFn || fedex.track;
  let results;
  try { results = await doTrack(targets.map((s) => s.tracking_number)); }
  catch (e) {
    const msg = e.response?.data?.errors?.[0]?.message || e.message;
    return { polled: targets.length, events_added: 0, fetch_error: msg };
  }

  const { newEvents, perShipment } = foldEvents(targets, results, events);
  if (newEvents.length) await M.trackingEvents.write([...events, ...newEvents]);

  return {
    polled: targets.length,
    events_added: newEvents.length,
    skipped_delivered,
    skipped_non_fedex: skipped_dhl,
    shipments: perShipment,
  };
}

module.exports = { poll, foldEvents };
