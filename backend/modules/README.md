# backend/modules — one folder per feature

Every request-handling path in the portal lives here, grouped by **feature**,
not by layer. There is no separate `controllers/` folder — see
`backend/controllers/README.md` for why.

## The 12 features

| module | files | serves | notes |
|---|---:|---|---|
| `po/` | 7 | `/po` | PO hierarchy: masters → orders → lines |
| `mainline/` | 28 | `/mainline` | ocean/air freight via forwarder |
| `sms/` | 17 | `/sms` | small courier shipments (FedEx/DHL) |
| `landedcosts/` | 7 | `/landed-costs` | freight & duty; **writes to live NetSuite** |
| `nriinvoices/` | 14 | `/nri-invoices` | 3PL invoice verification (UI is `/invoices`) |
| `notifications/` | 2 | `/notifications` | derived, role-scoped alerts |
| `auth/` | 4 | `/login`, `/me` | login + "who am I", permissions resolved per call |
| `users/` | 3 | `/users` | |
| `roles/` | 3 | `/roles` | |
| `contacts/` | 2 | `/contacts` | |
| `freights/` | 4 | `/freights` | includes its own parser/export services |
| `masterdata/` | 3 | `/master-data` | suppliers, couriers, incoterms, statuses, modes… |

## The shape of a module

```
modules/<feature>/
    <feature>Routes.js       mounted in server.js — the entry point
    <feature>Controller.js   HTTP in/out, permission keys, vendor scoping
    <feature>Service.js      business rules, pure where possible, no req/res
    <feature>Validator.js    Joi schemas (middleware/validate.js applies them)
    <helpers>.js             domain logic (ciLines, rateCard, ataLoader, …)
```

**The layer is the filename suffix, not the folder.** `mainlineBookingController.js`
says what it is wherever you meet it. Larger modules add a sub-folder per
sub-domain — `mainline/` has `bookings/`, `ci/`, `shipments/`, `receipts/`,
`legs/`, `packing/`, `asn/`, `fulfillment/`, `reports/`.

To trace any request: **`server.js` → `<feature>Routes.js` → `<feature>Controller.js`
→ `<feature>Service.js`.**

## ⚠️ mainline and SMS are separate on purpose

They are two datasets that share **no transactional tables** — only reference
data (suppliers, couriers, statuses, ports…). The separation is enforced in the
code, not just the folders: separate guards, separate reports, separate
landed-cost bases.

Measured today: **0** imports from `sms/` into `mainline/`, and exactly **1** the
other way — `mainlineReceiptMatch.js` borrows `sms/receiptMatch.matchPo`, a pure
function, annotated *"no SMS writes"*.

That is the rule: **only pure helpers may cross.** If you find yourself wanting
to share state or a table between the two, that is the signal to stop — see the
landed-cost and SMS notes in `CLAUDE.md`.

## What is NOT in here

| folder | holds | why not a module |
|---|---|---|
| `models/` | 61 Sequelize models | the schema is one shared thing; see `database/README.md` |
| `database/` | connection, transactions, store, seed-data | infrastructure |
| `routes/` | `reports`, `forecast`, `notifications`, `documents` | span **several** modules, so they belong to none |
| `services/` | `integrationService`, `ciGenerator`, `plGenerator`, `ciParser`, `cronJobs`, `asnService`, `fedexService`, `wipParser` | cross-cutting or shared by mainline **and** SMS |
| `utils/`, `middleware/` | vendorScope, auth, validate, rateLimit… | shared plumbing |

A service moves *into* a module when it has exactly one consumer — that is why
`freightExportService` / `freightParserService` sit in `freights/`.
`asnService`, `fedexService` and `wipParser` each currently have one consumer
too and are candidates for the same treatment.

## Models: use the registry directly

Modules do **not** wrap tables any more. The 12 thin `*Model.js` aliases were
deleted on 2026-09-22 — they were leftovers from the pre-Sequelize `BaseModel`
era and did nothing but rename `.read()`:

```js
const { models } = require('../../models');

const rows = await models.mainline_bookings.read();   // whole table, in order
await models.mainline_bookings.write(next);           // REPLACES the table
```

⚠️ `write()` replaces the whole table — a row missing from the array is deleted.
That is what every call site already means; see `database/README.md`.

Three `*Models.js` files survive deliberately — `landedcosts/LandedCostModels.js`,
`nriinvoices/NriInvoiceModels.js`, `sms/SmsModels.js`. They are **manifests**,
not wrappers: a commented, module-local list of which tables that feature
touches. Keep them.
