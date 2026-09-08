const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requirePermission = require('../middleware/requirePermission');
const mainlineReportController = require('../modules/mainline/reports/mainlineReportController');
const smsReportController = require('../modules/sms/reports/smsReportController');
const smsForecastController = require('../modules/sms/reports/smsForecastController');

// Authorization by the key of the PAGE that consumes each endpoint, which is not
// the same as the URL prefix: /sms/forecast is fetched by app/forecast/sms, so it
// takes `forecast`, not `reports`. Verified no page outside app/reports and
// app/forecast fetches any of these, so nav-key gating breaks no other view.
// These aggregate the whole order book across every supplier and cannot be
// vendor-scoped meaningfully — Vendor and Freight Forwarder hold neither key and
// are denied outright rather than shown a partial roll-up.

// The legacy shipment-grained GET / report died with the legacy stack
// (2026-07-03). Mainline reports below; SMS report after.
// Normalized mainline season KPI report (PO-leg-grained, full order book): every
// leg appears with stage (Awaiting Booking → Booking Pending → shipment pipeline),
// timeliness graded on actual or projected E-DEL, and a human-readable reason.
router.get('/mainline', requirePermission('reports'), asyncWrap(mainlineReportController.getMainlineReport));
// Transit-time overview: actual segment durations (CRD → received → ETD → ETA →
// E-DEL → ATA) per mode vs transit_time_standards, plus per-shipment breakdown.
router.get('/mainline/transit-times', requirePermission('reports'), asyncWrap(mainlineReportController.getTransitTimes));

// SMS season KPI report (PO-grained, full SMS order book): every sms_po appears
// with ordered/shipped/received rollups, a fulfillment KPI cascade, and HOD
// timeliness (SMS has no production schedule — HOD is the time anchor).
router.get('/sms', requirePermission('reports'), asyncWrap(smsReportController.getSmsReport));

// SMS incoming-quantity forecast: PO-grained rows (incoming = ordered − received)
// anchored on expected_received_date; the client buckets by ISO week × facility.
router.get('/sms/forecast', requirePermission('forecast'), asyncWrap(smsForecastController.getSmsForecast));

module.exports = router;
