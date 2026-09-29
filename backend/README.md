# backend — layer-first MVC

Request-handling code is grouped by **layer**, and the feature is carried in the
**filename prefix**. `mainlineBookingController.js` is unambiguous wherever you
meet it: `mainline` is the feature, `Controller` is the layer, `controllers/` is
where it lives.

```
backend/
  routes/        16   mounted in server.js — the entry points
  controllers/   30   HTTP in/out, permission keys, vendor scoping
  services/      24   business rules, pure where possible, no req/res
  validators/     9   Joi schemas (middleware/validate.js applies them)
  lib/           27   domain logic (mainlineCiLines, nriRateCard, mainlineStatuses, …)
  models/        63   THE SCHEMA AUTHORITY — one Sequelize model per table
  database/           connection, per-request transactions, modelStore, verify.js
  middleware/         auth, validate, requirePermission, rateLimit, upload …
  utils/              shared plumbing (vendorScope, nameKey, passwordUtils …)
  scripts/            one-off + maintenance CLIs (idempotent, most take --dry-run)
  storage/            FILES, not records — see storage/README.md
```

To trace any request: **`server.js` → `routes/<feature>Routes.js` →
`controllers/<feature>Controller.js` → `services/<feature>Service.js`.**

## History: this was feature-first until 2026-09-28

The backend spent 2026-07-03 → 2026-09-28 organised the other way, as
`modules/<feature>/` holding that feature's routes, controller, service and
validator together. That layout was deliberate and it worked; it was reversed on
request, and the reversal was verified behaviour-neutral (all 31 read endpoints
byte-identical before and after, on the same data).

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

⚠️ **If you ever move files again, `database/generateModels.js` is the trap.** It
emits `models/index.js` as string literals, three of which contain
`require('../database/…')` — paths that are relative to **`models/`, not to
`generateModels.js`**. A path codemod resolves them against the wrong directory
and rewrites them to something that looks right and breaks the next
`node database/generateModels.js` run, silently. It is the only such file
(`middleware/auth.js:10` has a `require('crypto')` inside a help string, but
non-relative specifiers are never rewritten). Scan for the pattern before
trusting any bulk require rewrite.

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
grep -rn "require('.*mainline" --include=*.js controllers services lib routes | grep -i "/sms"
grep -rn "require('.*smsReceiptMatch\|require('.*smsService" --include=*.js controllers services lib routes | grep -i "/mainline"
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
