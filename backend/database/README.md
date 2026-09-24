# backend/db — the Sequelize data layer

The portal's records live in PostgreSQL, mapped by Sequelize models. Everything
above this directory is unchanged: modules still call `BaseModel.read()` /
`.write()`, still get whole arrays of plain objects, and still derive everything
else per request.

```
backend/models/*.js  ── the AUTHORITY on the schema (61 models, 75 FKs)
      │                 MVC layout: models/ beside controllers/ and routes/
      ├─► sequelize.sync()         creates the tables (database/init.js)
      │
models.po_orders.read()          models.po_orders.write(rows)
      ▼                                 ▼
modelStore.readAll    ──►  findAll({ order: [['_seq','ASC']] })  ──► decode
modelStore.replaceAll ──►  destroy({}) + bulkCreate(), in the request's txn

data/**.json ──► database/init.js ──► rows only.  SEED INPUT, nothing else.
```

`.read()` / `.write(rows)` are attached to every model by `models/index.js`.
They replaced `models/BaseModel.js` and the five `*Model.js` facades, which are
gone — along with the filename-as-table-key shim (`'migrated/po_orders.json'`).
**`write()` REPLACES the table**, so a row missing from the array is deleted.

## Files

Models live in **`backend/models/`**, not here — that is the MVC models
directory, beside `controllers/` and `routes/`. This directory is the data
*plumbing*.

| file | what it is |
|---|---|
| `../models/*.js` | **the schema authority.** One model per table, columns typed, FKs declared |
| `../models/index.js` | **generated** — loads every model, wires associations, attaches `.read()`/`.write()` |
| `seed-data/` | the JSON. `reference/`, `snapshot/`, `documents/` — see below |
| `sequelize.js` | the one Sequelize instance |
| `types.js` | the node-pg type parsers that keep values identical |
| `modelStore.js` | `readAll` / `replaceAll` / `readDocument` / `writeDocument` |
| `txContext.js` | one transaction per write request |
| `tx.js` | `atomically()` for code outside a request (cron, scripts) |
| `init.js` | create tables from the models + seed; `--export` regenerates `seed-data/` |
| `verify.js` | prove the ORM read path matches raw SQL value for value |
| `generateModels.js` | **one-time migration tool** — re-running overwrites `models/` |
| `dbml.js`, `schema.json` | frozen input to that tool; `database.dbml` stays the human-readable map |
| `QUERIES.md` | how to connect + worked example queries |

## Commands

```bash
node database/init.js --dry-run   # report what would load, write nothing
node database/init.js             # create tables from models + seed REFERENCE data
node database/init.js --all       # also load the transactional snapshot
node database/init.js --export    # REGENERATE seed-data/ from the live database
node database/verify.js           # prove the ORM path matches raw SQL (run after ORM changes)
```

## `seed-data/` — three kinds of JSON, and the difference matters

```
database/seed-data/
  reference/   20 tables ·  5,113 rows   REAL seed: statuses, couriers, modes,
                                         ports, roles, facilities, product_skus…
                                         An empty database cannot work without it.
  snapshot/    41 tables · 78,899 rows   The transactional tables. NOT seed data —
                                         a point-in-time copy. Loaded by `--all`.
  documents/    1 file                   Whole-file blobs with no row grain
                                         (notification_seen), stored in `_documents`.
```

**Every file is named after its table.** `reference/couriers.json` is the
`couriers` table — that convention replaced a filename→table registry, the last
remnant of the pre-Sequelize era. `init.js` refuses to run if a seed file names a
table no model declares.

⚠️ **Re-run `node database/init.js --export` after any column rename, and commit
the result.** These files are plain JSON with no schema of their own, so they rot
silently when the schema moves: after the 2026-09-22 camelCase rename the
checked-in files still had `courier_id` / `status_id` keys and could no longer
seed anything. Nothing catches that until someone builds a fresh database —
exactly when they need it to work.

Verified: from an empty database, `--all` loads **61 tables / 84,012 rows** with
every row count matching.

For restoring a live database, `pg_dump` is still the right tool; `snapshot/` is
a convenience copy, not a backup strategy.

## Four things that are not obvious

**`_seq` carries row order.** SQL has no inherent row order, and this codebase
depends on the array order in places it states outright: `plGenerator` takes
`rows[0]` of a carton group, the receipt matcher walks "first still-free IR", and
CLAUDE.md records a bug where reversing row order changed 25 of 34 packing
summaries. Every read is `ORDER BY _seq`; the column is stripped from what
callers get back. On the 7 tables with no natural key it is also the primary key.

**⚠️ Sequelize re-parses two types WRONGLY, and both failures are silent.**
`database/types.js` pins node-pg's parsers, but Sequelize registers its own on top.
Measured against raw pg on live rows:

| type | Sequelize gives | must be |
|---|---|---|
| `DECIMAL` (numeric) | `"57.82"` — a **string** | `57.82` |
| `DATE` (timestamptz) | a JS `Date` | ISO string |

The app is full of `(m.get(k) || 0) + (l.allocated_qty || 0)`; with strings that
is **concatenation**, so 28 + 5 becomes `"285"` and a forecast gains 250,000
units without anything throwing. `modelStore.js` decodes both back against each
model's declared attribute types. `database/verify.js` is what proves it still works —
run it after any change here.

**camelCase goes all the way down (2026-09-21).** The 218 snake_case columns
were renamed in Postgres, so an attribute IS a column, no `field:` mapping
exists, and nothing is translated at any boundary. API responses are camelCase
too, and the frontend was updated in the same pass — **0 snake_case keys remain
in any response**.

⚠️ **Identifiers are quoted from here on.** Postgres folds unquoted names to
lowercase, so `SELECT poNumber` silently becomes `ponumber` and errors. Sequelize
always quotes; hand-written SQL must too:

```sql
SELECT "poNumber" FROM po_orders;   -- correct
SELECT poNumber   FROM po_orders;   -- ERROR: column "ponumber" does not exist
```

⚠️ **There is deliberately no `snake()` helper anywhere.** Four columns in
`nri_order_master` — `orderNo`, `custCode`, `custName`, `orderType` — were
already camelCase before the rename, so a regex round-trip would "restore" them
to `order_no` and friends: columns that have never existed.

**⚠️ `deferrable` must sit INSIDE `references`.** As a sibling key Sequelize
accepts it silently and ignores it: all 79 FKs came out `condeferrable=false`,
and seeding then failed on the first child table whose parent had not loaded yet.
The FKs *must* be `DEFERRABLE INITIALLY DEFERRED`, because whole-table replace
makes a parent momentarily absent while its children still reference it.

**Whole-table replace, not diff.** `BaseModel.write()` has always been handed the
complete array, so every caller means "these rows are now the table" and a row's
absence means deleted. `writeData` keeps exactly those semantics — `destroy` then
`bulkCreate`, inside the request's transaction.

## Behaviour worth knowing

**Rows are rectangles.** A key absent from a sparse row reads `null`, not
`undefined`. Every consumer here tests these with `||`, `??` or truthiness, where
the two behave identically.

**An unknown key is refused, not dropped.** Sequelize writes only its declared
attributes, so a field with no column would vanish silently. `writeData` throws
instead, naming the model file to edit. Adding a column is a model edit now, not
a JSON edit.

**Writes are atomic.** A write request lands whole or not at all
(`txContext.js`). The ambient object is a **Sequelize `Transaction`** — it had to
move off the raw pg client when the models arrived, because Sequelize owns its
own pool and a query on a different connection would have been outside the
transaction, self-committing, with nothing throwing.

**Prefer the ORM for new code.** `BaseModel` exposes the underlying model as
`.model`, so new work can do `UserModel.model.findOne({ where: { email } })`
instead of reading a whole table into memory. The array API exists to keep 193
existing call sites working, not as the pattern to copy.

## Running it on this machine (WSL, no Docker Desktop)

Postgres is a container inside the Ubuntu WSL distro, which adds two failure
modes that look like application bugs and are not:

- **WSL's port relay goes dormant when no WSL session is open.** The distro keeps
  running and Postgres stays healthy, but from Windows every connection is
  refused. Held open by `wsl-keepalive.vbs` in the Startup folder.
- **For a few minutes after `wsl --shutdown`** the relay can keep *listening* on
  127.0.0.1:5432 while refusing every connection, so `netstat` and
  `Test-NetConnection` both say the port is fine. It settles on its own;
  `wsl -e docker restart some-postgres` re-registers it.

The backend tolerates both: it starts with a loud CANNOT CONNECT banner rather
than refusing to boot, and the pool reconnects on its own once Postgres is
reachable again — no `node server.js` restart needed.
