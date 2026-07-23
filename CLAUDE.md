# tentree Supply Chain Portal — Agent Context

## ⚠️ ARCHITECTURE: two normalized modules, legacy stack DELETED (read first)

The portal is **two fully separate datasets/modules** on a normalized (3NF) schema:
**mainline** (ocean/air freight via forwarder) and **SMS** (small courier shipments
via FedEx/DHL). The old legacy stack (`/purchase-orders`, `/bookings`, `/shipments`
routes, flat `bookings.json`/`shipments.json`/`purchase-orders.json`, drawer-era
frontend trees) was **DELETED at the 2026-07-03 cutover** — do not reference it.
`purchase-orders.json` survives as a FROZEN snapshot read only by `/forecast`
(see "Known debt" below).

- **Design docs (source of truth):** `backend/database.dbml` (mainline + SMS table
  families), `backend/SCHEMA_REDESIGN.md`, `backend/MAINLINE_MODULE_STRUCTURE.md`,
  `backend/MAINLINE_BUILD_PLAN.md`, `backend/SMS_MODULE_PLAN.md` (SMS schema,
  phases 1–7 all ✅, open items).
- **Data:** `backend/data/migrated/*.json` = the normalized tables (mainline +
  sms + shared reference data). Legacy master data still in `backend/data/*.json`
  (suppliers, couriers, warehouses, modes, incoterms, users, roles, contacts).
  **NEVER re-run `migrate-to-normalized.js`** (regenerates from deleted legacy
  files → wipes live data). `scripts/migrate-sms.js` is standalone + idempotent.
- **No transactional tables are shared** between mainline and SMS. Shared =
  reference/master data only: suppliers, seasons, warehouse_facilities,
  allocation_channels, statuses (module column), couriers, product_skus, ports,
  container_types, transit_time_standards, production_schedules.

## MAINLINE module

- **PO identity hierarchy:** `po_masters (TRN)` → `po_orders (po_number)` →
  `mainline_po_legs` (NK `po_number+mode+crd`). Two ingestion sources: the
  mainline **NetSuite Sync** (`POST /po/sync/netsuite`, `modules/po/netsuiteSync*`,
  Admin; button ACTIVE in PoLegsTable, reactivated 2026-07-07) bootstraps the PO
  hierarchy (masters/orders/order_lines, `type:'mainline'` so SMS `smm` POs are
  excluded; R1 protects booked orders); the **WIP import** creates the air/sea
  `mainline_po_legs` (NS sync never creates legs — POs stay `forecast` lifecycle
  until WIP splits them). Ingestion rules R1 (protect-if-booked) /
  R2 (flag-on-conflict) / R3 (WIP-overwrites-legs).
- **Bookings key on `leg_id`** (leg-only; forecast POs unbookable). Guards:
  G1 same-supplier, G2 overbooking (409 + `force_overbook`), G3 same-consignment
  (one destination facility + one mode; `mainlineBookingService.checkSameConsignment`).
- **Shipment grain = (booking, facility, mode)** — ONE physical conveyance:
  `mainline_shipments` header (shared dates/BL/ports/status/financials, edited
  once) + `mainline_shipment_legs` junction (`lot_number`/`expected_quantity`).
  COO/CRD are per-leg, joined at read. **Actual ATA** = manual entry (NetSuite
  later); **expected ATA = e_del + 5, derived never stored**. `checkChronology`
  guard rejects out-of-order dates on update.
- **Backend:** `modules/po/*` (routes `/po`) + `modules/mainline/*` (routes
  `/mainline/{wip-import,bookings,shipments,fulfillment,bookings/:id/ci|packing|
  shipment-data|documents,shipments/:id/asn}`).
- **Table filters (bookings/shipments, both modules):** a shared
  `components/SeasonScopeFilter` gives every lifecycle table a Season dropdown
  (defaults to the current/newest season) + an Active/All scope toggle that hides
  DONE records by default. Records are never deleted — this is a default VIEW, not
  an access rule (vendors are still server-scoped to their supplier; they just
  switch the dropdown to see other seasons/completed). `season` is DERIVED at read
  (record → PO → master → season code). "Done" sets: mainline booking =
  Approved/Cancelled/Rejected (active = Pending); mainline shipment =
  Received/Delivered/Cancelled; SMS shipment = Delivered (Exception stays active).
- **Frontend:** `src/modules/mainline/*` + `app/mainline/*`. Sidebar Purchase
  Orders / Bookings / Shipments → `/mainline/*`. Root `/` → `/mainline/purchase-orders`.
- **Derived, never stored:** PO lifecycle (forecast/split), fulfillment three-way
  match, packing summary, PO logistics dates, expected ATA, CI matched/unmatched
  tallies (computed from `mainline_ci_line_items` per read).
- **Reports are PO-LEG grained (full order book):** `GET /reports/mainline`
  iterates ALL legs; qty splits into mutually-exclusive rows (shipment /
  pending-booking / "Awaiting Booking" remainder) so totals reconcile. Axes:
  `stage` (why), `timeliness` (graded on best-known E-DEL; `date_basis`
  actual|projected; unbooked legs grade the LATER of stated E-DEL vs
  `crd + Σ transit_time_standards`), `kpi_status` cascade, human `reason`.
  `GET /reports/mainline/transit-times` = lane table (supplier × COO × departure
  port × mode) of segment durations vs standards (+ CRD→ATA total; negatives =
  out-of-order dates are excluded + flagged). Frontend: `app/reports/mainline/*`
  (per-channel KPI donuts, Stage×Timeliness pivot, side-by-side WS/EC tables,
  TransitTimes, Copy-as-table buttons for slides). `/reports` redirects here.
  Production schedule (per-season On Time/At Risk cutoffs) is EDITABLE master
  data: Settings → Production Schedule (`/master-data/production-schedules` +
  POST `/master-data/seasons` to pre-create next season).

## SMS module (courier shipments)

- **Workflow:** NO booking step — the VENDOR enters each shipment after handing
  boxes to the courier (PO(s) + units/cartons, one tracking number + courier);
  1 PO ships as 2–3 lots; status comes from courier tracking; receiving
  reconciles against NetSuite Item Receipts. HOD (`custbody8`) = the SMS "CRD".
- **Own dataset:** `sms_pos`/`sms_po_lines` (NetSuite-owned, wholesale upsert) +
  `sms_shipments` (one consignment = one tracking number) + `sms_shipment_pos`
  junction (a FedEx box MAY carry multiple POs; `lot_number` counts per PO;
  vendor-entered `units`+`cartons` live HERE — no SKU shipment lines) +
  `sms_tracking_events` (append-only) + `courier_status_map` (carrier code →
  status as DATA) + `sms_item_receipts`/`_lines` (portal-owned confirmation:
  `matched_shipment_id`/`confirmed_by/at` — NS re-sync never touches it).
- **Backend `modules/sms/*` (routes `/sms`):** POs read-only; shipments CRUD
  with vendor scope (a Vendor may only ship POs whose supplier matches their
  account — server-enforced), per-PO lot auto-increment, overship 409 +
  `force_overship`; receipts + derived auto-match suggestion (qty → date →
  sequence) + confirm; `POST /sms/sync/netsuite` (Admin; `custbody_tt_po_type`
  ='smm' POs + Item Receipts — field map in SMS_MODULE_PLAN.md);
  `POST /sms/tracking/poll` + 4h cron → FedEx Track API
  (`services/fedexService.js`, creds in backend/.env, batches ≤30).
- **Frontend:** `src/modules/sms/*` + `app/sms/{purchase-orders,shipments,
  receiving}`. Sidebar: SMS Purchase Orders / SMS Shipments / SMS Receiving.
  PO list defaults to the newest season with open POs. Status derived: latest
  courier event via courier_status_map, else `manual_status_id`
  (`status_source` says which). DHL = manual status until credentials exist.
- **NetSuite auth (sandbox 4297852-sb1):** TBA; the token's ROLE needs
  REST Web Services=Full (+ SuiteAnalytics Workbook) AND the account-level
  REST Web Services feature — user-record edits do NOT work. Changing the
  user's role assignment INVALIDATES existing tokens.

## Notifications (derived, role-scoped)

- **No stored log** — notifications are DERIVED from current state per request
  (`backend/modules/notifications/*`, routes `/notifications` + `/notifications/seen`).
  Each has a deterministic `key` (type:entity); a tiny per-user
  `notification_seen.json` (pruned to active keys) drives the unread badge only.
  A resolved condition (booking approved, PO shipped) makes its notification
  vanish on the next derive.
- **Types (all derivable now):** `booking_pending`, `leg_unbooked_past_crd`
  (rolled up into ONE summary — can be dozens), `sms_overdue`, `sms_overship`,
  `sms_tracking_exception`. Schedule-based mainline Late/At-Risk grading deferred.
- **Role → types matrix** (`ROLE_RULES` in notificationService): Admin/Logistics =
  all; Production = `leg_unbooked_past_crd` + `sms_overdue`; Vendor = SMS types +
  `booking_pending` **scoped to their supplier** (resolved via users→suppliers);
  Freight Forwarder = `leg_unbooked_past_crd`. Except Admin, each role sees only
  its slice.
- **Frontend:** top-bar bell (`components/layout/NotificationBell.tsx`) — polls 60s
  for the badge, popover lists items with entity links, opening marks-seen.

## Landed Costs module (freight & duty — SMS; NetSuite push preview-only)

- **Additive & isolated:** `modules/landedcosts/*` (routes `/landed-costs`),
  frontend `src/modules/landed-costs/*` + `app/landed-costs` + Settings page
  `app/settings/landed-costs`. Reads the SMS dataset READ-ONLY; writes ONLY its
  own two tables (`landed_cost_rates`, `landed_costs`). No sms_*/mainline_* rows
  are mutated — the rest of the app is untouched.
- **Derivation:** SMS basis = commercial-invoice value = Σ(pcs × unit_price)
  over `sms_packing_cartons`. `freight = CI × freight_pct`, `duty = CI × duty_pct`
  (rates editable in Settings → Landed Cost Rates; seeded SMS 40% / 25%).
  **Per-PO split** = CI-value share, largest-remainder to cents so parts sum
  EXACTLY to the whole (`landedCostService.splitByValue`). All derived at read.
- **Posting:** `POST /landed-costs/sms/:id/post` snapshots the estimate into
  `landed_costs` (invoice_value + rate + freight/duty). **Estimate is final** —
  a later courier bill does NOT change it. Re-post blocked (409) until unposted
  (`DELETE /landed-costs/:id`). Posting requires uploaded shipping data (needs CI
  value). Permission `landed_costs` (Admin + Logistics). Month-end view groups by
  ship month, bulk "Post all pending", Copy per-PO split as TSV for NetSuite entry.
- **NetSuite push (Phase 2 — PREVIEW-ONLY on production):** target = **Item
  Receipt**, ONE per PO (`modules/landedcosts/netsuiteLandedCost.js`). Field map:
  `memo`=PO number; `custbody_tt_customs_entry_number`= tracking # (SMS) / customs
  entry # (mainline); `custbody16` (shipping method)= courier (SMS) / Sea|Air by
  PO mode (mainline); landed-cost tab `landedcostmethod`='VALUE',
  `landedcostamount2`=duty, `landedcostamount5`=freight (per-PO split amounts).
  `GET /landed-costs/sms/:id/netsuite-preview` returns the exact payloads and
  SENDS NOTHING — surfaced via a "Preview NetSuite" dialog in the Landed Costs
  tab (no push button in the UI). The live write `POST …/netsuite-push` is
  GUARDED OFF: returns 403 unless `LANDED_COST_NS_PUSH=enabled` (arm in SANDBOX
  only) AND the caller supplies Item-Receipt internal ids (auto-resolution from
  synced receipts still TODO — `sms_item_receipts` currently empty). The write
  reuses `integrationService.buildOAuthHeader` (TBA/OAuth1). **On PRODUCTION the
  flag stays unset — nothing posts.**
- **Still deferred:** mainline actual-entry UI (the `landed_costs` table +
  service are already module-agnostic — `module:'mainline'` rows are manual
  actuals, no rate) + auto-resolving Item-Receipt ids; `landed_cost_pending`
  month-end notification.

## Known debt / deferred

- `/forecast` (mainline) now runs on LIVE migrated data via
  `modules/mainline/reports/mainlineForecastController.js` (leg-grained weekly
  inbound × facility; shipment legs by E-DEL, unshipped remainder projected onto
  leg E-DEL, cartons from confirmed packing). Same `/forecast` endpoint + output
  contract → UI unchanged. The frozen `controllers/reportController.js` is now
  UNUSED (kept on disk; `purchase-orders.json` snapshot no longer read anywhere).
  `/reports/sms` + `/reports/sms/forecast` built. DHL tracking pending credentials.
- Component-level permission checks still use hardcoded role names in some
  detail components (sidebar page-access is permission-driven via `can()`).
- EOM tasks route (`/eom-tasks`) is mounted but its page/data were removed long ago.
- ✅ RESOLVED (2026-07-07): `mainline_ci_line_items` is now DERIVED at read-time
  from `mainline_packing_cartons`, not stored (`modules/mainline/ci/ciLines.js`;
  qty = Σ pcs_per_ctn, weight/cbm = Σ, matched_leg_id = the carton's leg). All
  three consumers (CI view `mainlineCiController`, fulfillment three-way match,
  ASN `mainlineAsnController`) derive it; the shipment-data upload no longer writes
  it; the dead manual CI upsert route (`POST /bookings/:id/ci`) was removed. Fold
  verified neutral (stored vs derived → byte-identical CI + fulfillment). Mirrors
  how SMS derives CI lines from `sms_packing_cartons`. The orphaned
  `mainline_ci_line_items.json` is no longer read — safe to delete.

### Postgres migration notes (known JSON-stack limitations — fix AT migration, not before)

- **No transactions:** multi-file writes (booking approve → shipments + legs;
  shipment-data upload → 5 files; SMS shipment → header + junction) are
  sequential; crash mid-way = partial state. → DB transactions.
- **ID generation races:** `Math.max(id)+1` patterns collide under concurrency.
  → SERIAL/IDENTITY.
- **`mainline/statuses.js` in-memory cache** never invalidated after a
  statuses.json edit (restart required). → drop cache.
- **`.catch(() => [])`** read paths treat I/O errors as empty tables. → let DB
  errors propagate.
- **`force_overbook`/`force_overship`** bypass G2 by design (client shows the
  warning dialog) — intentional, documented so it isn't "found" again.
- Row-level invariants to enforce with triggers: a PO is mainline XOR SMS
  (table membership); `(po_number, lot_number)` unique in `sms_shipment_pos`.

## Project Layout

```
backend/                     Express API, JSON data files (data/ + data/migrated/)
  modules/po/                mainline PO hierarchy (WIP-sourced; NS sync dormant)
  modules/mainline/          bookings, shipments, ci/packing/asn, fulfillment, reports, wip import
  modules/sms/               SMS module (own dataset) + NetSuite sync + FedEx poll
  services/                  integrationService (SuiteQL), fedexService, ciParser,
                             wipParser, asnService, ci/plGenerator, cronJobs (SMS poll)
  controllers/               auth, users, roles, masterData, contacts, freights,
                             eomTasks, reportController (frozen /forecast only)
frontend/tentree-scportal/   Next.js RSC app (shadcn/ui, Tailwind)
  src/modules/mainline/      mainline types/actions/components (DataTable, ColumnPicker,
                             ConfirmDialog, RouteFallbacks are generic — SMS reuses them)
  src/modules/sms/           SMS types/actions/components
  src/app/{mainline,sms,reports,settings,forecast,freights,contacts,login}
```

## Conventions

- **Validation:** every write route has a Joi schema (`middleware/validate.js`);
  business guards live in controllers/services. Dates validated as real ISO
  calendar dates (see `smsValidators`/`mainlineShipmentValidator` isoDate).
- **3NF discipline:** ids not names in rows; names joined at read-time; derived
  values (totals, statuses, rollups, reconciliation) computed per request,
  never written. `database.dbml` is authoritative — keep it in sync.
- **Tables (frontend):** `bg-card` table bg, `bg-card/80` headers, `border-border`
  rows, `hover:bg-muted/30`; DataTable gives search/sort/pagination/column-picker
  (localStorage via `storageKey`) — reuse it.
- **Radix Select gotcha:** `<SelectValue>` can't derive a label when options
  load async / value set programmatically — render the label directly in
  `<SelectTrigger>` (fixed in mainline booking dropdowns + SMS receiving).
- **Destructive/consequential actions** get a ConfirmDialog (delete booking/
  shipment, approve booking).
- **Master data endpoints:** `/master-data/{suppliers,couriers,incoterms,statuses,
  warehouses,modes}` (RW), `/master-data/{warehouse-facilities,allocation-channels,
  ports,container-types}` (RO), `/master-data/production-schedules` (RW) +
  `POST /master-data/seasons`. Settings pages under `/settings/*`. Always guard
  fetches: `Array.isArray(data) ? data : []`.

## Auth / Users / Roles

- `backend/utils/passwordUtils.js` — scrypt (`scrypt:<salt>:<hash>`); legacy
  plaintext still verifies. Default admin `admin@tentree.com` / `password123`
  (replace before deployment). JWT carries `{id, email, role}`; vendor supplier
  scoping resolves via users.json → suppliers.json at request time.
- `/users` + `/roles` CRUD (Admin); login injects `permissions[]` into the
  session; Sidebar filters via `can()`. Permission changes apply at next login.
- Valid roles: Admin, Logistics Coordinator, Production, Vendor (vendors carry
  `supplier` linking to a suppliers name).

## Verification harness (reusable)

Playwright: `playwright-core` + chromium at
`…/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe`; scratch
project at `%TEMP%/pwtest-cols`. **Drive the GUI via `http://localhost:3000`,
NOT `127.0.0.1`** (HMR websocket rejects it — React never hydrates). Login via
the real form (`admin@tentree.com`/`password123`); backend needs a manual
restart after code changes (`node server.js`, port 5000 — no hot reload).

## Agent File Ownership

| Agent    | Owns                                          | Never touches |
|----------|-----------------------------------------------|---------------|
| frontend | `frontend/tentree-scportal/src/`              | `backend/`    |
| backend  | `backend/server.js`, `backend/modules/`, `backend/services/`, `backend/data/` | `frontend/` |
| qa       | Read-only — no writes                         | —             |
