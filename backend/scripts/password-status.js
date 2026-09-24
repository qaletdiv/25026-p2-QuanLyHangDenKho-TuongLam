'use strict';

// ---------------------------------------------------------------------------
// Which hash format is each account on?
//
//   node scripts/password-status.js
//
// This exists to answer one question: is it safe yet to delete the scrypt
// branch in utils/passwordUtils.js? It is safe only when `legacy scrypt` reads
// 0. Deleting it earlier is a SILENT lockout — the login route does not error,
// it answers 401 for a correct password.
//
// ⚠️ There is deliberately no "migrate" mode, because there cannot be one.
// bcrypt cannot be computed from a scrypt hash; it needs the plaintext, which
// the portal never stores. An account moves to bcrypt in exactly two ways:
//   1. its owner logs in successfully (authController re-hashes transparently)
//   2. an admin sets a new password in Settings → Users
//
// It replaces scripts/migrate-passwords.js, which hashed plaintext into
// backend/database/seed-data/users.json with `fs`. That file is now the frozen seed snapshot,
// so it would have reported a migration the live portal never received.
// ---------------------------------------------------------------------------
const path = require('path');

// ⚠️ dotenv MUST run before anything pulls in ../models: requiring a model
// loads database/sequelize, which reads DATABASE_URL at construction. Imported first,
// it silently falls back to postgres:postgres and the script dies with
// "password authentication failed".
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { models } = require('../models');
const { sequelize } = require('../database/sequelize');

const UserModel = models.users;
const { BCRYPT_ROUNDS } = require('../utils/passwordUtils');

const isBcrypt = (s) => typeof s === 'string' && /^\$2[aby]\$/.test(s);
const isScrypt = (s) => typeof s === 'string' && s.startsWith('scrypt:');

function describe(stored) {
    if (isBcrypt(stored)) {
        const cost = Number(stored.split('$')[2]);
        return cost < BCRYPT_ROUNDS
            ? `bcrypt (cost ${cost} — below current ${BCRYPT_ROUNDS}, upgrades on next login)`
            : `bcrypt (cost ${cost})`;
    }
    if (isScrypt(stored)) return 'legacy scrypt — upgrades on next login';
    return '⚠️  UNRECOGNISED — cannot be verified, this account cannot log in';
}

async function main() {
    // ORDER BY _seq, like every read in database/modelStore.js. Without it an UPDATE
    // moves the row physically and the listing reshuffles — harmless here, but
    // row order is load-bearing elsewhere in this codebase.
    const users = await UserModel.findAll({ order: [['_seq', 'ASC']], raw: true });
    const counts = { bcrypt: 0, scrypt: 0, unknown: 0 };

    for (const u of users) {
        const kind = isBcrypt(u.password) ? 'bcrypt' : isScrypt(u.password) ? 'scrypt' : 'unknown';
        counts[kind]++;
        console.log(`  ${String(u.email).padEnd(30)} ${describe(u.password)}`);
    }

    console.log(`\n${users.length} accounts — ` +
        `bcrypt ${counts.bcrypt} · legacy scrypt ${counts.scrypt} · unrecognised ${counts.unknown}`);

    if (counts.scrypt === 0 && counts.unknown === 0) {
        console.log('\nEvery account is on bcrypt. The scrypt branch in utils/passwordUtils.js');
        console.log('can now be deleted.');
    } else if (counts.scrypt > 0) {
        console.log(`\n${counts.scrypt} account(s) still on scrypt — KEEP the scrypt branch.`);
    }
}

main()
    .catch((err) => {
        console.error('\n' + err.stack);
        process.exitCode = 1;
    })
    .finally(() => sequelize.close().catch(() => {}));
