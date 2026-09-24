'use strict';

// ---------------------------------------------------------------------------
// Password hashing — bcrypt, with scrypt still ACCEPTED on the way in.
//
// New hashes are bcrypt (`$2b$<cost>$…`). But every user in the live database
// currently carries a `scrypt:<salt>:<hash>` value from the 2026-08-12
// migration, and bcrypt cannot read those — so dropping scrypt verification
// would lock out every account, including the only Admin. Verification
// therefore understands BOTH formats, and `needsRehash()` lets the login path
// quietly upgrade an account the first time its owner signs in with the right
// password (the only moment the plaintext is available to hash).
//
// ⚠️ DO NOT DELETE THE SCRYPT BRANCH until `SELECT count(*) FROM users WHERE
// password LIKE 'scrypt:%'` is 0. Deleting it early is a silent lockout: the
// login route does not error, it just answers 401 for a correct password.
//
// Anything that is neither format fails closed — a plaintext value written back
// into the store by any path must never become a working credential again.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const bcrypt = require('bcrypt');

// Cost 12 ≈ 250ms per verify on this hardware. High enough to make offline
// cracking expensive, low enough that a login does not feel slow.
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

// Legacy scrypt parameters — read-only, used to verify existing hashes.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;

const isBcrypt = (s) => typeof s === 'string' && /^\$2[aby]\$/.test(s);
const isScrypt = (s) => typeof s === 'string' && s.startsWith('scrypt:');

/**
 * Hashes a plaintext password with bcrypt.
 * @param {string} plaintext
 * @returns {Promise<string>} `$2b$<cost>$<salt+hash>`
 */
async function hashPassword(plaintext) {
    return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

/** Verify against a legacy `scrypt:<salt>:<hash>` value. */
function verifyScrypt(plaintext, stored) {
    const parts = stored.split(':');
    if (parts.length !== 3) return Promise.resolve(false);
    const [, salt, hashHex] = parts;
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length !== KEY_LEN) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
        crypto.scrypt(plaintext, salt, KEY_LEN, SCRYPT_PARAMS, (err, derived) => {
            if (err) reject(err);
            // Constant-time compare — a plain === on hex strings leaks timing.
            else resolve(crypto.timingSafeEqual(derived, expected));
        });
    });
}

/**
 * Verifies a plaintext password against a stored hash in either format.
 * @param {string} plaintext
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
async function verifyPassword(plaintext, stored) {
    if (typeof plaintext !== 'string' || typeof stored !== 'string') return false;
    if (isBcrypt(stored)) return bcrypt.compare(plaintext, stored);
    if (isScrypt(stored)) return verifyScrypt(plaintext, stored);
    return false;   // fail closed — plaintext is never a working credential
}

/**
 * True when a VERIFIED password is stored in an old format and should be
 * re-hashed. Call only after verifyPassword() returned true — re-hashing on a
 * failed attempt would write an attacker's guess.
 * @param {string} stored
 * @returns {boolean}
 */
function needsRehash(stored) {
    if (isScrypt(stored)) return true;
    if (!isBcrypt(stored)) return true;
    // Cost was raised since this hash was written.
    return bcrypt.getRounds(stored) < BCRYPT_ROUNDS;
}

/**
 * Returns true if the stored value is not a recognised hash at all — i.e. it is
 * plaintext and cannot be verified, only replaced.
 * @param {string} stored
 * @returns {boolean}
 */
function needsMigration(stored) {
    return !isBcrypt(stored) && !isScrypt(stored);
}

module.exports = { hashPassword, verifyPassword, needsRehash, needsMigration, BCRYPT_ROUNDS };
