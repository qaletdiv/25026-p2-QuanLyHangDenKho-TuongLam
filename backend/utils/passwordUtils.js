'use strict';

const crypto = require('crypto');

// Password format: "scrypt:<salt_hex>:<hash_hex>"
// Uses Node.js built-in crypto.scrypt — no external dependencies required.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;

/**
 * Hashes a plaintext password using scrypt.
 * @param {string} plaintext
 * @returns {Promise<string>} stored hash in the format "scrypt:<salt>:<hash>"
 */
async function hashPassword(plaintext) {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(plaintext, salt, KEY_LEN, SCRYPT_PARAMS, (err, derived) => {
      if (err) reject(err);
      else resolve(`scrypt:${salt}:${derived.toString('hex')}`);
    });
  });
}

/**
 * Verifies a plaintext password against a stored scrypt hash.
 *
 * The legacy plaintext-comparison branch was REMOVED once every user in
 * users.json carried a real hash (migrate-passwords.js, 2026-08-12). Anything
 * that is not a "scrypt:<salt>:<hash>" value now fails closed rather than being
 * compared literally — otherwise a plaintext value written back into the store
 * by any path would silently become a working credential again.
 *
 * @param {string} plaintext
 * @param {string} stored  — "scrypt:<salt>:<hash>"
 * @returns {Promise<boolean>}
 */
async function verifyPassword(plaintext, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt:')) return false;
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const [, salt, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== KEY_LEN) return false;
  return new Promise((resolve, reject) => {
    crypto.scrypt(plaintext, salt, KEY_LEN, SCRYPT_PARAMS, (err, derived) => {
      if (err) reject(err);
      // Constant-time compare — a plain === on hex strings leaks timing.
      else resolve(crypto.timingSafeEqual(derived, expected));
    });
  });
}

/**
 * Returns true if the stored password value is plaintext and needs to be migrated.
 * @param {string} stored
 * @returns {boolean}
 */
function needsMigration(stored) {
  return !stored.startsWith('scrypt:');
}

module.exports = { hashPassword, verifyPassword, needsMigration };
