'use strict';

/**
 * migrate-passwords.js
 *
 * Migrates plaintext passwords in backend/data/users.json to scrypt hashes.
 *
 * Usage:
 *   node backend/scripts/migrate-passwords.js           # migrate in place
 *   node backend/scripts/migrate-passwords.js --dry-run # preview only, no writes
 */

const fs = require('fs');
const path = require('path');
const { hashPassword, needsMigration } = require('../utils/passwordUtils');

const USERS_PATH = path.resolve(__dirname, '../data/users.json');
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  let raw;
  try {
    raw = fs.readFileSync(USERS_PATH, 'utf8');
  } catch (err) {
    console.error(`ERROR: Could not read ${USERS_PATH}`);
    console.error(err.message);
    process.exit(1);
  }

  let users;
  try {
    users = JSON.parse(raw);
  } catch (err) {
    console.error('ERROR: users.json is not valid JSON');
    console.error(err.message);
    process.exit(1);
  }

  if (!Array.isArray(users)) {
    console.error('ERROR: users.json must be a JSON array');
    process.exit(1);
  }

  const toMigrate = users.filter(u => u.password && needsMigration(u.password));

  if (toMigrate.length === 0) {
    console.log('All passwords are already hashed. Nothing to migrate.');
    return;
  }

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would migrate ${toMigrate.length} user(s):`);
    for (const u of toMigrate) {
      console.log(`  - ${u.email} (id: ${u.id}) — plaintext password would be hashed`);
    }
    console.log('[DRY RUN] No files were written.');
    return;
  }

  console.log(`Migrating ${toMigrate.length} user(s)...`);

  const updated = await Promise.all(
    users.map(async (u) => {
      if (!u.password || !needsMigration(u.password)) {
        return u;
      }
      const hashed = await hashPassword(u.password);
      console.log(`  Migrated: ${u.email} (id: ${u.id})`);
      // Remove the _TODO_password annotation once the real hash is in place
      const { _TODO_password, ...rest } = u;
      return { ...rest, password: hashed };
    })
  );

  try {
    fs.writeFileSync(USERS_PATH, JSON.stringify(updated, null, 2) + '\n', 'utf8');
    console.log(`\nDone. Updated ${USERS_PATH}`);
    console.log('IMPORTANT: Verify logins still work before deploying.');
  } catch (err) {
    console.error('ERROR: Failed to write users.json');
    console.error(err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
