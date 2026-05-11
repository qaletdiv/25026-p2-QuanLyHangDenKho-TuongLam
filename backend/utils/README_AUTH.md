# Password Hashing — Auth Utilities

## Password Format

Hashed passwords are stored as:

```
scrypt:<salt_hex>:<hash_hex>
```

- `salt` — 16 random bytes, hex-encoded (32 chars)
- `hash` — 64-byte scrypt-derived key, hex-encoded (128 chars)
- scrypt parameters: N=16384, r=8, p=1

Example stored value:
```
scrypt:a3f2...1c4d:9b7e...0f21
```

Any password that does **not** start with `scrypt:` is treated as legacy plaintext.

## Running the Migration Script

Migrate all plaintext passwords in `backend/data/users.json`:

```bash
# Preview what would change (no writes)
node backend/scripts/migrate-passwords.js --dry-run

# Apply migration
node backend/scripts/migrate-passwords.js
```

The script:
1. Reads `backend/data/users.json`
2. Hashes any plaintext passwords using `hashPassword()`
3. Removes the `_TODO_password` annotation fields
4. Writes the updated array back to `users.json`
5. Prints each migrated user's email and id

## Transition Period

`verifyPassword(plaintext, stored)` handles **both** formats:

- If `stored` starts with `scrypt:` — performs constant-time scrypt comparison
- Otherwise — falls back to a direct `===` equality check (legacy plaintext)

This means existing logins continue to work during the migration window. Once all passwords are migrated and verified, the legacy path becomes dead code.

## Next Step: Wire into server.js

In the login route, replace:

```js
const u = users.find(u => u.email === email && u.password === password);
```

with:

```js
const { verifyPassword } = require('./utils/passwordUtils');

const u = users.find(u => u.email === email);
if (!u || !(await verifyPassword(password, u.password))) {
  return res.status(401).json({ error: 'Invalid credentials' });
}
```

Make the route handler `async` if it isn't already.
