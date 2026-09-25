'use strict';

// ---------------------------------------------------------------------------
// SMTP transport for notification email. Cross-cutting: the notifications
// module composes the messages, this only puts them on the wire.
//
// FREE BY CONSTRUCTION. nodemailer is MIT-0 and nothing here is provider
// specific — the host is whatever `SMTP_HOST` names, so a Gmail App Password,
// Brevo's free tier or a Workspace relay all work without a code change.
//
// ⚠️ ONE RULE, AND IT IS THE WHOLE POINT OF THIS FILE:
//   A NOTIFICATION FAILING IS NOT THE WRITE FAILING.
// Every export here resolves. A dead SMTP host, a rejected recipient or a
// malformed address must never turn a saved booking into a 500 — the user did
// their job, the mail is our problem. Failures are logged and recorded in
// `email_notifications` with the error text, which is where you look when
// someone says they stopped getting mail.
//
// WHEN THERE IS NO SMTP CONFIG IT WRITES .eml FILES to storage/outbox/ instead
// of sending. That is the deliberate default, not a fallback for an error case:
// the whole feature is reviewable with no credentials, no provider account and
// no spend, and goes live by filling in .env. An .eml opens in any mail client,
// so you can see exactly what would have landed.
//
// ── Selecting a mode (one rule, no mode enum to get wrong) ──
//   EMAIL_NOTIFICATIONS=off   → nothing is sent or written. Explicit kill switch.
//   SMTP_HOST set             → real SMTP send.
//   neither                   → outbox.
// ---------------------------------------------------------------------------

const fs = require('node:fs/promises');
const path = require('node:path');

const OUTBOX_DIR = path.join(__dirname, '..', 'storage', 'outbox');

let _transport;          // lazily built, then reused (SMTP pooling)
let _verified = null;    // null = not yet checked, true/false = last result

/** Which of the three modes this process is in. Read per call — env can change in tests. */
function mode() {
  if (String(process.env.EMAIL_NOTIFICATIONS || '').toLowerCase() === 'off') return 'off';
  return process.env.SMTP_HOST ? 'smtp' : 'outbox';
}

function fromAddress() {
  return process.env.MAIL_FROM || process.env.SMTP_USER || 'tentree Supply Chain Portal <no-reply@localhost>';
}

function transport() {
  if (_transport) return _transport;
  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT || 587);
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // `secure` means implicit TLS, which is port 465 only. On 587 the connection
    // starts plain and upgrades via STARTTLS — setting secure:true there makes
    // the handshake hang rather than fail, which reads as "email is slow".
    secure: String(process.env.SMTP_SECURE || (port === 465)) === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    pool: true,
    maxConnections: 3,
    // Free tiers throttle hard; a hung socket must not pile up connections.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return _transport;
}

/** Filesystem-safe fragment of a subject, for the outbox filename. */
const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60).toLowerCase();

async function writeToOutbox({ to, subject, text, html }, stamp) {
  await fs.mkdir(OUTBOX_DIR, { recursive: true });
  const file = path.join(OUTBOX_DIR, `${stamp.replace(/[:.]/g, '-')}-${slug(subject) || 'message'}.eml`);
  // A real RFC-822 message so it opens in a mail client rather than being a
  // debug dump — the point of the outbox is seeing what recipients would see.
  const boundary = `----tentree-${Math.random().toString(36).slice(2)}`;
  const eml = [
    `Date: ${new Date(stamp).toUTCString()}`,
    `From: ${fromAddress()}`,
    `To: ${to.join(', ')}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  await fs.writeFile(file, eml, 'utf8');
  return file;
}

/**
 * Deliver one message. NEVER REJECTS — returns a result describing what happened.
 *
 * @returns {Promise<{status:'sent'|'outbox'|'skipped'|'failed', detail:string|null}>}
 */
async function send({ to, subject, text, html }) {
  const recipients = [...new Set((to || []).filter(Boolean))];
  if (!recipients.length) return { status: 'skipped', detail: 'no recipients' };

  const m = mode();
  if (m === 'off') return { status: 'skipped', detail: 'EMAIL_NOTIFICATIONS=off' };

  const stamp = new Date().toISOString();
  try {
    if (m === 'outbox') {
      const file = await writeToOutbox({ to: recipients, subject, text, html }, stamp);
      return { status: 'outbox', detail: path.relative(path.join(__dirname, '..'), file) };
    }
    const info = await transport().sendMail({
      from: fromAddress(), to: recipients.join(', '), subject, text, html,
    });
    return { status: 'sent', detail: info.messageId || null };
  } catch (err) {
    console.error(`[email] ${m} delivery failed for "${subject}":`, err.message);
    return { status: 'failed', detail: err.message };
  }
}

/**
 * Check the SMTP credentials without sending anything. Used by the settings
 * screen and worth running after editing .env — an auth failure otherwise only
 * shows up as mail silently not arriving.
 */
async function verify() {
  const m = mode();
  if (m !== 'smtp') return { ok: true, mode: m, detail: m === 'off' ? 'notifications disabled' : `writing to ${path.relative(path.join(__dirname, '..'), OUTBOX_DIR)}` };
  try {
    await transport().verify();
    _verified = true;
    return { ok: true, mode: 'smtp', detail: `${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587} as ${process.env.SMTP_USER || '(no auth)'}` };
  } catch (err) {
    _verified = false;
    return { ok: false, mode: 'smtp', detail: err.message };
  }
}

module.exports = { send, verify, mode, fromAddress, OUTBOX_DIR };
