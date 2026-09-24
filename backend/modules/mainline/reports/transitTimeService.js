'use strict';

// Transit-time model for the mainline reports. The door-to-received journey is
// partitioned into five segments; standard days per (mode, segment) live in
// migrated/transit_time_standards.json (3NF master data). Actual durations are
// DERIVED from shipment dates at read-time — never stored (per the derived-data rule).
//
// Two consumers:
//   • the season KPI report — projects an E-DEL for unbooked legs (CRD + Σ standards)
//     and names the slipped segment when a shipped leg runs late;
//   • GET /reports/mainline/transit-times — the actual-vs-standard overview.

const { models } = require('../../../models');

// Ordered journey segments. `from`/`to` name shipment date fields; the first
// segment starts at the leg's CRD (earliest across the shipment's legs).
const SEGMENTS = [
  { key: 'productionHandover', label: 'CRD → Received',        from: 'crd',                 to: 'cargoReceivedDate' },
  { key: 'originDwell',        label: 'Received → Depart',     from: 'cargoReceivedDate', to: 'etdPol' },
  { key: 'portToPort',        label: 'Port → Port',           from: 'etdPol',             to: 'etaPod' },
  { key: 'destinationLeg',     label: 'Port → DC',             from: 'etaPod',             to: 'eDel' },
  { key: 'receiving',           label: 'DC → NetSuite Receive', from: 'eDel',               to: 'ata' },
];
// CRD → E-DEL (what a projection needs; `receiving` is the E-DEL → ATA tail).
const PRE_DELIVERY = SEGMENTS.slice(0, 4).map((s) => s.key);

const MS_DAY = 86400000;

function daysBetween(from, to) {
  if (!from || !to) return null;
  const a = new Date(from), b = new Date(to);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.round((b - a) / MS_DAY);
}

function addDays(dateStr, n) {
  if (!dateStr || n == null) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function getStandards() {
  return models.transit_time_standards.read().catch(() => []);
}

// rows → Map<modeId, { segment: days }>
function standardsByMode(rows) {
  const m = new Map();
  rows.forEach((r) => {
    if (!m.has(r.modeId)) m.set(r.modeId, {});
    m.get(r.modeId)[r.segment] = Number(r.days);
  });
  return m;
}

// Σ standard days CRD → E-DEL for a mode (null when the mode has no standards).
function standardPreDeliveryDays(modeId, stdByMode) {
  const std = stdByMode.get(modeId);
  if (!std) return null;
  let total = 0;
  for (const seg of PRE_DELIVERY) {
    if (std[seg] == null) return null;
    total += std[seg];
  }
  return total;
}

// Earliest achievable E-DEL for an unbooked leg: CRD + standard transit.
function projectedEDel(crd, modeId, stdByMode) {
  return addDays(crd, standardPreDeliveryDays(modeId, stdByMode));
}

// Per-segment actual durations for one shipment. `crd` is the earliest leg CRD.
function segmentDurations(shipment, crd) {
  const dates = { ...shipment, crd };
  const out = {};
  SEGMENTS.forEach((s) => { out[s.key] = daysBetween(dates[s.from], dates[s.to]); });
  return out;
}

// Segments that ran over their standard, worst first.
function slippedSegments(durations, modeId, stdByMode) {
  const std = stdByMode.get(modeId) || {};
  return SEGMENTS
    .map((s) => ({ segment: s.key, label: s.label, actual: durations[s.key], standard: std[s.key] ?? null }))
    .filter((s) => s.actual != null && s.standard != null && s.actual > s.standard)
    .map((s) => ({ ...s, over: s.actual - s.standard }))
    .sort((a, b) => b.over - a.over);
}

module.exports = {
  SEGMENTS, PRE_DELIVERY, daysBetween, addDays,
  getStandards, standardsByMode, standardPreDeliveryDays, projectedEDel,
  segmentDurations, slippedSegments,
};
