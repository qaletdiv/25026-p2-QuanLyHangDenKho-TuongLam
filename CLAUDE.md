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
  COO/CRD are per-leg, joined at read. **expected ATA = e_del + 5, derived never
  stored**. `checkChronology` guard rejects out-of-order dates on update.
- **Actual ATA is DERIVED from NetSuite Item Receipts, in every consumer**
  (2026-09-02). `receipts/ataLoader.js` wraps the shared resolver
  (`receipts/mainlineReceiptMatch.ataByShipment` — confirmed → quantity →
  sequence, LATEST of the shipment's PO receipt dates, null unless EVERY PO
  landed) and `effectiveAta()` holds the ONE precedence rule: **attributed
  receipt date wins, the typed `ata` column is the fallback**, `ata_source`
  says which. `mainlineShipmentService` had derived it since the receipt-match
  work, but the three REPORT endpoints still read the raw column — a manual
  stopgap set on **1 of 9** live shipments — so: `DC → NetSuite Receive` and
  `CRD → ATA` were blank on 8 received consignments in the transit report; the
  KPI cascade called them `Delivered`/`Late` instead of `Received` (2 rows →
  17, 1,555 → 42,935 units); and `/forecast` still projected 41,380 already-
  warehoused units as incoming. Fixing all three moved **only** `ata` /
  `ata_source` / `kpi_status` / `reason` — row ids, `stage`, `timeliness` and
  the 264,948-unit grand total are byte-identical, and the units that left the
  forecast equal the units newly recognised as received (41,380, both sides).
  ⚠️ `mainlineReceiptMatch.js:50` must keep reading the RAW column (its
  `ship_date` sort key) or matcher → ATA → matcher closes a loop.
  Still raw-column readers, deliberately untouched: `poController` (PO detail
  display) and `landedCostController` (`ship_date`/`ship_month`, which groups
  posted finance snapshots).
- **Backend:** `modules/po/*` (routes `/po`) + `modules/mainline/*` (routes
  `/mainline/{wip-import,bookings,shipments,fulfillment,bookings/:id/ci|packing|
  shipment-data|documents,shipments/:id/asn,legs/:legId/shipments}`).
- **PO leg → its consignments (2026-09-01):** `GET /mainline/legs/:legId/shipments`
  feeds a Shipments (lot) section on the PO leg detail — the mainline answer to the
  SMS PO detail's lot table. **Leg-grained, never TRN-grained**: on a TRN one
  shipment recurs under each leg it carries and quantities double-count (live data
  has shipments 2–9 each carrying two legs). Columns Lot / Carrier Shipment # /
  CRD (actual) / Shipped Qty / Shipped Cartons / Status. Three decisions worth
  keeping: **(1)** qty + cartons are the SHIPPED ACTUALS off the shipping-data upload
  (`mainline_packing_cartons`: Σ `pcs_per_ctn`, COUNT DISTINCT `ctn_number` — the same
  derivation `ciLines.js` uses, so the PO view and the CI quote one number), NOT the
  booked `expected_quantity`; NULL not 0 when nothing is uploaded. The packing table
  has no `shipment_id`, but keying on (booking, leg) is lossless BY CONSTRUCTION — a
  leg has one facility and one mode, and shipment grain is (booking, facility, mode),
  so within a booking a leg rides exactly one shipment (0 ambiguous pairs of 17).
  **(2)** `carrier_reference` renders BLANK when unset (4/9 populated) — no fallback to
  BL or SHP-N, which would read as a forwarder ref; the LOT cell carries the link
  instead so the row stays navigable. **(3)** the shipment's `cargo_received_date` is
  labelled **CRD (actual)** and the leg's `crd` on the same page became **CRD (target)** —
  they differ on 15 of 17 live rows, so one bare "CRD" on one screen was two dates.
- **Table filters (bookings/shipments, both modules):** a shared
  `components/SeasonScopeFilter` gives every lifecycle table a Season dropdown
  (defaults to the current/newest season) + an Active/All scope toggle that hides
  DONE records by default. Records are never deleted — this is a default VIEW, not
  an access rule (vendors are still server-scoped to their supplier; they just
  switch the dropdown to see other seasons/completed). `season` is DERIVED at read
  (record → PO → master → season code). "Done" sets: mainline booking =
  Approved/Cancelled/Rejected (active = Pending); mainline shipment =
  Received/Delivered/Cancelled; SMS shipment = Delivered/Received (Exception stays
  active).
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

- **Workflow:** booking is OPTIONAL (was "no booking step" until 2026-08-07). The
  default path is still vendor-entered: the VENDOR enters each shipment after
  handing boxes to the courier (PO(s) + units/cartons, one tracking number +
  courier); 1 PO ships as 2–3 lots; status comes from courier tracking; receiving
  reconciles against NetSuite Item Receipts. HOD (`custbody8`) = the SMS "CRD".
  A consignment planned up front instead goes through `sms_bookings` (below) —
  those clear customs formally and carry ACTUAL freight/duty.
- **Bookings (OPTIONAL, 2026-08-07):** `sms_bookings` + `sms_booking_pos` junction
  (keys on `po_number`+`lot_number` — SMS has NO legs, `sms_pos` IS the bookable
  grain). Vendor submits → Logistics approves; **approve creates one DRAFT shipment
  per destination facility** (`tracking_number` NULL until the box ships — the
  duplicate-tracking check is null-exempt). **The booking STATES `courier_id` +
  `mode_id`** (both required, independent — Ceva runs sea AND air) and approve copies
  them onto the draft; before 2026-08-24 neither existed and approve hardcoded
  `couriers.find(/fedex/i)`, so every booked consignment claimed FedEx and posted to
  NetSuite as COURIER. Guards: G1 one supplier, G2 soft
  overbooking (409 + `force_overbook`), G3 one destination facility (mode is not a
  grouping key — the booking states ONE mode for the whole consignment), plus a HARD lot-not-double-booked check
  (a controller guard, NOT an index: a Cancelled/Rejected booking must leave the
  lot re-bookable). `cancel` is the way out of an approved booking — it deletes the
  untracked drafts and 409s once anything shipped. Booked vs shipped units are
  derived (booking junction vs shipment junction), never stored.
- **Own dataset:** `sms_pos`/`sms_po_lines` (NetSuite-owned, wholesale upsert) +
  `sms_shipments` (one consignment = one tracking number; nullable `booking_id` +
  `customs_entry_number`/`freight`/`duty` for booked ones) + `sms_shipment_pos`
  junction (a FedEx box MAY carry multiple POs; `lot_number` counts per PO;
  vendor-entered `units`+`cartons` live HERE — no SKU shipment lines) +
  `sms_tracking_events` (append-only) + `courier_status_map` (carrier code →
  status as DATA) + `sms_item_receipts`/`_lines` (portal-owned confirmation:
  `matched_shipment_id`/`confirmed_by/at` — NS re-sync never touches it).
- **Backend `modules/sms/*` (routes `/sms`):** bookings CRUD +
  `/bookings/:id/{approve,reject,cancel}` (`smsBookingController` +
  `smsBookingService` pure guards); POs read-only; shipments CRUD
  with vendor scope (a Vendor may only ship POs whose supplier matches their
  account — server-enforced), per-PO lot auto-increment, overship 409 +
  `force_overship`; receipts + derived auto-match suggestion (qty → date →
  sequence) + confirm; `POST /sms/sync/netsuite` (Admin; `custbody_tt_po_type`
  ='smm' POs + Item Receipts — field map in SMS_MODULE_PLAN.md);
  `POST /sms/tracking/poll` + 4h cron → FedEx Track API
  (`services/fedexService.js`, creds in backend/.env, batches ≤30).
- **Frontend:** `src/modules/sms/*` + `app/sms/{purchase-orders,bookings,shipments}`.
  SMS shares the sidebar's Purchase Orders / **Bookings** / Shipments entries with
  mainline via the `ModuleTabs` strip (`PO_TABS`/`BOOKING_TABS`/`SHIPMENT_TABS`) —
  SMS bookings reuse the existing `bookings` permission, no new key. The shipment
  detail grows a Booking cell, a mainline-shaped `Landed Cost — Freight & Duty`
  block (inline Edit/Save; booked only), and Booked-vs-Shipped columns.
  PO list defaults to the newest season with open POs. Status derived: latest
  courier event via courier_status_map, else `manual_status_id`
  (`status_source` says which). DHL = manual status until credentials exist.
- **Supplier on the SMS forms is a VIEW FILTER, never a visibility control**
  (2026-08-24). Both SMS entry forms are destination-first (mainline's booking form
  is supplier-first — the mirror image; each funnels on one guard and validates the
  other reactively). Every destination holds ~14 suppliers, so staff got them all
  interleaved and only learned of a G1 clash at submit. Now: an optional supplier
  dropdown on the PO-table toolbar, **rendered only when the chosen destination
  holds >1 supplier — which is never the vendor case**, since `/sms/pos` is already
  vendor-scoped server-side (`smsPoController._ctx`). Two rules encoded there:
  **(1)** `selected` reads the UNFILTERED list, so narrowing the view can never
  silently drop units already typed into a row the filter hides; **(2)** filter on
  `supplier_id`, NEVER the name — the name comparison this replaced matched 0 POs
  for the live vendor ("Best Star Fashions Co Ltd" vs "Best Star Fashions Co., Ltd.").
  The BOOKING form additionally **locks** other suppliers' rows once one supplier has
  units (G1 becomes unexpressible rather than rejected at submit; `supplierClash`
  stays as a dead-man guard). The SHIPMENT form deliberately does NOT lock — a
  courier box may legitimately span suppliers and there is no same-supplier guard
  server-side either, which is exactly why `vendorAccess` uses `every` not `some`.
  Mainline's supplier dropdown now auto-selects when there is only one bookable
  supplier (the vendor case — it was a mandatory one-option click); derived as
  `effectiveSupplierId`, not a `useEffect`, which would trip `set-state-in-effect`.
- **Delivered → Received (2026-08-13):** the courier scale ends at `Delivered`
  (box handed over / dropped off). `sms_received` ("Received") is one step
  further and means **NetSuite has an Item Receipt** — the warehouse booked the
  goods in. DERIVED per read like every other status: a Delivered consignment
  escalates when EVERY PO in the box has a **human-CONFIRMED** IR attributed to
  that lot (`receiptMatch.receivedByShipment` computes the confirmed → quantity →
  sequence attribution the Landed Costs page exposes; `smsService.deriveStatus`
  then requires `confirmed`, so a match fixed there moves the status too).
  `status_source:'netsuite'`, plus derived `received_date` / `received_irs` /
  `received_confirmed`. Three deliberate limits:
  **(1) confirmation is required** (2026-08-19) — quantity/sequence matches are
  SUGGESTIONS, and Received is a DONE state that drops the row out of the active
  view, so a guess would bury a discrepancy (real case: shipment 36 / PO04818 ↔
  IR65720 matched positionally with 218 received vs 222 shipped). This also makes
  "Received" mean exactly "postable" — the landed-cost push already refuses
  unconfirmed matches. An unconfirmed candidate is still surfaced on the payload
  and the shipment detail shows an amber "confirm this match" card.
  **(2) only Delivered escalates** — an IR on an In-Transit box means the tracking
  or the match is wrong, and hiding it in a DONE state would bury that.
  **(3) 'Received' is never hand-settable** (the write route rejects the name; the
  UI dropdown offers `SMS_MANUAL_STATUSES`) because it asserts a receipt exists.
  Consequence to know: a DHL/manual consignment sitting at In Transit will not flip
  even when its IR lands — set it Delivered first.
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

## Landed Costs module (freight & duty — SMS; Post WRITES to live NetSuite)

- **Additive & isolated:** `modules/landedcosts/*` (routes `/landed-costs`),
  frontend `src/modules/landed-costs/*` + `app/landed-costs` + Settings page
  `app/settings/landed-costs`. Reads the SMS dataset READ-ONLY; writes ONLY its
  own two tables (`landed_cost_rates`, `landed_costs`). No sms_*/mainline_* rows
  are mutated — the rest of the app is untouched.
- **Derivation:** SMS basis = commercial-invoice value = Σ(pcs × unit_price)
  over `sms_packing_cartons`. `freight = CI × freight_pct`, `duty = CI × duty_pct`
  (rates editable in Settings → Landed Cost Rates; seeded SMS 40% / 25%).
- **BASIS split (2026-08-07):** a **BOOKED** SMS consignment behaves like mainline —
  freight/duty are ACTUALS off the broker bill, typed on the shipment, **no rate, no
  estimate**; an **unbooked** one keeps the CI × rate estimate. Which basis a posted
  row used is DERIVABLE from the snapshot (`freight_pct` NULL ⟺ actual), so there is
  no `basis` column. Grain is unchanged — landed cost keys on the SHIPMENT, never
  the booking: one consignment = one customs entry, so a booking spanning 3 tracking
  numbers = 3 `landed_costs` rows. A booked shipment with no bill yet reads
  **Awaiting actual** and posting 422s (it would post $0). The NS push now prefers a
  real `customs_entry_number` and only falls back to `"<courier> <tracking>"`.
  **Per-PO split** = CI-value share, largest-remainder to cents so parts sum
  EXACTLY to the whole (`landedCostService.splitByValue`). All derived at read.
- **⚠️ Posting COMMITS TO NETSUITE — it is not a local snapshot** (opened
  deliberately in `59e7433`; confirmed intended 2026-08-14). `POST
  /landed-costs/sms/:id/post` **PATCHes the matched Item Receipt(s) on the LIVE
  NetSuite account FIRST**, and only snapshots into `landed_costs` if that write
  succeeded — so `posted ⟺ pushed`, by design (`landedCostController.postSms`).
  Pre-flight gates, all of which must pass or nothing is sent: uploaded shipping
  data (needs the CI value); a booked consignment needs its actual freight/duty
  typed (422 `awaiting_actual`); **every PO must have a CONFIRMED Item-Receipt
  match** (422 unresolved / 422 unconfirmed); not already posted (409 — unpost via
  `DELETE /landed-costs/:id`). Snapshot is final: a later courier bill does NOT
  change it. Permission `landed_costs` (**Admin + Logistics** — not Admin-only).
  Month-end view groups by ship month; Copy per-PO split as TSV.
- **The arm switch is ON in this deployment.** `LANDED_COST_NS_PUSH=enabled` and
  `LANDED_COST_PUSH_ALLOWLIST` is **EMPTY, which means ALL shipments are
  allowed** (`push_allowed` short-circuits to true on an empty list) — put
  shipment ids in that var to narrow it. `NETSUITE_ACCOUNT_ID=4297852` is
  **PRODUCTION** (sandbox is `4297852-sb1`), so the PATCH goes to
  `https://4297852.suitetalk.api.netsuite.com/...`. Unsetting the flag does NOT
  merely disable pushing — `pushToNetsuite` 403s, so **posting stops entirely**
  and month-end blocks; split push from post before disarming. No cron pushes and
  there is no bulk endpoint: every write is one human clicking Post on one
  shipment. The separate `POST …/netsuite-push` route is `requireAdmin`.
- **Push mechanics:** target = **Item Receipt**, ONE per PO
  (`modules/landedcosts/netsuiteLandedCost.js`), auth via
  `integrationService.buildOAuthHeader` (TBA/OAuth1). Field map: `memo`=PO number;
  `custbody_tt_customs_entry_number`= customs entry # else `"<courier>
  <tracking>"` (SMS) / customs entry # (mainline); `custbody16` (shipping method)=
  **mapped from the shipment's MODE in both modules** (`ns.shipMethodId`: Sea→1,
  Air→2, Courier→6), with SMS falling back to COURIER when `mode_id` is null — which
  is every vendor-entered parcel, so the unbooked flow is unchanged. It was
  unconditionally COURIER for SMS until 2026-08-24; correct while SMS was courier
  -only, wrong once bookings introduced Ceva sea/air consignments. `sms_shipments
  .mode_id` is set at booking-approve and correctable on the shipment detail
  (a posted row keeps its snapshot — fix the mode BEFORE posting); landed-cost tab
  `landedcostmethod`='VALUE', `landedcostamount2`=duty, `landedcostamount5`=freight
  (per-PO split amounts). Item-Receipt ids are **auto-resolved** now (no longer
  TODO): `modules/sms/receiptMatch.js` pairs each lot to its IR (confirmed →
  quantity → sequence) and the same resolution drives the derived `Received`
  status, so correcting a match on the Landed Costs page moves both.
  `GET …/netsuite-preview` still SENDS NOTHING — use it to inspect payloads.
- **✓ / ✗ on a suggested IR match (2026-08-24).** An unconfirmed suggestion now
  carries BOTH answers: ✓ confirms it, ✗ **rejects** it. Reject had to be STORED —
  the match is derived per read, so an unrecorded "no" comes straight back on the
  next refresh — hence `sms_receipt_match_rejections` /
  `mainline_receipt_match_rejections` (own table per module, `(receipt_id,
  shipment_id)` unique; a column on the receipt row would be a repeating group,
  since one IR can be rejected against several of its PO's lots). `matchPo` takes an
  `isRejected(shipment_id, receipt_id)` predicate and skips rejected pairs in BOTH
  passes, so the next-best candidate surfaces — or the row falls to `unmatched` and
  the manual IR-# box appears (which is also the undo: re-adding the IR clears the
  rejection). Routes `POST|DELETE /sms/receipts/:id/reject` and
  `/mainline/receipts/:id/reject`, gated on `shipment_update_status` — the same key
  as confirm, because it is the same decision answered "no". The two assertions are
  mutually exclusive: confirming clears the rejection, and rejecting a CONFIRMED
  pair withdraws the confirmation (so a Received consignment de-escalates rather
  than keeping a match its owner just disowned). The sequence pass was rewritten
  from a running index to "first still-free IR"; verified byte-identical on all 38
  SMS shipments (resolved matches + the Received map) with an empty rejection table.
### Mainline CARRIER + carrier-driven basis (2026-08-24)

- **The business rule is about INVOICES, not carriers.** Finance can only post an
  actual when it receives separate freight & duty invoices. A freight forwarder
  sends them; FedEx/DHL do not. So a mainline shipment moved by FedEx/DHL is
  **estimated** at CI value × `landed_cost_rates(module='mainline')` (seeded 40/25),
  and a forwarder shipment keeps the typed actuals. Carrier is the proxy, which is
  why the flag lives on the CARRIER: `couriers.provides_cost_invoices`
  (Ceva true, FedEx/DHL false). Basis is DERIVED per read — no `basis` column;
  as in SMS, `freight_pct` NULL on the posted snapshot IS the record of "actual".
- **`courier_id` is on BOTH mainline tables, and that is not duplication.**
  `mainline_bookings.courier_id` = the PLANNED carrier (the booking IS the act of
  booking with someone); `mainline_shipments.courier_id` = the ACTUAL carrier, seeded
  from the booking at approve and correctable after. Same plan-vs-actual split as
  booked units vs shipped units. Only the SHIPMENT's carrier drives the basis.
- **`ceva_shipment_number` → `carrier_reference`** (`scripts/rename-ceva-shipment
  -number.js`, idempotent, `--dry-run`). The old name hardcoded one carrier into the
  schema. **Do NOT relabel it "Shipment #"** — `shipment_number` (SHP-N) already
  exists on the same table; the UI says **"Carrier Ref #"**.
- **Null carrier ⇒ ACTUAL**, deliberately. Every row predating this has no carrier,
  so all 7 shipments and the 4 posted mainline `landed_costs` rows are untouched —
  verified byte-identical. A missing carrier must never silently become an estimate.
- Typed `freight`/`duty` are REFUSED (400) on an estimate-basis carrier — they would
  be a second truth beside the derived figure (mirrors `smsShipmentController`
  refusing them on an unbooked consignment). The shipment detail hides the inputs.
- **SMS is untouched and stays separate** (per Lam): it keeps its own
  booked/unbooked rule and its own path. Only the pure helper `svc.estimate` and the
  shared `couriers` master are common. ⚠️ Known consequence of SMS bookings gaining a
  carrier: an SMS consignment **booked with FedEx** still derives basis from
  `booking_id`, so it reads "Awaiting actual" and 422s on post, waiting for a broker
  bill that will never arrive. Latent (no such booking exists yet); fix by moving SMS
  onto the same carrier flag if it ever bites.

- **Still deferred:** mainline actual-entry UI (the `landed_costs` table +
  service are already module-agnostic — `module:'mainline'` rows are manual
  actuals, no rate); `landed_cost_pending` month-end notification.

## SMS report — shipped units are FLOORED AT RECEIVED (2026-09-02)

`GET /reports/sms` derives `shipped` from the portal's own record (Σ
`sms_shipment_pos.units`, or packed pcs once shipping data is uploaded). But **88
of 120 live POs have NetSuite Item Receipts and NO portal consignment** — they were
received before anyone entered SMS shipments here, and the NS sync brings in POs +
IRs, never shipments. So whole seasons read **SHIPPED 0 (0% of ordered)** beside
**RECEIVED 99%**, with all 5,532 units still counted "to ship", every PO stuck in
Overdue, and the `Fully Shipped` column absent because nothing could reach it.

`shippedFor(ordered, recorded, received) = max(recorded, min(received, ordered))` —
you cannot receive what was never shipped, so received is a FLOOR. Two caps matter:
the INFERRED floor is capped at `ordered` so an over-receipt (PO04800: 352 received
against 200 ordered) can't drive `remaining_qty` negative, while `recorded` is
NEVER capped so a genuine over-SHIP still shows (PO04823 ships 125 against 121).
`shipped_recorded_qty` + `has_shipment_record` ride on every row (and the CSV,
appended at the END so column positions don't shift) — they are the cleanup
worklist for POs needing a consignment entered.

**`hod_timeliness` deliberately still keys on `recorded`**: HOD grades the HANDOVER
event, which needs a `ship_date` the inferred POs don't have, and a receipt date
would grade the wrong event. Consequence: those POs read `kpi_status` Received with
`hod_timeliness` Overdue — "arrived, but no handover was ever logged" — unchanged
from before the floor.

⚠️ **`Fully Shipped` is a TRANSIENT bucket, not "everything that shipped."**
`kpiStatusFor` tests `received >= ordered` FIRST, so it only ever holds POs whose
boxes are all out but whose receipts haven't all landed (3 POs today: PO04793,
PO04794, PO04823). A fully received PO is `Received`. An empty Fully Shipped column
is normal, not a bug.

### The Fulfillment donut + By Supplier pivot are UNIT-grained (2026-09-02)

Both used to sum `ordered_qty` bucketed by `kpi_status`. That is a PO-level state,
so a cell carried a PO's **whole** quantity: Shanghai Pucci FW27 read
`Partially Shipped 230 / Received 707` when **929 of its 937 units had arrived and
8 were outstanding** (PO04818 short-shipped 2 SKUs × 4). FW26 read 412 against a
real gap of 5. Now `unitSplit` (backend) emits `units_received` /
`units_in_transit` / `units_overdue` / `units_to_ship` per PO — mutually exclusive,
**always summing to `ordered_qty`** (verified on all 120 rows), both ends capped at
ordered so an over-receipt or over-ship can't overflow a row. Pucci FW27 now reads
`Overdue 8 · Received 929 · Total 937`.
`kpi_status` is unchanged, still on every row and in the CSV — it answers "which
POs need attention", a different question from "where are the units".
`Donut`/`PivotTable` now take `splitOf: (row) => Record<bucket, units>` instead of
`bucketOf`, so one row can feed several buckets; the **HOD axis stays PO-level**
(`hodSplit` returns one bucket with the whole ordered qty) because HOD grades a PO,
not individual units.

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

### ✅ RESOLVED (2026-08-14): sms_po_lines grain — NS line, not (po_number, sku_code)

`sms_po_lines` declared `(po_number, sku_code) [unique]`, and **57 key groups /
111 extra rows violated it** (PO04792 54 groups, PO04571 2, PO04697 1) — the index
could never have been created, so this was a hard **Postgres load blocker**.

**Root cause = the NetSuite data, not the query and not the schema idea.** The
SuiteQL has no fan-out join (`transaction → transactionline → item`); NetSuite
genuinely repeats one item across several PO lines (split by receipt date/location,
or a price-correction line). PO04792 is 54 SKUs × exactly 3 lines each; PO04697
carries one SKU at both 26.25 and 49. Mainline's `po_order_lines` holds the same
declared unique and is clean (0 / 11,871) only because its POs happen to have one
line per item — so **don't copy that declaration to a NetSuite-sourced table.**
The portal was discarding the one field that distinguishes the rows: the query
already selected `tl.id AS line_id` and `integrationService` already mapped it to
`netsuite_line_id`, but the SMS sync dropped it and minted `spol_${++lineSeq}`.

**Fix:** `sms_po_lines.netsuite_line_id` is now stored and is the declared unique;
`(po_number, sku_code)` is a plain lookup index; row ids are `spol_ns_<line_id>`,
which also makes the PK **stable across syncs** (it used to renumber every row on
every sync). Rows synced before this keep `spol_N` + a null `netsuite_line_id` —
Postgres allows many NULLs in a unique index, so mixed data loads, and each PO's
ids fill in on its next sync (lines rebuild wholesale per PO; the 4h cron does it).
**Ordered quantities were never wrong** (all extra rows carry `ordered_qty` 0).

The real exposure was money: `smsPackingController` built its price lookup with
`new Map(rows.map(...))`, so **last row won** and the answer depended on row order
(undefined in SQL). That price is the CI basis when a vendor's sheet omits it, and
the CI basis drives the landed cost that now posts to NetSuite. Both call sites now
use **`smsService.priceByPoSku`**: prefer a line with `ordered_qty > 0`, else a
non-null price, else the lowest line identity. Verified order-independent (reversing
the row order flipped 3 keys before, 0 now) and it fixes a visible bug — PO04571's
duplicated SKUs displayed `null` and now show 42.08.

### ✅ RESOLVED (2026-08-14): sms_cartons split out of sms_packing_cartons

`net_weight_kgs` / `gross_weight_kgs` / `measure_cm` describe the **physical box**
but were stored on every (carton × SKU) row — 890 rows for **114 real cartons**.
The uploader put the real value on the carton's first line and **zeroed the
repeats**, so 103 of 114 cartons held rows contradicting each other and every total
depended on **row order**: reversing it changed the packing summary of **25 of 34
consignments**, one from **246.2 kg to 0**. Row order is undefined in SQL, so this
was a genuine Postgres-migration hazard on numbers that feed the packing list, the
CI, and (via the CI basis) the landed cost that now posts to NetSuite.

**Now:** `sms_cartons` (`sctn_<shipment>_<ctn>`, unique on `(shipment_id,
ctn_number)` — `ctn_number` alone repeats across 14 shipments) holds each fact
once; `sms_packing_cartons` keeps pcs + price. `smsService.withCartonFacts` joins
them back onto **every** SKU row at read, so both dedupe-style consumers
(`packingSummary`) and first-row-style ones (`plGenerator`) get the same answer in
any order. `packingSummary` now dedupes on `(shipment, ctn)` too. The upload writes
both tables; delete cascades both. Backfill: **`scripts/split-sms-cartons.js`**
(idempotent, `--dry-run`, refuses to write on any conflicting non-empty pair — there
were none: 0 cartons had two different non-zero values).
**Verified:** Σ net 827.80 and Σ gross 1123.04 unchanged; `/sms/shipments`,
28 PO details and `/landed-costs/sms` all **byte-identical** to the pre-split
baseline; order-sensitivity 25 → **0** of 34.

⚠️ **`mainline_packing_cartons` still has the old shape** (same three columns at
SKU grain, `plGenerator.js:109` takes `rows[0]`) — same latent order-dependence,
deliberately left alone. Fix it the same way before the mainline data grows.

### Postgres migration notes (known JSON-stack limitations — fix AT migration, not before)

- **No transactions:** multi-file writes (booking approve → shipments + legs;
  shipment-data upload → 5 files; SMS shipment → header + junction) are
  sequential; crash mid-way = partial state. → DB transactions.
- **ID generation races:** `Math.max(id)+1` patterns collide under concurrency.
  → SERIAL/IDENTITY.
- **`mainline/statuses.js` in-memory cache** never invalidated after a
  statuses.json edit (restart required). → drop cache.
- ✅ RESOLVED (2026-08-12): **`mainline/statuses.js` was MODULE-BLIND.** `_maps()`
  built `nameToId` as `new Map(rows.map(r => [r.name, r.id]))` — keyed on NAME with
  the `module` column ignored — so for each of the six names present in both modules
  (Booking Pending, Booking Approved, Rejected, In Transit, Delivered, Cancelled) the
  later SMS row won, and every mainline write through `idForName()` stamped an SMS
  status id. It had already corrupted live data: all 7 `mainline_shipments` held
  `sms_delivered` and bookings 6–7 held `sms_bk_approved`. It hid because `nameForId`
  mapped both ids back to the SAME display name, so the UI read correctly and the
  name-keyed Active/Done sets kept working — only id-level and module-level logic
  broke (and it would have failed as an FK/CHECK at the Postgres migration).
  Fix: both maps now filter to `module === 'mainline'` (names are unique within
  mainline — 10 rows, 10 names, `Cancelled` is category `both`), plus
  `scripts/fix-mainline-status-ids.js` (idempotent, `--dry-run`, translates by NAME
  so display never changes, refuses to write on any unresolved case) which repaired
  all 9 values. **The code fix and the backfill must ship together:** with the module
  filter a leftover `sms_*` id on a mainline row resolves to `null`, which would blank
  the status and drop the row out of the Done set. Verified after: zero cross-module
  status ids in any migrated table, all 10 mainline names resolve to mainline ids,
  and every UI row count is byte-identical to the pre-fix baseline.
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

- `backend/utils/passwordUtils.js` — scrypt (`scrypt:<salt>:<hash>`) ONLY. The
  legacy plaintext-verify branch was removed 2026-08-12 after
  `scripts/migrate-passwords.js` hashed the last three plaintext users; anything
  not matching `scrypt:` now fails closed, and the compare is `timingSafeEqual`.
  **No working password is written in this repo** — the harness reads credentials from
  `E2E_EMAIL`/`E2E_PASSWORD` in backend/.env (gitignored). The three default accounts
  (admin@/logistics@/production@) were rotated to strong random values on 2026-08-12
  and then, at the maintainer's request, set back to a single weak shared dev
  credential — still scrypt-hashed, so users.json holds no plaintext, but trivially
  guessable and known to anyone with repo history. **This MUST be rotated before the
  portal is reachable by anyone else** (Settings → Users hashes on write). JWT carries `{id, email, role}`; vendor supplier scoping resolves
  via users.json → suppliers.json at request time.
- **`JWT_SECRET` is REQUIRED — `middleware/auth.js` throws at load if unset.**
  There is deliberately no fallback (the old hardcoded `tentree-dev-secret-2026`
  meant anyone with repo access could forge an Admin token). It lives in
  `backend/.env`; `backend/.env.example` documents it and is the one `.env*` file
  git tracks. Rotating it invalidates every live session.
- **Auth gate is global, by mount order** (`server.js`): only `/health` and
  `/login` are mounted above `app.use(requireAuth)` — everything below requires a
  valid JWT, reads included. Add new routers BELOW the gate. The per-route
  `requireAuth` calls are now redundant but harmless; `requireAdmin` still carries
  the role check.
- **`permissions[]` IS enforced server-side** (`middleware/requirePermission.js`,
  2026-08-12). Resolves role→permissions from roles.json PER REQUEST, so a
  permission change now applies immediately instead of at next login. Grants on ANY
  listed key — `requirePermission('shipment_import_export', 'shipments')` — because
  some endpoints are legitimately reachable by more than one capability. Admin is
  NOT special-cased (its role already holds every key). Must sit below the auth
  gate. **The permission vocabulary splits in two, and the split is the design:**
  NAV keys (`purchase_orders`, `bookings`, `shipments`, `reports`, `forecast`,
  `contacts`, `settings`, `freight`, `landed_costs`) = page visibility; ACTION keys
  (`booking_create_*`, `booking_approve`, `booking_delete`,
  `shipment_update_status`, `shipment_delete`, `shipment_import_export`, `po_edit`,
  `settings_edit`, `user_manage`) = write authorization.
- **Enforcement is TIERED — do not "fix" tier 3 by adding a nav key.** Writes take
  action keys. Analytics/finance reads (`/reports/*`, `/forecast`, `/landed-costs/*`,
  `/freights/*`, `/contacts`, `/eom-tasks`, `GET /roles`) take a nav key — verified
  safe because no shared page fetches them. Transactional reads (`/po/*`,
  `/mainline/*`, `/sms/*`, `GET /master-data/*`) are auth-only and must STAY that
  way: `app/sms/shipments` fetches `/sms/pos` and `app/mainline/bookings` fetches
  `/po` + `/po/legs`, so gating those on `purchase_orders` breaks Production and
  Freight Forwarder. Route keys map to the key of the PAGE that consumes them, not
  the URL prefix — `/reports/sms/forecast` is fetched by `app/forecast/sms`, so it
  takes `forecast`.
- **Vendor row scoping**: `utils/vendorScope.js` is the ONE resolver (replaced four
  near-identical copies). `onUnlinked:'throw'` → 403 for writes; `'deny'` → the
  NO_SUPPLIER sentinel for reads, so a misconfigured account renders empty instead
  of erroring. Matches on `supplierKey` (utils/nameKey), NOT plain `norm` — the live
  vendor account holds "Best Star Fashions Co Ltd" against a suppliers.json
  "Best Star Fashions Co., Ltd." and resolved to NOTHING under `norm` (403 on every
  SMS write, zero notifications) until fixed 2026-08-12.
- **Vendor READ scoping is now enforced too** (2026-08-12). Two conventions hold
  everywhere: **(1) scope at ONE point per read path** — `poController.loadAll(sid)`
  and `smsPoController._ctx(sid)` filter their source tables once, so every handler
  in the file inherits it; list handlers elsewhere filter only the RECORD LIST and
  leave the enrichment context whole (pruning lookup tables blanks joined names).
  **(2) an out-of-scope detail read returns 404, NEVER 403** — a 403 confirms the id
  exists, which is the oracle for enumerating other suppliers' TRNs, PO numbers,
  booking and shipment ids. Sub-resources hanging off a parent id use the guards in
  `modules/mainline/vendorAccess.js` (booking/shipment/TRN/po_number/leg) and
  `modules/sms/vendorAccess.js` (shipment). **Two traps encoded there:** SMS
  visibility requires ALL of a consignment's POs to be the vendor's (`every`, not
  `some`) or a cross-supplier box leaks B's lines to A; and a junction-less row must
  be explicitly excluded because `[].every()` is `true`, which would expose every
  untracked booking-approve draft to every vendor. `sms_po_lines`/`po_order_lines`
  must be filtered alongside their POs — the `*-lines` download joins the PO, so an
  unfiltered line still emits another supplier's po_number, sku_code and qty with
  blank names. Verified: vendor payloads are byte-identical to the admin payload
  filtered to the same supplier (proves no over-filtering AND that derived values —
  rollups, FIFO receipt allocation, packing summaries — did not skew), 16 foreign-id
  probes all 404, own records still 200.
- **Frontend route gate = `src/proxy.ts`** (2026-08-12). Was `src/middleware.ts`,
  which only checked that a `session` cookie EXISTED — and since the cookie's own
  contents named the role, `session={"role":"Admin"}` rendered every page shell.
  Now the `auth_token` JWT's SIGNATURE is verified, with `alg` pinned to HS256 (so
  `alg:none` is refused) and `exp` enforced; failures redirect to /login and clear
  both cookies. Renamed to `proxy.ts` because that is the convention in the installed
  Next 16.2.4 (`middleware` is deprecated; `proxy` runs on the **nodejs** runtime,
  not configurable) — which is what lets it use `node:crypto` and verify with NO new
  dependency. **This requires `JWT_SECRET` in `frontend/tentree-scportal/.env.local`
  matching `backend/.env`**; if unset it logs loudly and fails closed (it does not
  throw — a throw would 500 /login too, leaving no way back in). It is defence in
  depth: the API is the real control, so a forged cookie already 401s every fetch.
- **File downloads go through `/api/documents`** (Next route handler), never straight
  to the backend. `backend/server.js` now mounts `/uploads` + `/templates` BELOW the
  auth gate, so a browser tab hitting them directly 401s; the handler reads the
  httpOnly cookie server-side, attaches the Bearer token and streams the file. Client
  components must use `docHref()` from `lib/api` — never rebuild
  `` `${BACKEND_URL}${file_url}` ``. It authenticates BEFORE validating `?path` (so an
  anonymous caller learns nothing about the allowlist), refuses traversal /
  backslashes / NUL / `//host` / any `scheme:`, allows only the `/uploads/` +
  `/templates/` prefixes plus the exact route `/freights/template` (that xlsx is
  generated in memory, so it has no file on disk), and sends
  `Content-Disposition: attachment`. This also removed the last place the JWT reached
  browser JavaScript: `getFreightTemplateUrl()` used to RETURN the raw token so client
  code could set an Authorization header, defeating httpOnly. **Never reintroduce a
  server action that returns the token.**
- **Perimeter** (2026-08-12): `/login` is rate limited to 10 attempts / 15 min per IP
  (`middleware/rateLimit.js`, hand-rolled — in-process, so counters reset on restart
  and are NOT shared across instances; behind a reverse proxy set `trust proxy` or the
  limit becomes global). `middleware/securityHeaders.js` sets nosniff / DENY frames /
  no-referrer / CORP same-site, plus HSTS in production only. CORS is an allowlist via
  `CORS_ORIGINS` (was `origin:'*'`). Cookies are `secure` in production
  (`NODE_ENV === 'production'`), plain HTTP in dev.
- **Known gaps (not yet fixed):** `/uploads` gating is COARSE — any authenticated user
  can fetch any file whose name they know; per-document ownership (vendor A must not
  read vendor B's CI) would need the document tables consulted per request.
  `GET /master-data/suppliers` still hands every vendor the full supplier roster
  (deliberately left: many pages read it for dropdowns). Reports/forecast/landed-costs
  are denied to vendors by nav key rather than scoped, so there is no vendor-facing
  KPI view. Freight Forwarder is still not data-scoped, but it now CAN be:
  `mainline_shipments.courier_id` (2026-08-24) is the `forwarder_id` this note used to
  say did not exist. Until a scope filter actually uses it, FF still sees all mainline.
  There is no `shipment_create` key, so `POST /sms/shipments` is gated on `shipments`,
  which every role holds (semantically right, not a real restriction). JWTs cannot be
  revoked before their 24h expiry.
- `/users` + `/roles` CRUD (Admin); login injects `permissions[]` into the
  session; Sidebar filters via `can()`. The session copy is for NAV ONLY — the
  server never trusts it.
- Valid roles: Admin, Logistics Coordinator, Production, Vendor (vendors carry
  `supplier` linking to a suppliers name).

## Verification harness (reusable)

Playwright: `playwright-core` + chromium at
`…/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe`; scratch
project at `%TEMP%/pwtest-cols`. **Drive the GUI via `http://localhost:3000`,
NOT `127.0.0.1`** (HMR websocket rejects it — React never hydrates). Login via
the real form, with credentials read from `E2E_EMAIL`/`E2E_PASSWORD` in backend/.env
(never hardcoded — see .env.example); backend needs a manual
restart after code changes (`node server.js`, port 5000 — no hot reload).

## Agent File Ownership

| Agent    | Owns                                          | Never touches |
|----------|-----------------------------------------------|---------------|
| frontend | `frontend/tentree-scportal/src/`              | `backend/`    |
| backend  | `backend/server.js`, `backend/modules/`, `backend/services/`, `backend/data/` | `frontend/` |
| qa       | Read-only — no writes                         | —             |
