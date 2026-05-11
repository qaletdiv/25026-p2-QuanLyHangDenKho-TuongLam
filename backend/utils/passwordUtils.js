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
 * Verifies a plaintext password against a stored hash.
 * Supports both legacy plaintext passwords (migration path) and scrypt hashes.
 * @param {string} plaintext
 * @param {string} stored  — either "scrypt:<salt>:<hash>" or a legacy plaintext value
 * @returns {Promise<boolean>}
 */
async function verifyPassword(plaintext, stored) {
  if (!stored.startsWith('scrypt:')) {
    // Legacy plaintext comparison — supports login during migration window
    return plaintext === stored;
  }
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const [, salt, hashHex] = parts;
  return new Promise((resolve, reject) => {
    crypto.scrypt(plaintext, salt, KEY_LEN, SCRYPT_PARAMS, (err, derived) => {
      if (err) reject(err);
      else resolve(derived.toString('hex') === hashHex);
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
