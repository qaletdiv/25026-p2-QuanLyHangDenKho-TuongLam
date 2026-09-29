# backend — layer-first MVC

Request-handling code is grouped by **layer**, and the feature is carried in the
**filename prefix**. `mainlineBookingController.js` is unambiguous wherever you
meet it: `mainline` is the feature, `Controller` is the layer, `controllers/` is
where it lives.

```
backend/
  src/                      THE APPLICATION
    config/          2      env.js (loads .env), db.js (connection entry point)
    models/         63      THE SCHEMA AUTHORITY — one Sequelize model per table
    controllers/    30      HTTP in/out, permission keys, vendor scoping
    routes/         16      mounted in app.js — the entry points
    middlewares/     8      auth, validate, requirePermission, rateLimit, upload …
    services/       24      business rules, pure where possible, no req/res
    validators/     10      express-validator checkSchema objects + rules.js
                            (middlewares/validate.js runs them)
    lib/            27      domain logic (mainlineCiLines, nriRateCard, …)
    utils/           5      shared plumbing (vendorScope, nameKey, passwordUtils)
    app.js                  builds and EXPORTS the express app — no port, no cron
    server.js               entry point: env, db ping, cron, app.listen

  database/                 NOT under src/ — see below
  scripts/         30       maintenance CLIs (idempotent, most take --dry-run)
  storage/                  FILES, not records — see storage/README.md
  tests/                    jest + supertest
```

To trace any request: **`src/app.js` → `routes/<feature>Routes.js` →
`controllers/<feature>Controller.js` → `services/<feature>Service.js`.**

## app.js vs server.js

`app.js` builds the express app and exports it. It never binds a port and never
starts the cron scheduler — `server.js` does both. That separation is not
decoration:

- `tests/api.test.js` drives the **real** app through supertest without
  occupying port 5000. It must require `../src/app`; requiring `../src/server`
  would boot a second cron scheduler mid-test run.
- ⚠️ Every `node src/server.js` starts its OWN scheduler. Two processes = two
  SMS tracking polls, two SMS NetSuite syncs and two mainline PO syncs, i.e.
  concurrent writers against one database. Check for strays before starting one
  (the command is in CLAUDE.md's verification-harness section).

## ⚠️ `database/` is deliberately OUTSIDE `src/`

Two reasons, and both would be violated by moving it in:

1. It carries `seed-data/` (~85k rows across 61 tables). That is **data, not
   source**, and `src/` is source.
2. `src/` consumes the data layer; the data layer must never consume `src/`.
   `database/modelStore`, `database/txContext` and `database/verify` are
   reachable from `scripts/` and from `node database/init.js`, neither of which
   goes through the app.

So `src/config/db.js` is a **facade**: it is where application code asks for the
connection, while `database/sequelize.js` is where the pool, the type parsers
and the per-request transactions actually live. Read `database/README.md` before
changing anything behind it.

⚠️ **`node database/generateModels.js` OVERWRITES hand-edited models.** Measured
2026-09-28: a re-run silently stripped `cargoReadyDate`, `notes` and `priority`
from `src/models/MainlineShipments.js` — columns added after the last
`schema.json` refresh. It is a migration tool, not a build step. Do not run it
to "regenerate models" unless you have refreshed `schema.json` first and have
reviewed the diff.

## History: feature-first until 2026-09-28, then src/ + layers

The backend spent 2026-07-03 → 2026-09-28 organised the other way, as
`modules/<feature>/` holding that feature's routes, controller, service and
validator together. That layout was deliberate and it worked; it was reversed on
request, in two steps on the same day:

1. `modules/<feature>/` → flat `routes/ controllers/ services/ validators/ lib/`
   at the backend root (99 files, 272 require rewrites, 22 renames).
2. those folders → `src/`, `middleware/` → `middlewares/`, `config/` added, and
   `app.js` split out of `server.js` (183 files, 85 require rewrites) — to match
   the canonical Express MVC tree.

Both steps were verified behaviour-neutral: all 31 read endpoints byte-identical
before and after, on the same data.

**The trade-off it accepted is real, so do not treat it as settled by accident:**

- **Change locality got worse.** A booking change used to touch three files in
  one folder; it now touches three files in three folders.
- **`lib/` is the folder layering has no name for.** 27 files that are neither
  controller, service, validator nor route. Under feature-first they sat with
  their feature; here the feature has to live in the name.
- **22 files were renamed to put it back.** `statuses.js` meant "mainline
  statuses" inside `modules/mainline/` and means nothing in a shared `lib/`; it
  is now `mainlineStatuses.js`. Likewise `receiptMatch.js` → `smsReceiptMatch.js`
  (it had landed next to `mainlineReceiptMatch.js`, unprefixed), `rateCard.js` →
  `nriRateCard.js`, `resolvers.js` → `poResolvers.js`. **Keep the feature prefix
  on anything new**, or `lib/` becomes an unnavigable bag.

⚠️ **If you ever move files again, `database/generateModels.js` is the trap, and
it caught the codemod on BOTH steps.** It emits `src/models/index.js` as string
literals, three of which contain `require('../../database/…')` — paths relative
to **`src/models/`, not to `generateModels.js`**. A path codemod resolves them
against the wrong directory and rewrites them to something that looks right,
then the next `node database/generateModels.js` emits a broken index. It is the
only such file (`src/middlewares/auth.js:10` has a `require('crypto')` inside a
help string, but non-relative specifiers are never rewritten).

Before trusting any bulk require rewrite: scan for `require(` occurring inside a
string literal, and afterwards prove the generator round-trips — regenerate and
confirm the output matches the live file. ⚠️ Do that against a **copy**: a real
run overwrites hand-edited models (see the warning above).

## Validation: express-validator (Joi replaced 2026-09-28)

Every write route still reads `validate(schema)` — only the engine changed, so
no route file moved. The schemas are `checkSchema` objects, which keeps them
declarative data exactly as the Joi schemas were; `validators/rules.js` holds
the field vocabulary shared across the nine files.

⚠️ **OPTIONAL, NULLABLE and BLANKABLE are three different things**, and this is
the whole risk of the port. A differential test of the old schemas against the
new ones over 362 payloads caught **15 fields** where the first pass collapsed
them and silently widened what the API accepts:

| Joi | undefined | null | `''` | helper in rules.js |
|---|---|---|---|---|
| `.string().required()` | ✗ | ✗ | ✗ | `requiredString` |
| `.string().min(1).optional()` | ✓ | ✗ | ✗ | `optionalString` |
| `.string().allow('').optional()` | ✓ | ✗ | ✓ | `blankableString` |
| `.string().allow(null, '')` | ✓ | ✓ | ✓ | `nullableString` |
| `.number().min(0).allow(null)` | ✓ | ✓ | — | `nullableNumber` |
| `.boolean()` | ✓ | ✗ | — | `optionalBoolean` |

`optional: true` skips only `undefined`; `optional: {values:'null'}` skips
`undefined` **and** `null`. Use the second only where Joi wrote `.allow(null)`.
The mainline BOOKING status allowed `''`/null and the SHIPMENT status did not —
that asymmetry is real, not an oversight.

Two more behaviours that had to be carried over deliberately:

- **Coercion.** Joi ran with `convert: true`, so `'5'` reached controllers as
  `5`. express-validator does not coerce unless told, which is why every numeric
  rule pairs its check with `toInt`/`toFloat` and every boolean with
  `toBoolean`. Drop a sanitizer and a controller silently gets a string where it
  did arithmetic.
- **Unknown keys pass through.** Joi ran `allowUnknown: true` and several
  schemas were `.unknown(true)`; partial updates depend on it. express-validator
  only inspects the paths it is given, so this is free — but do **not** add
  `checkExact()` to "tighten" it.

`bail` is NOT a valid `checkSchema` key in express-validator 7 — it is accepted
silently and ignored. One error per field comes from
`result.array({ onlyFirstError: true })` in the middleware instead; without it a
missing required field reports three times, because `requiredString` is three
checks.

## ⚠️ mainline and SMS are still two separate datasets

They share **no transactional tables** — only reference data (suppliers,
couriers, statuses, ports…). The wall is enforced in the code: separate guards,
separate reports, separate landed-cost bases. See CLAUDE.md.

**The folders no longer mirror that wall**, which is the one thing the previous
layout gave for free. `mainlineBookingController.js` and
`smsBookingController.js` now sit adjacent in `controllers/`, and
`mainlineVendorAccess.js` beside `smsVendorAccess.js` in `lib/`. Adjacency
invites exactly the "DRY these up" change that must not happen.

Only **pure helpers** may cross. With the folders gone the check is a grep, and
it only works because every file carries its feature prefix — which is the
practical reason the renames above were not cosmetic:

```bash
# an SMS-prefixed file reaching for a mainline one, and the reverse
grep -rn "require('.*mainline" --include=*.js src/ | grep -i "/sms"
grep -rn "require('.*smsReceiptMatch\|require('.*smsService" --include=*.js src/ | grep -i "/mainline"
```

Today the only crossing is `lib/mainlineReceiptMatch.js` borrowing
`lib/smsReceiptMatch.js`'s `matchPo` — a pure function, annotated *"no SMS
writes"*. If you want to share state or a table between the two, stop.

## Models: use the registry directly

```js
const { models } = require('../models');

const rows = await models.mainline_bookings.read();   // whole table, in order
await models.mainline_bookings.write(next);           // REPLACES the table
```

⚠️ `write()` replaces the whole table — a row missing from the array is deleted.
That is what every call site already means; see `database/README.md`.

Three `*Models.js` files in `lib/` are **manifests**, not wrappers —
`LandedCostModels.js`, `NriInvoiceModels.js`, `SmsModels.js`. They are a
commented list of which tables a feature touches. Keep them, and keep them out
of `models/`: `models/index.js` skips `*Model.js` by name, which does **not**
match `*Models.js`, so it would try to call a manifest as a model factory.

## Feature docs

| doc | covers |
|---|---|
| `SCHEMA_REDESIGN.md`, `database.dbml` | the 3NF schema (authoritative) |
| `MAINLINE_MODULE_STRUCTURE.md`, `MAINLINE_BUILD_PLAN.md` | mainline |
| `SMS_MODULE_PLAN.md`, `SMS_BOOKING_BUILD_PLAN.md` | SMS |
| `NRI_INVOICE_MODULE.md` | 3PL invoice verification (`/nri-invoices`) |
| `database/README.md`, `database/QUERIES.md` | the data layer |
| `storage/README.md` | files on disk |

⚠️ Those docs predate 2026-09-28 and still spell backend paths as
`modules/<feature>/…`. The file names in them are correct; only the folder is.
