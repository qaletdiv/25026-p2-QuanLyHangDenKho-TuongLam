'use strict';
// Environment configuration — the ONE place .env is loaded.
//
// ⚠️ Require this FIRST, before anything that reads process.env at module load
// (middlewares/auth.js throws at load if JWT_SECRET is unset, config/db.js builds
// a connection string). app.js and server.js both do; requiring it twice is safe
// because dotenv never overwrites a variable that is already set.
//
// The file lives at the BACKEND ROOT, not in src/ — it is deployment config, and
// scripts/ and database/ (both outside src/) load the same one.
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '..', '.env');
require('dotenv').config({ path: ENV_PATH });

const int = (v, fallback) => {
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? fallback : n;
};

module.exports = {
    ENV_PATH,
    NODE_ENV: process.env.NODE_ENV || 'development',
    isProduction: process.env.NODE_ENV === 'production',
    PORT: int(process.env.PORT, 5000),

    // Allowlist, not '*'. Nothing in the app is a browser→backend call any more:
    // the Next.js server does every API fetch server-side and file downloads go
    // through its /api/documents handler. This exists for local tooling and any
    // future first-party browser client; an unlisted origin just gets no CORS
    // headers. Comma-separated in .env.
    CORS_ORIGINS: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
        .split(',').map((s) => s.trim()).filter(Boolean),

    // Login is the one unauthenticated write, so it is the only endpoint where an
    // attacker can guess indefinitely. Keyed per IP, in-process (counters reset on
    // restart and are NOT shared across instances — behind a reverse proxy set
    // `trust proxy` or the limit becomes global).
    LOGIN_RATE_LIMIT: { windowMs: 15 * 60 * 1000, max: 10 },
};
