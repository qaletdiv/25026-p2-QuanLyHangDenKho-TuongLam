'use strict';

// Baseline security response headers.
//
// This is NOT a helmet replacement — it is the subset that actually applies to a JSON
// API plus static file downloads, hand-rolled to avoid a dependency. If you later want
// the full set (CSP builder, cross-origin isolation policies, etc.), install helmet
// and delete this file; nothing else depends on it.
//
// Deliberately omitted:
//   • Content-Security-Policy — this origin serves JSON and .xlsx downloads, never
//     HTML, so a CSP here protects nothing. The CSP that matters belongs on the
//     Next.js origin that actually renders markup.
//   • X-XSS-Protection — long deprecated; modern browsers ignore it, and its legacy
//     filter introduced its own vulnerabilities.

const IS_PROD = process.env.NODE_ENV === 'production';

function securityHeaders(req, res, next) {
    // Stop browsers second-guessing declared types — an .xlsx must never be sniffed
    // as HTML and executed in-origin.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Nothing here is meant to be framed.
    res.setHeader('X-Frame-Options', 'DENY');
    // Don't leak the full URL (which can carry ids) to third parties.
    res.setHeader('Referrer-Policy', 'no-referrer');
    // This origin is an API — it should never be treated as a source of scripts/styles.
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    // Legacy Adobe cross-domain policy files.
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

    // HSTS only in production and only meaningful over TLS. Sending it on plain HTTP
    // in dev would pin localhost to https:// in the browser and break local work.
    if (IS_PROD) {
        res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }

    next();
}

module.exports = securityHeaders;
