# backend/db — the Postgres data layer

The portal's records live in PostgreSQL. Everything above this directory is
unchanged: modules still call `BaseModel.read()` / `.write()`, still get whole
arrays of plain objects, and still derive everything else per request.

```
database.dbml ─┐
               ├─► buildSchema.js ─► schema.sql   (DDL, generated)
data/**.json ──┘                  └─► schema.json (runtime registry)

BaseModel.read('migrated/po_orders.json')
      │
      ▼
driveStorage  ──(DATA_BACKEND)──►  pgStore.readData  ──►  SELECT … ORDER BY _seq
                                   pgStore.writeData ──►  DELETE + INSERT, in a txn
```

## Files

| file | what it is |
|---|---|
| `dbml.js` | parser for the subset of DBML `database.dbml` uses |
| `buildSchema.js` | merges the dbml with the live JSON into a schema; validates every declared constraint against the data |
| `schema.sql` / `schema.json` | **generated** — do not hand-edit |
| `pool.js` | the connection pool + the type parsers that keep values identical |
| `pgStore.js` | `readData` / `writeData` |
| `txContext.js` | one transaction per write request |
| `tx.js` | `atomically()` for code outside a request (cron, scripts) |
| `migrate.js` | create the schema and load the JSON |
| `verify.js` | prove every value round-trips |
| `QUERIES.md` | how to connect + worked example queries (all verified against live data) |

## Commands

```bash
node db/migrate.js --dry-run    # report what would load, write nothing
node db/migrate.js              # create + load an empty database
node db/migrate.js --force      # ⚠ WIPE Postgres and reload from JSON
node db/verify.js               # compare every table against the JSON files
                                # (migration-day check only — see the note below)
node db/buildSchema.js          # regenerate schema.sql after editing database.dbml
```

`DATA_BACKEND=json` switches the whole app back to the files under `data/`.
Those files are a **frozen snapshot from migration day**, not a live mirror —
nothing writes to them any more — so switching back moves the portal to that
snapshot. `--force` has the same hazard, which is why a non-empty database is
refused without it.

## Three things that are not obvious

**`_seq` carries row order.** SQL has no inherent row order, and this codebase
depends on the JSON array order in places it states outright: `plGenerator` takes
`rows[0]` of a carton group, the receipt matcher walks "first still-free IR", and
CLAUDE.md records a bug where reversing row order changed 25 of 34 packing
summaries. Every read is `ORDER BY _seq`; the column is stripped from what
callers get back.

**The type parsers in `pool.js` are load-bearing.** node-pg's defaults are wrong
here in two silent ways: `date` comes back as a JS `Date` at *local* midnight
(so `"2026-05-06"` becomes `2026-05-06T07:00:00.000Z`), and `numeric` comes back
as a **string** — and the app is full of `(m.get(k) || 0) + (l.allocated_qty || 0)`,
which with strings is concatenation. Both are pinned.

**Whole-table replace, not diff.** `BaseModel.write()` has always been handed the
complete array and has always rewritten the whole file, so every caller means
"these rows are now the table" and a row's absence means deleted. `writeData`
keeps exactly those semantics — `DELETE` then `INSERT`, inside the request's
transaction.

## What changed behaviourally

**Rows are rectangles now.** A table has one column set, so a key that was absent
from a sparse JSON row reads `null` instead of `undefined`. 289 such cells appear
across 18 field paths in the API (`db/verify.js` lists them). No value changed —
verified 0 differences across all 65 tables and 32 endpoints — and every consumer
in this codebase tests these with `||`, `??` or truthiness, where `null` and
`undefined` behave identically.

**Writes are atomic.** A write request either lands whole or not at all
(`txContext.js`), which pays off the "No transactions" item in CLAUDE.md's
Postgres-migration notes. Foreign keys are `DEFERRABLE INITIALLY DEFERRED` and
checked at COMMIT — they have to be, because whole-table replace makes a parent
momentarily absent while its children still reference it.

**Constraints are enforced.** See `schema.json` `notes[]` for what the live data
could not satisfy; `migrate.js` reprints it on every run.

## `verify.js` is a migration-day check, not a health check

It diffs Postgres against the frozen snapshot, so it only reads 0 differences
right after `migrate.js`. Afterwards every legitimate write — a booking, an
upload, the 4-hourly NetSuite/FedEx crons — is a genuine difference from the
snapshot. Within hours of the cutover it reported 2,468 differences that were
entirely `po_order_lines.id` being renumbered by the mainline PO sync (which
CLAUDE.md already documents that sync as doing), while the row count, the
ordered quantities and every `(po_number, sku_code, qty, price)` tuple were
unchanged. Always look at *what* differs before concluding anything.

## Running it on this machine (WSL, no Docker Desktop)

Postgres is a container inside the Ubuntu WSL distro, which adds two failure
modes that look like application bugs and are not:

- **WSL's port relay goes dormant when no WSL session is open.** The distro
  keeps running and Postgres stays healthy, but from Windows every connection is
  refused. Held open by `wsl-keepalive.vbs` in the Startup folder.
- **For a few minutes after `wsl --shutdown`** the relay can keep *listening* on
  127.0.0.1:5432 while refusing every connection, so `netstat` and
  `Test-NetConnection` both say the port is fine. It settles on its own;
  `wsl -e docker restart some-postgres` re-registers it.

The backend tolerates both: it starts with a loud CANNOT CONNECT banner rather
than refusing to boot, and the pool reconnects on its own once Postgres is
reachable again — no `node server.js` restart needed.
