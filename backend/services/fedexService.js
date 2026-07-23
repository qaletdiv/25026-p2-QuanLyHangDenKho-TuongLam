'use strict';

// FedEx Track API client — OAuth 2.0 client-credentials + batched tracking.
// Docs: frontend/FedEx_API_Tracking_ETA_Instructions.txt +
// https://developer.fedex.com/api/en-us/catalog/track/v1/docs.html
//
// Env (backend/.env): FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET, FEDEX_IS_SANDBOX.
// Sandbox and production differ only by host. Max 30 tracking numbers per call —
// track() batches transparently. Degrades gracefully: missing credentials or an
// API error returns [] / throws to the caller's catch, never crashes the poll.

const axios = require('axios');
const crypto = require('crypto');

const BASE = () => (String(process.env.FEDEX_IS_SANDBOX).toLowerCase() === 'true'
  ? 'https://apis-sandbox.fedex.com'
  : 'https://apis.fedex.com');

let _token = null;           // { value, expiresAt }
async function _getToken() {
  if (_token && Date.now() < _token.expiresAt - 60_000) return _token.value;
  const res = await axios.post(`${BASE()}/oauth/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.FEDEX_CLIENT_ID,
      client_secret: process.env.FEDEX_CLIENT_SECRET,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  _token = { value: res.data.access_token, expiresAt: Date.now() + (Number(res.data.expires_in) || 3600) * 1000 };
  return _token.value;
}

const configured = () => Boolean(process.env.FEDEX_CLIENT_ID && process.env.FEDEX_CLIENT_SECRET);

/**
 * Track up to any number of tracking numbers (batched ≤30 per request).
 * Returns one entry per tracking number:
 *   { tracking_number, events: [{ event_time, courier_code, description, location }],
 *     eta: { begins, ends } | null, latest_code }
 * Unknown/invalid numbers come back with events: [] and error set.
 */
async function track(trackingNumbers) {
  if (!configured()) { console.warn('[FedEx] credentials not configured — skipping'); return []; }
  const unique = [...new Set(trackingNumbers.filter(Boolean))];
  const out = [];
  for (let i = 0; i < unique.length; i += 30) {
    const batch = unique.slice(i, i + 30);
    const token = await _getToken();
    const res = await axios.post(`${BASE()}/track/v1/trackingnumbers`, {
      includeDetailedScans: true,
      trackingInfo: batch.map((trackingNumber) => ({ trackingNumberInfo: { trackingNumber } })),
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-customer-transaction-id': crypto.randomUUID(),
        'x-locale': 'en_US',
      },
    });

    for (const ctr of res.data?.output?.completeTrackResults || []) {
      const tr = (ctr.trackResults || [])[0] || {};
      const scans = (tr.scanEvents || []).map((e) => ({
        event_time: e.date || null,
        courier_code: e.eventType || e.derivedStatusCode || '',
        description: e.eventDescription || e.derivedStatus || null,
        location: [e.scanLocation?.city, e.scanLocation?.stateOrProvinceCode, e.scanLocation?.countryCode]
          .filter(Boolean).join(', ') || null,
      })).filter((e) => e.event_time && e.courier_code);
      const win = tr.estimatedDeliveryTimeWindow?.window;
      out.push({
        tracking_number: ctr.trackingNumber,
        events: scans,
        eta: win?.begins || win?.ends ? { begins: win.begins || null, ends: win.ends || null } : null,
        latest_code: tr.latestStatusDetail?.derivedCode || tr.latestStatusDetail?.code || null,
        error: tr.error ? (tr.error.message || tr.error.code) : null,
      });
    }
  }
  return out;
}

module.exports = { track, configured, _getToken };
