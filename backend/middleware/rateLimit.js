'use strict';

// Fixed-window rate limiter, in memory.
//
// WHY NOT express-rate-limit: it would be a new dependency for ~40 lines of logic,
// and its default store is also in-process memory — so for this deployment shape it
// buys nothing this doesn't. If the API ever runs multiple instances, replace this
// with a shared store (Redis) rather than raising the limit; see the caveat below.
//
// KNOWN LIMITATIONS, deliberate and documented rather than hidden:
//   • Per-process. Counters reset on restart and are NOT shared across instances.
//     Adequate here: one Node process, JSON files on disk.
//   • Keyed on req.ip. Behind a reverse proxy Express reports the PROXY's address
//     unless `app.set('trust proxy', ...)` is configured, which would bucket every
//     user together. Set that when deploying behind nginx/ALB, or the limit becomes
//     global instead of per-client.
//   • Fixed window, not sliding: up to `max` requests can land at the very end of one
//     window and `max` more at the start of the next. Fine for slowing credential
//     stuffing; not a precise quota.

const WINDOWS = new Map();   // key → { count, resetAt }

// Sweep expired buckets so the Map can't grow without bound from one-off IPs.
// unref() so this timer never holds the process open (it would hang `jest`).
const SWEEP_MS = 60_000;
const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of WINDOWS) if (v.resetAt <= now) WINDOWS.delete(k);
}, SWEEP_MS);
if (typeof sweeper.unref === 'function') sweeper.unref();

/**
 * @param {object}   opts
 * @param {number}   opts.windowMs  window length in ms
 * @param {number}   opts.max       allowed requests per window per key
 * @param {string}   [opts.message] response message on limit
 * @param {(req)=>string} [opts.keyFn] bucket key (default: client ip)
 * @returns {import('express').RequestHandler}
 */
function rateLimit({ windowMs, max, message, keyFn }) {
    const msg = message || 'Too many requests — please try again later.';
    const getKey = keyFn || ((req) => req.ip || req.socket?.remoteAddress || 'unknown');

    return function limiter(req, res, next) {
        const key = getKey(req);
        const now = Date.now();
        let bucket = WINDOWS.get(key);

        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            WINDOWS.set(key, bucket);
        }

        bucket.count += 1;
        const remaining = Math.max(0, max - bucket.count);
        res.setHeader('RateLimit-Limit', String(max));
        res.setHeader('RateLimit-Remaining', String(remaining));
        res.setHeader('RateLimit-Reset', String(Math.ceil((bucket.resetAt - now) / 1000)));

        if (bucket.count > max) {
            res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
            return res.status(429).json({ success: false, error: msg });
        }
        return next();
    };
}

/** Test-only: drop all counters so one test's attempts don't limit the next. */
rateLimit._reset = () => WINDOWS.clear();

module.exports = rateLimit;
