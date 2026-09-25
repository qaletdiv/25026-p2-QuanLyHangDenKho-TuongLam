'use strict';

// ---------------------------------------------------------------------------
// Composes and dispatches change-notification email. The ONE entry point
// controllers use is `notifyChange()`.
//
// ⚠️ NOTHING HERE IS SENT FROM INSIDE THE HANDLER. Every send is registered via
// txContext.onCommitted, so it happens after the request's transaction commits
// AND after the response is flushed. Three reasons, each of which has bitten a
// codebase somewhere:
//   (1) a handler runs inside the transaction, and this portal rolls back on any
//       4xx/5xx — mail sent from the handler announces writes that never landed,
//       and an email cannot be recalled;
//   (2) a COMMIT can itself fail and become a 500 (see txContext);
//   (3) SMTP is a network round-trip to a free-tier host, and nobody should wait
//       on it to find out whether their booking saved.
//
// ⚠️ AND NOTHING HERE THROWS. `notifyChange` resolves even when the mail is
// undeliverable, the recipient list is empty or a lookup table is missing. A
// notification failing is not the write failing.
//
// SUBJECT SHAPE follows Lam's rule (2026-09-25): a status move NAMES THE NEW
// STATE, because that is the information ("Shipment SHP-5 is now In Transit");
// a field edit only says the record moved and puts the detail in the body
// ("Shipment SHP-5 updated"), because there is no single state to announce.
// When one save does both, the status wins the subject — it is the larger fact —
// and the field changes still appear in the body.
// ---------------------------------------------------------------------------

const { models } = require('../../models');
const { onCommitted } = require('../../database/txContext');
const email = require('../../services/emailService');
const { diffRecord, FIELD_SPECS } = require('./emailEvents');
const { recipientsFor } = require('./emailRecipients');

const APP_URL = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

// ── value rendering ──────────────────────────────────────────────────────────
const DASH = '—';

/** Lookup tables, loaded once per send and only when a lookup field changed. */
async function loadLookups(needed) {
  const want = new Set(needed);
  const pick = async (table, key) => {
    if (!want.has(key)) return [key, new Map()];
    const rows = await models[table].read().catch(() => []);
    return [key, new Map(rows.map((r) => [String(r.id), r.name || r.code || r.id]))];
  };
  const pairs = await Promise.all([
    pick('couriers', 'courier'),
    pick('incoterms', 'incoterm'),
    pick('suppliers', 'supplier'),
    pick('modes', 'mode'),
    pick('ports', 'port'),
    pick('container_types', 'containerType'),
  ]);
  return Object.fromEntries(pairs);
}

function renderValue(field, value, lookups) {
  if (value === null || value === undefined || value === '') return DASH;
  if (field.type === 'lookup') {
    const table = lookups[field.lookup];
    return (table && table.get(String(value))) || String(value);
  }
  if (field.type === 'money') {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(value);
  }
  if (field.type === 'date') return String(value).slice(0, 10);
  return String(value);
}

// ── message composition ──────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// `noun` is blank for a batch ("3 consignments are now Delivered" — prefixing
// that with "Shipment" reads as a typo), hence the join-and-trim rather than a
// template with fixed spaces.
const line = (...parts) => parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

function buildSubject({ noun, ref, statusTo, changes, action }) {
  if (action) return line(noun, ref, action);
  if (statusTo) return line(noun, ref, 'is now', statusTo);
  const n = changes.length;
  return line(noun, ref, `updated${n ? ` — ${n} ${n === 1 ? 'change' : 'changes'}` : ''}`);
}

function buildBody({ noun, ref, statusFrom, statusTo, changes, action, actorName, link, lookups, context }) {
  const lines = [];
  const rows = [];

  if (action) {
    lines.push(`${line(noun, ref, action)}.`);
  } else if (statusTo) {
    lines.push(`${line(noun, ref, 'moved to', statusTo)}${statusFrom ? ` (was ${statusFrom})` : ''}.`);
    rows.push({ label: 'Status', from: statusFrom || DASH, to: statusTo });
  } else {
    lines.push(`${line(noun, ref, 'was updated')}.`);
  }

  for (const c of changes) {
    rows.push({ label: c.label, from: renderValue(c, c.from, lookups), to: renderValue(c, c.to, lookups) });
  }

  const text = [
    lines.join(' '),
    '',
    ...(context || []).map((c) => `${c.label}: ${c.value}`),
    ...(context && context.length ? [''] : []),
    ...rows.map((r) => `  ${r.label}: ${r.from}  ->  ${r.to}`),
    '',
    actorName ? `Changed by ${actorName}.` : '',
    link ? `View: ${link}` : '',
    '',
    'You are receiving this because of your role in the tentree Supply Chain Portal.',
  ].filter((l) => l !== null).join('\n');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#18181b;line-height:1.5">
  <p style="margin:0 0 16px">${esc(lines.join(' '))}</p>
  ${(context || []).length ? `<p style="margin:0 0 16px;color:#52525b">${(context || []).map((c) => `<strong>${esc(c.label)}:</strong> ${esc(c.value)}`).join('<br>')}</p>` : ''}
  ${rows.length ? `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px">
    <tr style="background:#f4f4f5">
      <th align="left" style="padding:6px 12px;border:1px solid #e4e4e7;font-weight:600">Field</th>
      <th align="left" style="padding:6px 12px;border:1px solid #e4e4e7;font-weight:600">From</th>
      <th align="left" style="padding:6px 12px;border:1px solid #e4e4e7;font-weight:600">To</th>
    </tr>
    ${rows.map((r) => `<tr>
      <td style="padding:6px 12px;border:1px solid #e4e4e7">${esc(r.label)}</td>
      <td style="padding:6px 12px;border:1px solid #e4e4e7;color:#71717a">${esc(r.from)}</td>
      <td style="padding:6px 12px;border:1px solid #e4e4e7;font-weight:600">${esc(r.to)}</td>
    </tr>`).join('')}
  </table>` : ''}
  ${actorName ? `<p style="margin:0 0 16px;color:#52525b">Changed by ${esc(actorName)}.</p>` : ''}
  ${link ? `<p style="margin:0 0 24px"><a href="${esc(link)}" style="background:#18181b;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;display:inline-block">View ${esc(noun ? noun.toLowerCase() : 'in portal')}</a></p>` : ''}
  <p style="margin:0;color:#a1a1aa;font-size:12px">You are receiving this because of your role in the tentree Supply Chain Portal.</p>
</div>`;

  return { text, html };
}

// ── audit log ────────────────────────────────────────────────────────────────
// Appended with the ORM directly, not through the whole-table write() path: this
// is an append-only log, and replaceAll semantics on a growing table would be
// both wasteful and a way to lose history to a concurrent write.
async function logSend(row) {
  try {
    await models.email_notifications.create(row);
  } catch (err) {
    console.error('[email] could not record send:', err.message);
  }
}

/**
 * Report a change on a record. Safe to call unconditionally — it returns without
 * sending when nothing curated changed, when no recipient qualifies, or when
 * notifications are switched off.
 *
 * @param {object} p
 * @param {'mainline'|'sms'} p.module
 * @param {string} p.entity        key into FIELD_SPECS, e.g. 'mainline_shipment'
 * @param {string} p.entityId      record id, for the audit log
 * @param {string} p.ref           human reference — SHP-5, BKG-9, a tracking no.
 * @param {object} [p.before]      snapshot before the write
 * @param {object} [p.after]       snapshot after the write
 * @param {string} [p.statusFrom]  status NAME before, if it moved
 * @param {string} [p.statusTo]    status NAME after, if it moved
 * @param {string} [p.action]      overrides both: a described act ("cancelled")
 * @param {string|null} [p.supplierId] for vendor scoping
 * @param {object} [p.actor]       req.user
 * @param {string} [p.link]        path within the app, e.g. /mainline/shipments/5
 * @param {string} [p.noun]        override the entity's label; '' drops it entirely
 * @param {Array<{label,value}>} [p.context]  extra lines (PO numbers, supplier)
 */
async function notifyChange(p) {
  try {
    const spec = FIELD_SPECS[p.entity];
    // '' is a MEANINGFUL value here, not a missing one — a batch passes it so the
    // subject reads "3 consignments are now Delivered" instead of the ungrammatical
    // "Shipment 3 consignments is now Delivered". Hence the explicit undefined test.
    const noun = p.noun !== undefined ? p.noun : ((spec && spec.label) || 'Record');
    const changes = (p.before && p.after) ? diffRecord(p.entity, p.before, p.after) : [];
    const statusMoved = p.statusTo && p.statusTo !== p.statusFrom;

    // Nothing a recipient would act on. The common case on a save that only
    // touched uncurated fields — return silently rather than mail an empty diff.
    if (!statusMoved && !changes.length && !p.action) return;

    const type = p.entity.endsWith('booking')
      ? (statusMoved || p.action ? 'booking_status' : 'booking_updated')
      : p.entity.endsWith('shipment')
        ? (statusMoved || p.action ? 'shipment_status' : 'shipment_updated')
        : 'receipt_matched';

    const dispatch = async () => {
      const to = await recipientsFor({
        type, module: p.module, supplierId: p.supplierId || null,
        actorId: p.actor ? p.actor.id : null,
      });
      if (!to.length) return;

      const lookups = await loadLookups(changes.filter((c) => c.lookup).map((c) => c.lookup));
      const subject = buildSubject({ noun, ref: p.ref, statusTo: statusMoved ? p.statusTo : null, changes, action: p.action });
      const { text, html } = buildBody({
        noun, ref: p.ref,
        statusFrom: statusMoved ? p.statusFrom : null,
        statusTo: statusMoved ? p.statusTo : null,
        changes, action: p.action,
        actorName: p.actor ? (p.actor.name || p.actor.email) : null,
        link: p.link ? APP_URL() + p.link : null,
        lookups, context: p.context,
      });

      const result = await email.send({ to: to.map((r) => r.email), subject, text, html });
      await logSend({
        id: `em_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        eventType: type, module: p.module, entity: p.entity, entityId: String(p.entityId),
        subject, recipients: to.map((r) => r.email).join(', '),
        status: result.status, detail: result.detail || null,
        actorId: p.actor ? String(p.actor.id) : null,
        createdAt: new Date().toISOString(),
      });
    };

    // Inside a write request → after the commit. Outside one (a cron tick, a
    // maintenance script) there is no transaction to wait on, so send now.
    if (!onCommitted(dispatch)) await dispatch();
  } catch (err) {
    console.error('[email] notifyChange failed:', err && err.message);
  }
}

module.exports = { notifyChange };
