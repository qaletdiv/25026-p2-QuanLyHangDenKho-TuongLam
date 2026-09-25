# tentree Supply Chain Portal — Agent Context

## ⚠️ ARCHITECTURE: two normalized modules, legacy stack DELETED (read first)

The portal is **two fully separate datasets/modules** on a normalized (3NF) schema:
**mainline** (ocean/air freight via forwarder) and **SMS** (small courier shipments
via FedEx/DHL). The old legacy stack (`/purchase-orders`, `/bookings`, `/shipments`
routes, flat `bookings.json`/`shipments.json`/`purchase-orders.json`, drawer-era
frontend trees) was **DELETED at the 2026-07-03 cutover** — do not reference it.
Its last remnant, the frozen `purchase-orders.json` + `controllers/reportController.js`,
was deleted 2026-09-21 along with the `purchase_orders`, `bookings`, `shipments`,
`history` and `history_bookings` tables.

- **Design docs (source of truth):** `backend/database.dbml` (mainline + SMS table
  families), `backend/SCHEMA_REDESIGN.md`, `backend/MAINLINE_MODULE_STRUCTURE.md`,
  `backend/MAINLINE_BUILD_PLAN.md`, `backend/SMS_MODULE_PLAN.md` (SMS schema,
  phases 1–7 all ✅, open items).
- **Data: PostgreSQL since 2026-09-14, via SEQUELIZE since 2026-09-21** (database
  `tentree_portal`; see the SEQUELIZE section below and `backend/database/README.md`).
  **`backend/models/` is the schema authority.** Modules still read/write WHOLE
  ARRAYS — `await models.po_orders.read()` / `.write(next)` — so the derive-per-
  request discipline below still describes the code accurately. The old
  filename-as-table-key shim (`'migrated/po_orders.json'`) and `BaseModel` are
  **gone**; tables are reached as `models.<table>`.
  **⚠️ `backend/database/seed-data/` is SEED INPUT ONLY.** Nothing reads it at runtime.
  Editing it changes nothing. Query the DB, or read through `models.<table>`.
  `scripts/migrate-to-normalized.js` and `scripts/migrate-sms.js` were DELETED
  2026-09-21 — both were one-time migrations reading legacy files that no longer
  exist, and the first was documented as wiping live data if ever re-run.
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
  `mainline_po_legs` for v1 seasons. Ingestion rules R1 (protect-if-booked) /
  R2 (flag-on-conflict) / R3 (WIP-overwrites-legs) / R4 (refuse-rejected).
- **⚠️ WORKFLOW v1 vs v2 — THE BOUNDARY IS THE SEASON (2026-09-25).** The old
  "NS sync never creates legs" rule is GONE. `V1_SEASONS` in
  `modules/po/netsuiteSyncService.js` is the switch, and `mainline_po_legs.source`
  (`'wip' | 'netsuite'`) records which built a row.
  - **v1 = FW26.** The WIP sheet splits a PO into air/sea legs, so `po_number`
    repeats by mode — **16 of 64** legged FW26 POs carry both. NetSuite has ONE
    mode per PO header and cannot express that, which is why the sheet owns it.
  - **v2 = SS27+.** 1 PO = 1 warehouse = 1 method = **ONE leg**, built by the
    sync (`leg_ns_<poNumber>`). No channel (everything lands in …First), no WIP
    import, no air/sea split.
  They coexist with **no migration**: FW26 kept its 87 WIP legs untouched and
  SS27 had ZERO legs to convert. Reverting v2 = delete the condition; there is
  no schema fork, because both regimes produce the same legs.
  **v2 field map, all off the PO record:** `custbody7`→season (NOT via the TRN —
  a PO with no TRN still has one), `custbody16`→mode (SEA/AIR both present),
  `custbody46`→crd, `custbody8`→hod, `custbody_tt_po_type`→poType
  (`Mainline|SMS|SMU`; **SMU is MAINLINE**), `duedate`→`expectedReceiveDate`.
  ⚠️ **`duedate` was previously mislabelled `etdPol`** in the mapper — it is the
  Expected RECEIVE date, the opposite end of the journey. Harmless under v1
  (sync `etdPol` never reached a leg, 0/87) but it would have fed the transit
  segments backwards under v2.
  ⚠️ **`eDel` is DERIVED as `expectedReceiveDate − transit_time_standards
  .receiving`** (5 days, sea and air alike) — the exact inverse of the report's
  `expectedAta = eDel + 5`. The FACT is stored and `eDel` derived, not the
  reverse, so editing the standard corrects both ends instead of leaving `eDel`
  stale. **Both are written ONCE and never overwritten**: this is the plan
  production committed to at season start, and a plan that could move would make
  slippage read zero. The ACTUAL delivery date lives on
  `mainline_shipments.eDel`; the two never write to each other.
  **Three things v2 broke that v1 had hidden, all fixed:**
  (1) v2 legs had no `mainline_po_leg_lines`, so 220,573 units were invisible to
  the report and forecast — the sync now mirrors them **aggregated by SKU**
  (PO04826 repeats a SKU 399 times; a 1:1 copy collides on `mll_<leg>_<sku>` and
  double-counts). (2) `mainline_po_leg_lines.skuCode` has an FK to
  `product_skus` that `po_order_lines` does not; forecast-stage SKUs were absent
  from the master and only escaped notice because those POs had no legs — the
  sync now seeds it like the WIP import (2,210 added). (3) `computeReferenced`
  counted ANY leg as "in use", so a v2 PO could never be pruned by R4 — it now
  ignores `source:'netsuite'` legs, since the sync creating one proves nothing.
- **⚠️ `splitWarehouseName` tolerates a trailing " Inventory".** NetSuite names
  the First-channel locations `NRI CA First Inventory`; with the channel word
  anchored at the end the whole string fell through as a facility name and 14
  POs synced with `facilityId = null`. **Inventing that facility would be the
  wrong fix** — it splits NRI CA in two and breaks the `(booking, facility,
  mode)` shipment grain and G3. It is the First CHANNEL at the NRI CA FACILITY,
  and both already exist.
- **R4 — a REJECTED NetSuite PO is not a PO (2026-09-08).** The mainline scope was
  `t.status IN ('A','B','C')`, commented as "Pending Receipt / Partially Received /
  Pending Billing" — a legend already known to be wrong when the SMS side was fixed.
  **Verified against production** (`GROUP BY t.status` over every PurchOrd):
  `A` = Pending Supervisor Approval, `B` = Pending Receipt, **`C` = Rejected by
  Supervisor**, `D`–`H` = the received/billed/closed states. So "active only" was
  importing rejected POs as live ones: PO03521 and PO03789 (both
  `approvalstatus=3`, `status='C'`) sat in the order book as Forecast rows, offering
  themselves for booking. `buildUpserts` never looked at `approval_status` either,
  though the header query has always selected it. Now closed three ways:
  **(1)** scope is `IN ('A','B')` + `NOT_REJECTED_CLAUSE`
  (`approvalstatus IS NULL OR != 3` — **`IS NULL` matters**: 880 older Closed/
  Fully-Billed POs carry no approval status and a plain `!= 3` would drop them all
  on SQL three-valued logic), on the header AND line-item queries, both modules;
  **(2)** R4 in `buildUpserts` skips a rejected PO and reports it in
  `rejected_skipped`; **(3)** `pruneRejected` + `integrationService
  .fetchRejectedPoTranids` REMOVE ones already stored — a filter cannot, because a
  PO is normally rejected *after* it was synced, so it just stops being refreshed
  and lives in the portal forever. The prune **refuses to delete a PO anything
  points at** (leg / booking / shipment / receipt — `computeReferenced`, wider than
  R1's `computeLocked`) and reports it as `rejected_kept_referenced` instead:
  rejected-but-booked is a real contradiction for a human, not something a sync
  should paper over. A TRN master goes only with its LAST PO.
  `scripts/prune-rejected-pos.js` (idempotent, `--dry-run`) does the cleanup without
  a full sync. Measured: mainline pull 19 → 17 POs and **the only two dropped were
  the rejected pair**; SMS scope 120 → 120 (untouched); the removal took orders
  83 → 81, lines 11,981 → 11,946, masters 44 → 42, PO-list rows 106 → 104, while
  `/reports/mainline` (92 rows, 264,948 units) and `/forecast` were **byte-identical**
  — those are leg-grained and these POs had no legs.
- **Pending-approval POs are BADGED, not excluded (2026-09-09).** Status `A`
  (Pending Supervisor Approval) stays in scope — 16 of 81 POs today — because an
  unapproved PO is still useful forecast signal. What was wrong is that it looked
  IDENTICAL to an approved one everywhere. `po_orders.approval_status` now stores
  NetSuite's value ('Pending Approval' | 'Approved' | null; 'Rejected' never
  stored, see R4) and `components/ApprovalBadge` renders an amber pill on the PO
  list (own **Approval** column), the TRN detail (per PO row — a TRN can mix
  approved and unapproved POs) and the leg detail (beside **Book Now**, which is
  the button the badge is warning about). **Approved renders NOTHING** — a badge on
  every row is two things to read instead of one; same blank-when-unremarkable rule
  as Carrier Ref #. The Approval column's sort accessor is a RANK
  (rejected→pending→approved→unknown), because sorting the label put "Approved"
  first (A < P) and buried the rows the column exists to surface.
  ⚠️ **It must be REFRESHED for every held PO, not taken from the pull**: the pull
  is A/B only, so a PO that was pending when it synced and has since been approved
  and received would wear "Pending approval" forever. `sync()` therefore calls
  `integrationService.fetchPoApprovalStatuses(held)` — ONE query that also answers
  the R4 prune — and reports `approval_refreshed`.
  `scripts/backfill-po-approval-status.js` (idempotent, `--dry-run`) populated the
  existing rows (81 written: 65 Approved / 16 Pending) without a full sync, which
  would also have renumbered ~12k `po_order_lines` ids for nothing.
  **Resolved 2026-09-09:** booking an unapproved PO is REFUSED — see G4 below.
  SMS was left alone: `sms_pos` has no approval column and no SMS PO is pending.
- **Bookings key on `leg_id`** (leg-only; forecast POs unbookable). Guards:
  G1 same-supplier, G2 overbooking (409 + `force_overbook`), G3 same-consignment
  (one destination facility + one mode; `mainlineBookingService.checkSameConsignment`),
  **G4 NetSuite-approved** (`checkApproved`, 2026-09-09).
- **G4 — you cannot book a PO NetSuite has not approved.** Booking reserves space
  and commits the supplier, but a PO awaiting supervisor sign-off can still change
  or be rejected; nothing stopped it before (the portal didn't even show the
  difference — see the badge note under the PO hierarchy). **HARD refusal, 422, no
  `force_` bypass** — G2 is soft because shipping slightly over allocation is a
  coordinator's call to make, whereas "book it before the supervisor approves it"
  is not. Only an explicit `'Pending Approval'` / `'Rejected'` blocks: **NULL must
  NOT block** (older closed POs carry no approval status, and treating absence as
  disapproval would refuse legitimate bookings on historical POs). Checked before
  G1/G3 because it is a property of the PO alone, so the message stands on its own
  ("have it approved in NetSuite, then run the NetSuite Sync"). The create path is
  the only site — `update` never touches `po_legs`. The booking FORM mirrors it by
  **locking** those rows (badge + disabled inputs + dimmed), the same
  make-it-unexpressible choice the SMS booking form makes for its supplier guard;
  the server guard remains the authority, since a stale page can still POST.
  Verified over HTTP: unapproved leg → 422, same call with `force_overbook:true` →
  still 422, an approved leg → 201 (test booking deleted; 9 bookings before and
  after), and in the form 4 badged rows fully locked / 10 unbadged fully editable.
- **⚠️ Approving is `booking_approve` on BOTH doors — the EDIT route was the second
  one (2026-09-18).** `POST /mainline/bookings/:id/approve` was gated, but
  `PUT /mainline/bookings/:id` accepts `booking_status` and moving it to
  'Booking Approved' runs the FULL `_approve` (stamps `approved_at`, creates the
  shipments) — and that route carries `booking_create_mainline`, which **Vendor
  holds**. Measured against the live vendor account: POST → 403, the same approval
  via PUT → 200. Now checked IN THE HANDLER, not at the route, because the key is
  needed only when the status actually MOVES: a vendor saving Cargo Ready or the
  carrier on their own pending booking must still pass. Cancelled/Rejected are
  covered by the same test — same decision, answered differently.
  The same probe found `update` had **no vendor scoping** while `getAll`/`getOne`
  did, so a vendor got **404 reading** another supplier's booking and **200 writing
  it**; it now 404s (never 403 — a 403 confirms the id is real). `approve` and
  `remove` are unscoped too but gated on keys no Vendor holds — latent, not
  reachable. Verified on a throwaway Pending booking (deleted; 10 before and after,
  0 orphans): vendor status-change 403 · vendor POST /approve 403 · vendor Cargo
  Ready 200 · other supplier's vendor 404 · Production status-change 200.
- **The Approve button is VISIBLE and DISABLED without the permission, not hidden**
  (2026-09-18, per Lam). Mainline drew it for everyone (status-gated only), so a
  vendor clicked it and got a 403 toast; SMS hid it on `role === 'Vendor'`, which
  missed the Freight Forwarder. Both now key on `hasPermission(user,
  'booking_approve')` (`lib/permissions`, shared with `Sidebar.can`) — a role name
  in a component is the debt this file already lists. Approve stays on screen and
  greyed because a vendor watching their own booking should still see it is sitting
  on an approval, which a hidden button does not say; Reject / Cancel / Delete stay
  HIDDEN, since they say nothing to someone who cannot take them. ⚠️ The tooltip
  hangs on a wrapping `<span>` — a disabled `Button` carries `pointer-events-none`
  and eats a `title`. The server is still the authority; this only stops the UI
  offering what the API refuses. Verified in the GUI on a throwaway Pending booking
  per module: Vendor + Freight Forwarder disabled with the hint, Logistics enabled.
- **Shipment grain = (booking, facility, mode)** — ONE physical conveyance:
  `mainline_shipments` header (shared dates/BL/ports/status/financials, edited
  once) + `mainline_shipment_legs` junction (`lot_number`/`expected_quantity`).
  COO/CRD are per-leg, joined at read. **expected ATA = e_del + 5, derived never
  stored**. `checkChronology` guard rejects out-of-order dates on update.
- **⚠️ CANCEL AND DELETE TRAVEL DOWN, NEVER UP (2026-09-18).** The exits are now one
  rule at every grain: **you may undo a level only while nothing below it has
  hardened**, and the four hardening events are `approved → handed over → landed →
  costed`. Concretely:
  **(1) Cancel shipment** (`POST /mainline/shipments/:id/cancel`,
  `shipment_update_status`) calls off the CONVEYANCE and leaves the booking
  Approved with its units still committed — the usual case is "this sailing fell
  through, same goods next week". **(2) Delete shipment** (`shipment_delete`)
  requires the row to be **Cancelled first**, so deleting is never the first click.
  **(3) `DELETE /mainline/bookings/:id` now 409s while ANY shipment row hangs off
  it** — it used to cascade, so one click destroyed the consignment, its ASN, its
  receipt links, the CI, the cartons and the documents with no check on whether the
  goods had arrived (live: 10 shipments, 8 CIs, 2,275 cartons, 48 docs, 16 confirmed
  receipt matches behind an unguarded button). The booking still cascades its OWN
  artifacts. **(4) `_approve` skips Cancelled shipments** when deciding whether to
  spawn one — without it cancel was a dead end, because re-approve found the
  cancelled row, created nothing, and left the booking Approved with no way to issue
  a consignment. Now re-approve mints a fresh SHP-N and the cancelled row stays as
  the record. **(5) Neither state is reachable through the generic status PUT** —
  `status:'Cancelled'` 400s pointing at the action, and a cancelled row refuses to
  be reopened. Same shape as the booking-approve bypass: a gated action beside an
  ungated field that reaches the same state is not a gate. `Cancelled` was removed
  from the shipment status dropdown for the same reason.
- **⚠️ The gate is "HANDED OVER", and it is `cargo_received_date` — NOT the ETD, and
  NEVER the CRD** (`shipments/shipmentLifecycle.js`). **CRD is the CARGO READY date**
  — the supplier's plan, which moves earlier and later, and which the VENDOR can
  edit while the booking is pending; gating on it would hand the vendor a switch for
  the guard. `cargo_received_date` is **Received at Port**: the forwarder has the
  cargo. It lands 0–32 days after Cargo Ready and **8–46 days BEFORE the vessel
  sails** (46 on SHP-4), so gating on `etd_pol` would leave a month-and-a-half window
  where the goods are in the carrier's hands and the portal still offers Cancel.
  ETD and `bl_no` stay in the predicate as backstops (the three are monotonic on all
  8 live consignments, so "any present" needs no ordering). `carrier_reference` is
  deliberately EXCLUDED — SHP-1 carries one and no other evidence, and including it
  would lock the exact shell row this lets staff clear. The typed status is excluded
  too (hand-set; 8 of 10 read "Delivered" because a person typed it, and nothing
  stops setting it back), so the UI mirrors the predicate to disable the button and
  the server stays the authority. Two more blockers, both naming their own reversal:
  a **confirmed Item Receipt** (unmatch first) and a **posted landed cost** (unpost
  first — that row is money already PATCHed onto a live NetSuite IR, and
  `landed_costs.shipment_id` is a SOFT ref, so nothing else would catch it).
  ⚠️ `PoLegDetail` used to label `leg.crd` "CRD (target)" and `cargo_received_date`
  "CRD (actual)", which reads as two measurements of one date; they are two
  different EVENTS and `transitTimeService` already models the gap between them
  (`CRD → Received`, then `Received → Depart`). Now **Cargo Ready** and **Received
  at Port**.
- **SMS gets the same two actions, with its own predicate** (2026-09-18).
  `POST /sms/shipments/:id/cancel` — handed over = **a tracking number or a ship
  date**, the same test `smsBookingController.cancel` already applied at booking
  grain. That means it reaches only booking-approved DRAFTS: all 37 vendor-entered
  parcels are typed after handover and carry both, so the action is absent on them
  rather than offered and refused. `DELETE /sms/shipments/:id` gained the **posted
  landed-cost** guard it was missing (38 SMS rows are posted); it sits behind the
  existing receipt guard, so it is only reachable after someone unmatches — which
  is exactly the hole it closes. SMS delete deliberately does NOT require Cancelled
  first: an SMS consignment is TYPED by a vendor and a mistyped tracking number is
  the common case, and `smsBookingController.cancel` explicitly directs people to
  "delete those shipments first if they were entered in error".
  **The SMS Cancelled status was WIDENED, not added** — the database's
  `statuses_module_name_uniq (module, name)` refuses a second row, which is the same
  shape mainline uses (one `cancelled`, category 'both'). So
  `scripts/add-sms-cancelled-status.js` renames `sms_bk_cancelled` → `sms_cancelled`
  and sets category 'both' (idempotent, `--dry-run`, refuses if anything still
  references the old id — 0 did). Consequences wired: `smsStatuses` includes
  category 'both', `TERMINAL_STATUS_IDS` includes it (a cancelled box is never
  polled), the manual-status route refuses the name, and the table's Done set
  includes it.
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
  **`poController.getAllLegLines` was the LAST raw-column holdout and was fixed
  2026-09-16** — same defect, found the same way: the `PO item lines (SKUs)` export
  showed an ATA for PO04772 and PO04784 only, because those two ride SHP-2, the
  **1 of 9** shipments whose typed `ata` column is set. Every other consignment
  exported blank while its receipts said it had landed. It now goes through
  `loadAtaByShipment` + `effectiveAta` like the reports, and carries an
  `ata_source` column so a reconciler can see which rule produced the date.
  Still a raw-column reader, deliberately: `landedCostController`
  (`ship_date`/`ship_month`, which groups posted finance snapshots).
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

## CI / Packing List header block (2026-09-15, revised 2026-09-16)

The shared `services/ciGenerator.js` + `plGenerator.js` render a `meta` object both
modules build in their own `_meta` (`modules/mainline/ci/documentService.js`,
`modules/sms/smsDocumentService.js`). Six header fields were blank on every
downloaded document, for two different reasons, and the distinction is the point:

- **No source in code.** `shipping_mode` and `notify_party_*` were read by the
  generators and set by NOBODY — the keys appeared only inside the two generator
  files. Now: `shipping_mode` is DERIVED (mainline from the booking's leg
  `mode_id` → `modes.name`, resolved through `legPoToId` — **not** `legs.find(po)`,
  which on an air+sea PO can return another booking's leg; SMS from
  `sms_shipments.mode_id` falling back to `Courier`, the same fallback
  `netsuiteLandedCost` applies to `custbody16`, so the document and the NetSuite
  record state one mode). The **NOTIFY PARTY is a SINGLETON** — table
  `notify_party`, one row `default`, because it is always tentree whatever the
  destination, supplier or module (Lam, 2026-09-16). It was first built as two
  columns on `warehouse_facilities` and that was wrong: five copies of one fact are
  five chances for them to disagree on a customs document. Settings → Warehouse
  Management → **Notify Party** (`GET|PUT /master-data/notify-party`).
- **Source existed, data empty.** `suppliers.address`, `suppliers.port_of_loading`,
  `warehouse_facilities.address`, `.port_of_discharge`. Looks like data entry, was
  not: **Settings → Warehouses edited the WRONG TABLE.** `WarehouseSettings` wrote
  `address`/`port_of_discharge` to the legacy 6-row `warehouses` (the pre-3NF
  warehouse×channel list) — which no generator reads. The details HAD been entered,
  correctly, into a table no document consults. Those two columns were removed from
  that screen, a **Destinations** block over `warehouse_facilities` added above it,
  and the typed values lifted across by
  `scripts/backfill-facility-addresses.js` (idempotent, `--dry-run`, matches
  warehouse → facility by longest NAME PREFIX, refuses to write on any conflict).
  The CONSIGNEE is the destination the PO names (`po_orders.facility_id`), which is
  why facility grain is the right one — both "NRI US *" warehouse rows carried the
  same address.
- `PUT /master-data/warehouse-facilities` is **EDIT-ONLY** — the id set must match
  what is stored, or 400. Facilities are FK targets for `po_orders`, `sms_pos`,
  `sms_shipments` and `mainline_shipments` and are created by the PO ingestion, and
  `models.<table>.write()` replaces the whole table, so a missing id would DELETE a
  destination live records point at. Fields outside `FACILITY_EDITABLE` are carried
  over from the stored row.
- **⚠️ The download REBUILDS the workbook; the stored xlsx is not served.**
  `GET /mainline/documents/:docId/file` and `GET /sms/documents/:docId/file`
  reconstruct the rows from the stored cartons + SKU master and re-read the
  master data, keeping the STORED `invoice_number` (the document's identity). This
  is the actual fix for the reported bug: the letterhead is master data edited
  *after* the upload, so a file written in August cannot show what was typed in
  September — every downloaded CI kept its blank consignee block even once the
  addresses were entered. Frontend uses `generatedDocHref(module, doc.id)` from
  `lib/api`, **not** `docHref(d.file_url)`; `/api/documents` allows the two routes
  by pattern and prefers the backend's own `Content-Disposition` filename. ASNs and
  uploaded source files still go through `docHref`. `rowsFromCartons` +
  `_groups` are shared by `generateAll` and `rebuild` in both modules so the
  regenerated document can never disagree with the stored one about its rows —
  verified on all 6 BKG-9 documents: identical row counts and exactly ONE differing
  line each, the signature-block seller address that used to be blank.
- **⚠️ An address field must be a `<Textarea>`, never an `<Input>`** (2026-09-16).
  A browser collapses newlines to spaces when you paste into a single-line input,
  so an 8-line consignee block was STORED as one 230-character line (verified:
  `position(E'\n' in address) = 0` on every facility, vs 22 on `notify_party`) and
  printed as one line — while the Notify Party, the only such field already backed
  by a textarea, came out correctly. That contrast is what identified it.
  `components/settings/AddressInput` is the shared control; use it for anything
  printed as a block.
- **Address lines get ONE EXCEL ROW EACH** (`writeLines`, duplicated in both
  generators — they share no module). The generators used to write
  `addrLines[0]`/`[1]` into two fixed cells and spread the consignee over exactly
  4 rows, so line 5 onward was DROPPED silently on a customs document. A merged
  wrapText cell was tried first and rejected: real rows stay ordinary editable,
  copyable cells.
  **The consequence is that NOTHING below a block sits at a fixed row.** Every
  anchor is computed downward: `titleRow = max(labelsEnd + 2, contact2Row + 2)`,
  `labelRow = titleRow + 2`, `headerRow = blockRow + max(conLines, notifyLines)
  + 1`, `dataRow = headerRow + 1` (PL: `titleRow` → `headerRowNum = titleRow + 2`).
  The item table follows the consignee block directly — there is no `max(21, …)`
  floor any more, because a fixed row number stopped meaning anything once the
  blocks could grow. ⚠️ Anything added below a block must be anchored to these
  variables, never to a literal row.
- **Layout conventions (2026-09-16, per Lam):** the right-hand label stack is
  CONTIGUOUS FROM ROW 1 and sits in the **LAST TWO COLUMNS OF THE ITEM TABLE**, so
  the info block's right edge IS the table's right edge. Both are DERIVED, not
  written out: `colHeaders` is declared first
  and `LAST_COL = colHeaders.length` / `INFO_LABEL_COL = LAST_COL - 1` drive the
  block, the banner's merge (`mergeCells(titleRow, 1, titleRow, LAST_COL)`) and the
  rule — **add a column to `colHeaders` and the whole right edge follows.** Today
  that is L&M on the CI (13 columns) and I&J on the PL (10). Those columns were
  widened to 18 because they now carry labels, not just money/measure values. The
  stack is a separate column group from the seller block, so a long address grows
  past it without disturbing it. Country of Origin moved into it, which frees the
  banner row to be
  **centred across the full sheet width** (`A:M` on the CI, `A:J` on the PL) at
  size 14. **The PL carries the Consignee / Notify Party blocks too** — it travels
  with the goods and is read at the destination — in the same columns and the same
  one-line-per-row form, so the two documents read identically. Live check: CI
  banner 12, labels 14, block 15-22, item table 24; PL banner 10, labels 12, block
  13-20, carton table 22; totals, Say-In-Words and the signature block all follow,
  quantities unchanged (3,116 = 1,207 + 1,909).
- **The FRAME is `outline(ws, top, left, bottom, right)`, drawn LAST** — after every
  row position is known, since none of them are fixed. Medium rules box exactly
  three things plus the perimeter: the **seller block**, the **info block** and the
  **item table**, then the whole form. The banner and the Consignee / Notify Party
  block are deliberately UNBOXED (Lam, 2026-09-16) — boxing every section made the
  sheet busy. Section boxes are drawn before the outer one so the outer edge wins
  where they meet, and each edge is MERGED into the cell's existing border so the
  item table's thin grid survives. A per-cell right border on the info block alone
  was the first attempt and read as an unfinished form — the rule stopped at row 10.
  Verified: outer frame complete on all four sides (CI 13 cols × 108 rows, PL 10 ×
  334), 0 rows missing the right rule, the three boxes present, banner and parties
  edges absent, content byte-identical.
- ⚠️ **A run-on line in a document is usually the DATA, not the generator.** The
  generator prints exactly the lines it is given. Three facility addresses had
  breaks in the wrong places from a partially-preserved paste (NRI CA held street,
  contact, phone and email on one stored line); `splitLines` trims but cannot
  invent a break, and heuristically splitting on "Contact:"/a phone/an email is not
  something to do unattended to a customs document. Check the stored value first:
  `SELECT replace(address, E'\n', ' [NL] ') FROM warehouse_facilities`.
- **`suppliers.manufacturer_name` / `.manufacturer_address`** (2026-09-16) — the
  FACTORY, which is not always the company being invoiced (a supplier may be an
  agent). Both fall back to the seller's name/address when blank, which is exactly
  what the CI's "Manufacturer Name / address" lines showed before they had a field.
- Still blank by design, no source anywhere: `vendor_contact` (CI `A3`/`A9`, PL
  `A3`), `eta_date` (CI `J8`), `remarks` (CI `J11`).

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
  change it. Permission `landed_costs` — held by **Admin, Logistics Coordinator and
  Production** as of 2026-09-16 (this line said "Admin + Logistics" and was stale;
  check `roles` rather than trusting it). Vendor and Freight Forwarder do NOT hold
  it, which is what stops them curling the cost book.
  Month-end view groups by ship month; Copy per-PO split as TSV.
- **Excel export (2026-09-16):** `GET /landed-costs/{sms,mainline}/export?month=`,
  same `landed_costs` gate as the read model — the spreadsheet is the same
  commercially sensitive data in a different container. Built in
  `landedCostExport.js` from the SAME rows `getSms`/`getMainline` render, so the
  file cannot disagree with the screen, and STREAMED (no file on disk to go stale,
  unlike the `/freights` export).
  **BOTH modules export ONE flat sheet at PO grain, for pivoting** (Lam,
  2026-09-16 — it started as two sheets per module and was flattened). Three rules
  make it pivot-safe, and breaking any silently corrupts a pivot rather than
  erroring: **(1)** one row per PO line, with the shipment's attributes REPEATED
  down its lines — that repetition is not redundancy, it is what lets them serve as
  pivot row/column fields; **(2)** every money column at PO grain, so Σ over any
  selection is correct — a shipment-level total column beside them would be counted
  once per PO and overstate a multi-PO shipment; **(3)** NO totals row
  (`addSheet(…, { totals: false })`), because Excel takes the contiguous block as
  the pivot source and a TOTAL row becomes a data row, doubling every measure.
  The two share their first 23 columns EXACTLY (verified) and carry a `Module`
  column, so a mainline export pastes straight under an SMS one. SMS appends its
  two module-only attributes (`Supplier`, `Season`) AFTER that block rather than
  interleaving them — mainline's read model carries neither, and two permanently
  blank columns on that export would read as a bug to whoever opened it. SMS's
  `Shipment #` holds the tracking number (the same substitution
  `smsDocumentService` makes) and its `Carrier Ref #` is blank, that field being
  mainline-only. SMS also falls back to zero-amount lines when a consignment has no
  shipping data — its split is apportioned by CI value and would otherwise be
  empty, dropping the row from the export; the Status column says why it is zero.
  The button sits beside the month filter and exports **what the
  filter is showing**, not the whole book. Frontend: `landedCostExportHref` in
  `lib/api` → the `/api/documents` proxy (the allowlist pattern permits only
  `?month=`, not arbitrary query). Verified against the live read model: SMS 42 PO
  rows / 25 cols, mainline 16 / 23, both with 0 blank rows, no TOTAL row, a single
  `Module` value, and Σ of every money column equal to the API (SMS CI 81,386.93 ·
  freight 25,960.72 · duty 21,325.61 · commission 13.21; mainline 459,674.54 ·
  27,293.54 · 90,421.11 · 916.41); shared 23-column prefix byte-identical between
  the two; `?month=` filters; no token → 401.
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
the INFERRED floor is capped at `ordered` so an over-receipt can't drive
`remaining_qty` negative, while `recorded` is NEVER capped so a genuine over-SHIP
still shows (PO04823 ships 125 against 121).
⚠️ The over-receipt this cap was written against — "PO04800: 352 received against
200 ordered" — **was not real**: 172 of those units came from IR65894, an Item
Receipt deleted in NetSuite that the upsert-only fold never removed (fixed
2026-09-10, see the receipt-prune note below). PO04800 now reads 180/200. Keep the
cap anyway — it is cheap and a true over-receipt is possible — but do not cite that
PO as evidence of one.
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

## Mainline forecast = PLAN vs ACTUAL over the full order book (2026-09-10)

`/forecast` used to answer one question — "what is still incoming?" — with one
number per week. It now carries the **SAME units on TWO dates** so the page answers
the planning question directly:

- **plan** — every unit on its PO leg's stated E-DEL. What was ORDERED to happen.
- **actual** — the best-known date: the derived NetSuite ATA once it has landed,
  else the **SHIPMENT's** E-DEL once booked and shipped, else the leg E-DEL when
  nothing has shipped (no better information exists).

The gap between the two IS the slippage. ⚠️ **A unit appears in BOTH series, so
each totals the whole order book — they are NOT mutually exclusive and must never
be added together.** Live: plan 264,349 / actual 264,948, W30 planned 69,864 but
only 37,114 landed there, and **39,867 units arrived in W31/W32/W34/W35 — weeks
with no plan at all**. 40,468 units slipped later, 2,467 earlier.

- **⚠️ RECEIVED UNITS ARE NOW INCLUDED — the deliberate reversal of the old
  behaviour.** The controller used to `continue` on any shipment with a derived
  ATA, because receipted goods are in stock rather than incoming. That made the
  actual series structurally EMPTY: all 9 mainline shipments are receipted, so
  there was nothing to compare the plan against (the same root cause as the
  `cartons: 0` puzzle below). Consequence to know: `/forecast` is the full order
  book, **NOT an incoming-only view**, and its grand total includes goods already
  in the warehouse — so the UI leads with **Still to Arrive** (222,013), not the
  raw total, and `stage` says which is which.
- **`stage` is the confidence ladder, FIVE rungs since 2026-09-18:** `Received` →
  `In Transit` → **`Booked — Not Shipped`** → `Booking Pending` → `Awaiting Booking`.
  `Booking Pending` tests the booking's STATUS, the same test
  `mainlineReportController` step 2 makes — deliberately NOT "a junction row
  exists", which would label rejected and cancelled bookings as pending.
- **⚠️ A CANCELLED consignment is not incoming, and its units are not unbooked
  either** (2026-09-18). Both rollups used to count one as live: `/forecast` read
  SHP-10's 1,000 units as `In Transit` in W43 (the only In-Transit row in the whole
  order book) and `/reports/mainline` emitted a `Cancelled`-stage row graded on the
  timeliness cascade. Now the cancelled junction rows are split out of the shipped
  pass and land in the new stage, which means **an approved booking with no
  consignment carrying it**. It sits above Booking Pending (a supervisor has signed
  it off) and below In Transit (nothing is moving), and it is **NOT `backed`** —
  `backed` stays exactly `Received` + `In Transit`, the units a real shipment stands
  behind. Two conditions, both load-bearing: the units count only while the BOOKING
  is still `Booking Approved` (cancel that too and they are genuinely unbooked
  again, so step 3 takes them), and the forecast **splits** the remainder rather
  than labelling it by whichever booking touches the leg — a partly-shipped leg's
  uncommitted units must stay `Awaiting Booking`. Capped at the remainder so the
  split can never exceed what is actually left.
  Measured on the live book: the 1,000 units moved from `In Transit` to
  `Booked — Not Shipped` and **every other figure is byte-identical** (Awaiting
  Booking 222,013 · Received 42,935 · backed 42,935 · 17 weeks · Σ lines === actual
  on every week · 0 weeks where backed > actual). Report rows unchanged in count —
  one `Cancelled` row became one `Booked — Not Shipped` row at the same qty.
  ⚠️ The label carries an EM DASH and no comma, deliberately: these tables are
  copied as TSV/CSV and a comma inside a stage value would split a column.
- **The unshipped remainder has actual == plan, contributing ZERO slippage.** That
  is the honest answer: an unbooked leg has not slipped, it has not been committed
  to yet. Slippage therefore only ever comes from legs that actually shipped.
- **⚠️ THE TWO GRAND TOTALS DO NOT MATCH (+599), and that is real data.** Plan sums
  `allocated_qty`; actual sums what shipped plus what is left. The difference is
  genuine over-shipment on three legs (38 +30, 57 +120, 77 +449). Do not clamp it
  — an over-ship is something a planner needs to see, and G2 permits it by design.
- **A week exists if EITHER series lands there**, so a consignment that slipped out
  of its planned week leaves its plan figure behind in it. That residue is the
  entire point; without it the comparison would silently self-heal (12 weeks → 17).

### Cartons, and why 0 is usually TRUE

Cartons exist **only on the actual series**. A carton is known once a packing list
is uploaded, which happens when a consignment SHIPS — a plan has no cartons and an
unbooked leg has none either. Before received units were included this made every
week read `cartons: 0`, which looked broken: the carton-bearing window was exactly
"shipped, not yet received", and it was empty. The join was never wrong — 16 of 17
shipment legs have matching `(booking_id, leg_id)` carton rows (the miss is
shipment 1 / leg 50, no upload). ⚠️ **Do NOT estimate cartons from units**: only
27% of forecast SKUs (726/2,736) have packing history and 622 of 748 packed SKUs
have an inconsistent `pcs_per_ctn` (range 4–230, median 39, mean 50) — a flat
divisor would put a confident wrong number into a warehouse capacity plan. The
Cartons metric hides the Projected/Δ columns instead, since there is no plan
figure to compare against.

### `backed` — the shipment-grounded foundation (a SUBSET of `actual`)

A third series per week holding only the units a REAL SHIPMENT stands behind
(stage `Received` or `In Transit`) — i.e. an approved booking, as opposed to a
date typed on a PO nobody has committed to. Received and In Transit both qualify:
the evidence is that the shipment EXISTS, not that it has landed.
⚠️ **`backed` ⊆ `actual`. Never add them.** `backed.units / actual.units` is the
week's CONFIDENCE and is the honest answer to "does this forecast have a
foundation?".

**Why it is carried rather than making the forecast shipment-only** (which is
what Lam initially proposed, and the principle is right): bookings are currently
recorded RETROSPECTIVELY. Measured 2026-09-15 — median lead time from booking
approval to the shipment's own E-DEL is **−5 days**; **8 of 9 bookings were
approved AFTER their E-DEL**, 5 of 9 after the goods had already landed (only
shipment 1 was booked prospectively, +25 days). So shipment-backed units in the
FUTURE total **0**, against 42,935 in the past — a shipment-only forecast would
be a history table with nothing forward in it. Same retrospective-entry pattern
as SMS (88 of 120 POs have receipts and no portal consignment). **That is a
PROCESS gap, not a modelling one** — no restructuring makes the shipment table
predictive while bookings are entered after the fact. Booking-before-ship is the
stated intent (confirmed by Lam 2026-09-15), so the split is built to tell the
truth now and become shipment-dominant on its own as discipline moves earlier.

- **UI:** a **Backed** column (units · % of Actual) on every week, a
  **Shipment-Backed** basis toggle beside Units/Cartons, and the confidence % as
  a KPI card (it replaced Destinations, which the matrix already shows per row).
  Live today: **16%** overall, and the booked pipeline runs only to W36.
- **In backed mode the plan comparison is DROPPED, not recomputed.** `plan` covers
  every leg, so setting it beside a filtered subset would invent slippage that
  isn't there. Backed mode answers a different question — "what is actually
  committed?" — so Projected/Δ/Backed collapse to a single Total, and weeks with
  nothing booked are omitted rather than rendered as a row of dashes.
- The drill-down follows the basis (`isBacked` on `stage`), so Σ lines still
  equals the row it opened in either mode.
- ⚠️ In the Backed cell the separator between units and percent is **real text
  (` · `), not margin** — with only a CSS gap the cell's `textContent` reads
  `"13,744100%"` to a screen reader and to anything copying the table. The Copy
  buttons on this page make that a correctness issue, not a polish one.
- **Verified:** `backed` reconciles with its own lines AND all three of its maps,
  is ≤ `actual` on every week, backed cartons == all cartons (1,452 — cartons
  only ever exist on shipped units anyway); in the GUI 0 backed>actual
  violations, backed mode shows 5 weeks summing to 42,935 = footer, drill-down
  stages are `Received` only, comparison columns correctly dropped.

### Season filter: the rollup is RE-RUN per season, not filtered client-side

`GET /forecast` returns `{ seasons, by_season: { all, FW26, … } }` — the whole
weekly rollup pre-computed for every season plus the unfiltered view. The
expensive joins (ATA resolution, receipt matching, carton sets, status lookups)
run ONCE; only the cheap aggregation loop repeats, so the payload stays small and
switching is a client-side lookup with no refetch.

**Why not filter client-side** (which is what `/reports/sms/forecast` does): the
plan series is LEG-grained while `lines[]` is PART-grained, so the browser would
have had to re-derive the plan and reconcile the two by hand. Re-running the
server rollup means every series, all three breakdown maps, the cartons, the
slippage and the drill-down come from the SAME code path as the unfiltered view
and are exact by construction. Verified by stubbing half the TRN masters onto a
second season in memory: SS27 12 weeks / FW26 13 / all 17, units **and** cartons
partition EXACTLY (125,834+138,515 = 264,349 plan; 1,027+425 = 1,452 cartons),
zero cross-season leakage into any view, and each view still reconciles
internally.

- Season is DERIVED at read (leg → `po_orders.trn_number` → `po_masters.season_id`
  → `seasons.code`), per the 3NF rule, and rides on every drill-down line.
- ⚠️ **`seasons` lists only what the ORDER BOOK holds, never the seasons master.**
  The master has FW26/SS27/FW27; mainline legs are **100% FW26** today. Defaulting
  to the newest master season would open the page on an empty forecast — the
  default is the newest season PRESENT, matching `seasonRank` in
  `components/SeasonScopeFilter` so this page orders like the lifecycle tables.
  Consequence: the dropdown offers one real option until SS27/FW27 legs land.
- The control sits in the PAGE HEADER, not the breakdown toolbar, because it
  governs the KPIs and the chart as well as the matrix.
- No Active/All scope toggle here — the equivalent axis is `stage`, and the
  Still-to-Arrive KPI already separates received from incoming.

### Breakdown grain: supplier is a column, PO# is a drill-down

Cardinality decides this — warehouse 2, supplier 13 (≤5 per week), TRN 25, **PO#
63 (26 in W26 alone)** against a matrix 2 columns wide. Supplier fits the existing
layout; PO# is the **row drill-down** under each week. PO# is also the LEAF, not a
peer axis: `facility_id` and `allocation_channel_id` are `po_orders` attributes,
one per PO, so PO# subsumes both existing toggles.

- **`lines[]` is keyed to the ACTUAL week**, so Σ `lines.units` === `actual.units`
  and the drill-down can never disagree with the row it opened. It is deliberately
  NOT the plan week — the matrix cells are the actual series. Each line carries
  `plan_date` / `actual_date` / `slip_days`, so the row explains the week's Δ.
- Top-level `units`/`cartons`/`warehouses`/`warehouse_channels`/`suppliers` are
  **mirrors of `actual`**, keeping the matrix, the drill-down and the Actual column
  reading one figure.
- Chart is two lines: Actual filled + solid, Projected **unfilled, dashed and
  NEUTRAL-coloured** — two filled areas would imply a sum, and `--chart-1`
  (#ef4444) / `--chart-2` (#f87171) are both reds in the active theme, so the
  series would have separated only by dash pattern.
- **Verified:** Δ arithmetic correct on all 17 weeks; Σ lines === Actual on every
  week; all three breakdown maps reconcile against BOTH series; footer reads
  264,349 / 264,948 / +599; W32 drill-down shows Received + SHP-6/7 + planned
  2026-07-22 → actual 2026-08-05 (+14d) with cartons; Cartons mode hides the
  comparison; no console errors.

## Item Receipts: the sync MATCHES NetSuite, it does not accumulate (2026-09-10)

Both receipt folds were **upsert-only** — keyed on `netsuite_ir_id`, they refreshed
what NetSuite returned and inserted what was new, but never removed. So the normal
NetSuite correction (delete an IR, post a replacement) left the portal holding
BOTH and summing them: **PO04801 read 658 received against NetSuite's 329**
(IR65999 315 + IR66000 14 + IR66023 329), and mainline had the same two phantoms.
Received quantity feeds the three-way match, the derived `Received` status, the SMS
report's received floor and the landed-cost push target, so this was not cosmetic.

`utils/pruneStaleReceipts` (pure, shared — one sentence about NetSuite ownership,
not module logic) now runs inside both folds: **within the PO scope the receipt
query just covered, the fetched set is the whole truth.** Scope is everything —
SMS scopes to the POs its pull returned, mainline to every held PO with a
`netsuite_id`, and the mainline `foldReceipts` will NOT prune unless the caller
passes `queriedPoNumbers`, because absent that it cannot tell "NetSuite deleted
this" from "nobody asked about this PO". Three exemptions, each load-bearing:
a PO **outside** the scope (else you wipe the receipt history of every PO beyond
the 18-month SMS window), a **`source:'manual'`** row (a human's override, which
may deliberately point at an IR raised against a *different* PO — exactly why the
PO-scoped query won't return it), and a row with **no `netsuite_ir_id`**. A stale
row carrying a CONFIRMED match IS removed — a confirmation pointing at a deleted IR
asserts a receipt that doesn't exist, keeping a consignment Received and postable —
but it is reported in `receipts_removed`, warned in the sync toast and logged.
`scripts/prune-stale-receipts.js` (idempotent, `--dry-run`, `--module=sms|mainline|both`)
cleans up without a sync; it also refuses to read an empty NetSuite answer as
"everything was deleted". **Measured:** SMS 175 → 172 receipts (NetSuite has 172),
mainline 96 → 94 (NetSuite has 94), 0 orphaned lines, all 37 SMS + 16 mainline
confirmed matches preserved, second run removes nothing. The 5 removed IRs were
each verified ABSENT from NetSuite by tranid first.

## Fulfillment `variance` = RECEIVED − SHIPPED (2026-09-16)

`fulfillmentService` computed `shipped_qty - received_qty` at BOTH grains, which
inverts the sign of every discrepancy: leg 77 over-received `TCM4546-6351-L` by one
unit (shipped 46, received 47) and the PO leg detail showed **−1**, while a genuine
one-unit SHORTFALL showed **+1**. Now `received_qty - shipped_qty` — actual minus
expected, so over-received is POSITIVE and short negative, which is how a warehouse
discrepancy is spoken. Both grains must agree; the TRN rollup and the leg view are
separate code paths that each build the row.
Safe to flip because nothing branched on the sign — the only consumer,
`PoLegDetail`, tests `variance !== 0` for its amber highlight. Verified: 0 formula
mismatches across leg 77 (10 non-zero SKUs) and TRN_1267 (385 SKUs), totals
unchanged.

**`remaining_qty` FLOORS shipped at received (2026-09-16)** — the mainline echo of
the SMS report's rule, and for the same reason. `shipped_qty` counts only confirmed
CI packing lines matched to the leg, so a PO received without anyone uploading
shipping data here reads shipped 0, and `allocated − shipped` then claimed the
whole quantity was still to come while the receipts beside it said it had all
landed: **PO04723 leg 81 showed allocated 1,300 · shipped 0 · received 1,300 ·
remaining 1,300**, with zero shipments on the leg. Now
`allocated − max(shipped, min(received, allocated))` → remaining 0. The floor is
capped at allocated so an over-RECEIPT cannot make remaining negative, while
`shipped_qty` itself is never capped, so a genuine over-SHIP still shows negative
(leg 77 stays at −459; it moved from −449 because SKUs like
`TCM6689-6356-XXL`, 12 allocated / 2 shipped / 12 received, correctly went from 10
remaining to 0). Both grains carry it, and `PoLegDetail`'s Remaining card sums the
rows' own `remaining_qty` rather than recomputing `allocated − shipped`, or the
card and the table under it would disagree.
**What `variance` compares against depends on whether a CONSIGNMENT EXISTS**
(Lam, 2026-09-16) — not on whether `shipped_qty` is 0:
- leg **with** a shipment → `received − shipped`, **even when shipped is 0**. A
  shipment that carries nothing while units are received IS the discrepancy, and
  suppressing it would hide the missing packing upload. Live: leg 50 / PO04749 has
  one lot and no packing data, so it correctly reads the full received qty as
  variance.
- leg with **no** shipment → `received − allocated`. There is no shipped figure to
  measure against, so the expectation is the allocation.

Evaluated PER LEG, never for the whole scope: a TRN holds both kinds at once and
one shipped leg would put every unshipped leg on the wrong basis. At TRN/PO grain
the rows are SKU-grained across legs, so the expected quantity is
`shipped_qty + Σ allocated of the legs with no consignment` — `shipped_qty` only
ever accrues from legs with confirmed CI lines, so the two halves cannot
double-count. `fulfillmentController._ctx` loads `mainline_shipment_legs` for this
one question; it is the service's ONLY consumer, so the ctx is always complete —
the `shipmentLegs = []` default would silently put every leg on the allocated
basis, so a new caller must pass it.
Measured: TRN_1267 went from **372 of 385** SKUs showing a non-zero variance to
**17**; legs 81/82 (PO04723, no lots) from 65 and 100 false "over-received" to 0;
leg 77 (4 lots) keeps all 10 genuine discrepancies unchanged; 0 formula mismatches.

**Shipped + Received in the `PO item lines (SKUs)` export (2026-09-16).**
`GET /po/leg-lines` is at (leg, SKU) grain, which is exactly the grain
`reconcileLeg` already derives those two figures at — so rather than a second copy,
the rules were extracted into `fulfillmentService.legActuals(ctx)`, which returns
`shippedByLegSku` / `recvByLegSku` for EVERY leg in one pass, and `reconcileLeg`
now consumes it. A second implementation of "which leg gets credited this receipt"
is how two screens start disagreeing about a discrepancy.
⚠️ `legActuals` is built over **all** legs in `getAllLegLines`, not the
vendor-scoped subset: the receipt split walks a PO's legs in shipping-method order,
so a partial view would credit the wrong leg. The ROW LIST stays scoped by
`loadAll`. Both columns emit **0, not null** — a blank in a column people sum reads
as missing data, not as zero. Verified: 9,982 lines, Σ allocated 264,349 (the
forecast's plan total), and the per-leg sums match the leg page exactly on 77
(12,750 / 12,757), 81 (0 / 1,300) and 50 (0 / 147); the leg page's own variance and
remaining are unchanged after the refactor.

**Received qty PER LOT on the leg detail (2026-09-16).** Item Receipts attach to a
`po_number`, not a shipment, so the per-lot figure comes from the shared
`resolveMainlineReceipts` — the same attribution that decides the ATA and the
landed-cost push target, so all three agree on which IR belongs to which
consignment. Resolved per shipment (the resolver returns only the target for the id
it is asked), with the UNFILTERED shipment table in the pool because the matcher is
competitive. NULL, never 0, when nothing is attributed — "not received yet" and
"received nothing" are different answers and only one is a discrepancy; the cell
goes amber only when both figures exist and differ, and an unconfirmed attribution
is marked `*`. Verified on leg 77: Σ lots = 12,750 shipped / 12,757 received,
exactly the leg totals, with the +7 traced to Lot 1 −3, Lot 3 −2, Lot 4 +12.

**The SKU and Variance headers ARE the filters (2026-09-16).** That table runs to
hundreds of SKUs (374 on leg 77) and the question asked of it is almost always
"which ones are off?". So there is ONE header row and no filter strip: the SKU
cell holds an input whose placeholder is the column name, and the Variance cell
holds a select that reads `Variance` while unset and the active filter
(`Discrepancies` · `Over-received` · `Short`) once set, tinted `text-primary`.
The header is therefore the label AND the current state. The SKU box matches the
ITEM NAME as well as the code — staff search by style as often as by SKU.
Three rules the next edit must keep:
**(1)** the totals row sums the rows **ON SCREEN** (`shownRec`), never
`reconcile.totals` and never the full filtered set — a footer summing 374 SKUs
under a body of 15 is read as the total of those 15; the label says `N of M SKUs`
whenever the body is a subset, from a filter OR the top-15 cap. Whole-leg figures
stay one glance away in the Stat cards, which are deliberately NOT filtered.
**(2)** a filter shows EVERY match, never the first 15 — capping would hide the
rows just narrowed down to. **(3)** the "Show all N SKUs" toggle is hidden while
filtering, since it would offer to expand a list that is not truncated.
Verified in the GUI: 1 header row; top-15 footer `15 of 374` / 744·853·853;
Show all `374` / 12,301·12,750·12,757·+7; Over-received 5 rows / +15 with the
header reading "Over-received"; + SKU `TCM6689` → 2 rows / +12; no match → empty
state and a 0 footer; 0 console errors.

## Known debt / deferred

- `/forecast` (mainline) now runs on LIVE migrated data via
  `modules/mainline/reports/mainlineForecastController.js` (leg-grained weekly
  inbound × facility; shipment legs by E-DEL, unshipped remainder projected onto
  leg E-DEL, cartons from confirmed packing). Same `/forecast` endpoint + output
  contract → UI unchanged. `controllers/reportController.js` and the
  `purchase-orders.json` snapshot were DELETED 2026-09-21 (dead since the
  forecast rebuild; the `purchase_orders` table was dropped with them).
  `/reports/sms` + `/reports/sms/forecast` built. DHL tracking pending credentials.
- Component-level permission checks still use hardcoded role names in some
  detail components (e.g. `RoleSettings`/`UserSettings` test `role === 'Admin'`).
  Page ACCESS is permission-driven end to end as of 2026-09-08 — nav via `can()`
  and the route itself via `src/proxy.ts` + `lib/pageAccess` (see Auth below).
  Changing a user's ROLE still needs a re-login: the JWT carries the role name and
  permissions are resolved from it, so the old role applies until the token expires.
- ✅ RESOLVED (2026-09-21): the EOM tasks module is GONE — route, controller,
  model, validator, the empty `eom_tasks` table and the `eom` permission key
  (which offered an "EoM Progress" checkbox for a page that did not exist).
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
carries one SKU at both 26.25 and 49. Mainline's `po_order_lines` held the same
declared unique and was clean (0 / 11,871) only because its POs happened to have
one line per item — so **don't copy that declaration to a NetSuite-sourced table.**
⚠️ **That prediction came true on 2026-09-23** — see "the mainline sync broke on
the same grain bug" below. The warning was right; the table was fixed the same way.
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

## ✅ SEQUELIZE ORM over PostgreSQL (2026-09-21). JSON is SEED INPUT ONLY.

Records live in PostgreSQL (`tentree_portal`), mapped by **Sequelize models in
`backend/models/`** — 61 models, 75 foreign keys, one file per table, sitting in
the MVC models directory beside `controllers/` and `routes/`.
**Those models are the AUTHORITY on the schema**: add a column by editing a
model, never by editing JSON. `backend/database/README.md` is the source of truth for
this layer; `backend/database/QUERIES.md` has how to connect plus worked example
queries — read it before writing SQL, because most of what the UI shows is
DERIVED per read and is not a column.

**`backend/database/seed-data/` is SEED INPUT and nothing else.** Nothing reads it at
runtime; `DATA_BACKEND` is gone, as is `driveStorage`. Only the **19
reference/master tables** (~5,000 rows) are genuinely seed data. The
transactional files are a stale snapshot from migration day (2026-09-14) —
loading them does not restore current state, it rolls the portal back to that
date. Use `pg_dump` for a restore. `node database/init.js` loads reference data;
`--all` also loads the snapshot, and refuses a non-empty database without
`--force`.

- **The swap is at ONE chokepoint.** Every module goes through
  `models.<table>.read()/.write()` → `database/modelStore`, which hands back the
  same plain objects the JSON stack did. **No controller, service or report
  changed** — reads still pull whole tables and derive everything per request,
  exactly as the 3NF discipline above describes. Verified on live data: all
  tables, **value-for-value identical** to the raw-SQL path
  (`node db/verify.js` — run it after ANY change in `db/`).
- **Tables are reached as `models.<table>`** (`db/models` → `backend/models`).
  `models/BaseModel.js`, the five `*Model.js` facades and the
  filename-as-table-key shim (`'migrated/po_orders.json'`) are all DELETED.
  `models/index.js` attaches two statics to every model:
  `await models.po_orders.read()` and `await models.po_orders.write(rows)`.
  **`write()` REPLACES the table** — a row missing from the array is deleted —
  which is the semantics all ~190 call sites were already written for. For
  anything narrower use the ORM directly: `models.users.findOne({ where: { email } })`.
  ⚠️ `db/modelStore.js` must NOT require `../models` at the top: `models/index.js`
  requires IT (lazily, inside read/write), so a top-level require is a cycle.
- **⚠️ camelCase GOES ALL THE WAY DOWN (2026-09-21).** The 218 snake_case
  columns were RENAMED in Postgres, so an attribute IS a column, there is no
  `field:` mapping, and nothing is translated at any boundary. **API responses
  are camelCase and the frontend moved with them** — measured 0 snake_case keys
  across 24 endpoints. Scale: 5,909 identifiers over 170 files.
  ⚠️ **Identifiers must be QUOTED in hand-written SQL now** — Postgres folds
  unquoted names to lowercase, so `SELECT poNumber` becomes `ponumber` and
  errors. Sequelize always quotes; `db/QUERIES.md` examples do not and need
  updating before reuse.
  ⚠️ **There is deliberately no `snake()` helper**: four columns in
  `nri_order_master` (`orderNo`, `custCode`, `custName`, `orderType`) were
  ALREADY camelCase, so a regex round-trip would "restore" them to `order_no`
  and friends — columns that have never existed.
- **⚠️ THREE FILES ARE EXCLUDED FROM THE camelCase CONVENTION, deliberately:**
  `services/integrationService.js`, `modules/landedcosts/netsuiteLandedCost.js`
  and `services/fedexService.js`. In them the OBJECT KEYS are ours and camelCase,
  but every `row.*` / `e.*` read is an **external field name** —  SuiteQL aliases
  (`t.tranid AS po_number`), NetSuite custom fields (`custbody_*`,
  `landedCostMethod`) and FedEx API fields. **NetSuite lowercases returned
  aliases**, so renaming a SELECT alias to camelCase yields `undefined` on every
  field, silently. `SKU_ATTR_COLUMNS[].key` IS a SQL alias and stays snake_case;
  it is camelised only at the point it becomes a property.
- **⚠️ `transit_time_standards.segment` VALUES were migrated too.** They are data
  that the code keys on (`std[s.key]`), so renaming the code constants without
  the 10 rows left every standard reading null — silently. Now
  `productionHandover` / `originDwell` / `portToPort` / `destinationLeg` /
  `receiving` in both places.
- **`models/index.js` SKIPS `*Model.js` by name.** That directory also holds the
  legacy facades — all now DELETED, but the rule stays because the three
  surviving `*Models.js` MANIFESTS in `modules/` follow the same name — which
  export an object or a class rather than a
  `(sequelize, DataTypes)` factory. A duck-typed check would not save you —
  `BaseModel` is a class, and a class IS `typeof "function"`, so it would be
  called without `new` and throw.
- **⚠️ Sequelize RE-PARSES two types wrongly and both failures are SILENT.**
  It returns `DECIMAL` as a **string** (`"57.82"`) and `timestamptz` as a JS
  `Date`. This codebase is built on `(m.get(k) || 0) + (l.allocated_qty || 0)`,
  so a string means CONCATENATION — 28 + 5 becomes `"285"` and a forecast gains
  250,000 units without anything throwing. `db/types.js` pins node-pg's parsers
  AND `db/modelStore.js` decodes a second time against each model's declared
  types. Both layers are load-bearing; `db/verify.js` is what proves it.
- **⚠️ `deferrable` MUST sit INSIDE `references`.** As a sibling key Sequelize
  accepts it silently and ignores it — measured: all 79 FKs came out
  `condeferrable=false`, and seeding then failed on the first child whose parent
  had not loaded yet. See the deferred-FK note below for why that is fatal.
- **⚠️ QUOTE camelCase identifiers in hand-written SQL.** Postgres folds unquoted
  names to lowercase, so `updatedAt` becomes `updatedat`. This silently broke
  every `_documents` write (`INSERT INTO _documents (… updatedAt)`) and was only
  caught because a fresh-database build exercised it — the live path is rare
  enough that nothing noticed. `database/QUERIES.md` carries a banner: its
  example queries predate the rename and must be quoted before reuse.
- **An unknown key is REFUSED, not dropped.** Sequelize writes only declared
  attributes, so a field with no column would vanish silently. `writeData`
  throws instead, naming the model file to edit.
- **Rows are RECTANGLES now — a key absent from a sparse JSON row reads `null`,
  not `undefined`.** 289 such cells across 18 API field paths (`db/verify.js`
  lists them; e.g. `users.role_id`, `sms_shipments.booking_id`,
  `suppliers.address`). **No VALUE changed** — verified 0 differences across all
  65 tables / 83,856 rows and all 32 read endpoints. Safe because every consumer
  here tests these with `||`, `??` or truthiness, where null and undefined are
  the same; the code that genuinely distinguishes them (`nriInvoiceService`'s
  `l.gl === null`) is helped by this, not hurt.
- **⚠️ The type parsers in `db/types.js` are LOAD-BEARING.** node-pg returns
  `date` as a JS Date at LOCAL midnight (so `"2026-05-06"` →
  `2026-05-06T07:00:00.000Z`, i.e. every CRD/E-DEL/HOD shifts a day) and
  `numeric` as a **STRING**. Both are pinned; do not remove them. They are NOT
  sufficient on their own — see the Sequelize re-parsing note above.
- **`_seq` carries row ORDER.** SQL has none, and this codebase depends on the
  array order in places it states outright (`plGenerator` takes `rows[0]`,
  the receipt matcher walks "first still-free IR", and the sms_cartons note above
  records row order changing 25 of 34 packing summaries). Every read is
  `ORDER BY _seq`; the column never reaches a caller. On the **7 tables with no
  natural key** it is also the PRIMARY KEY — Sequelize requires one, and `_seq`
  is NOT NULL and unique by construction (assigned 0..n-1 on every write), so it
  closes that gap without inventing an `id` column the table does not have.
- **`sms_tracking_events.event_time` is `text`, deliberately** — the only column
  where the dbml's type was rejected. Values carry real offsets
  (`2026-07-13T13:02:00-08:00`); through `timestamptz` they return as UTC, a
  DIFFERENT string, and `smsTrackingService.js:31` dedupes incoming courier scans
  on `${shipment_id}|${event_time}|${courier_code}` — so every poll would
  re-insert every event. Same reasoning put the JSON-valued columns on `json`
  rather than `jsonb`: jsonb reorders object keys.

### ⚠️ The mainline sync broke on the same grain bug (2026-09-23)

`POST /po/sync/netsuite` aborted on every run with
`duplicate key ... po_order_lines_po_number_sku_code_uniq`. **PO04826 repeats 399
SKUs** (804 lines, 405 distinct items) — NetSuite splits one item across PO lines
exactly as the `sms_po_lines` note above describes. The unique had held only
because no mainline PO had done it before; the first one that did stopped the
sync dead, and nothing else fires it, so it simply went stale.

Fixed the way that note prescribes:
- `(poNumber, skuCode)` demoted to a **plain lookup index** — never unique on a
  NetSuite-sourced table.
- `po_order_lines.netsuiteLineId` added, and `(poNumber, netsuiteLineId)` is the
  unique key (verified 0 duplicates over 4,076 synced rows).
- Row ids are now `pol_ns_<poNumber>_<lineId>` — **stable across syncs**, ending
  the ~12k-row renumber every run.

⚠️ **`netsuiteLineId` IS A PER-PO SEQUENCE (1, 2, 3…), NOT a global id** — the
same trap the SMS fix fell into. Measured: 4,096 live line rows carry only **804
distinct values**, so keying or id-ing on it alone collapses 4,096 rows onto 804.
The PO number MUST be part of both. (`tl.id` in SuiteQL is the line number within
the transaction, not a global key.) Rows synced before this keep a null
`netsuiteLineId`; Postgres allows many NULLs in a unique index, so mixed data
loads and each PO fills in on its next sync.

Measured after the fix: +5 POs / +1,628 lines, re-run idempotent (13,574 →
13,574), R1 protect-if-booked still holds `PO04840`.

⚠️ Sync also warns `unresolved facility "NRI CA First Inventory"` on 13 POs — a
NetSuite warehouse with no `warehouse_facilities` row. Non-blocking, but those
POs carry no destination until it is mapped.

### ⚠️ Deleting a module wrapper needs `no-undef`, not grep (2026-09-23)

Removing the vestigial `*Model.js` wrappers broke three files that imported them
under a **different local alias** (`ItemReceiptModel`, `M`) — grepping for
`MainlineItemReceiptModel.method` reported 0 call sites and missed every one. The
codemod deleted the `require` and left the alias dangling, which took out the
NetSuite sync, `/mainline/fulfillment/:trn` (→ every TRN page 404'd) and receipt
matching. **`node --check` cannot catch a `ReferenceError`.** Use:

```bash
npx eslint@8 --no-eslintrc -c /tmp/eslintrc.json --ext .js \
  modules routes services utils models database scripts server.js   # rule: no-undef
```

### ✅ RESOLVED at the migration

- **No transactions** → **one transaction per WRITE request**
  (`db/txContext.js`, mounted above every router in `server.js`). Booking
  approve, the 5-table shipping-data upload and the SMS shipment header+junction
  now land whole or not at all; the transaction settles BEFORE the response body
  goes out, so a failed COMMIT becomes a 500 rather than a success the client was
  already told about. GET/HEAD skip it. Cron ticks and maintenance scripts are
  not requests, so they ask via `db/tx.js` `atomically()`.
  ⚠️ The ambient object is a **Sequelize `Transaction`**, not a raw pg client.
  It had to move when the models arrived: Sequelize owns its OWN connection
  pool, so a model query would have run on a DIFFERENT connection than that
  client — outside the transaction, self-committing, with the ambient BEGIN
  having no effect. Nothing would have thrown; the atomicity would simply have
  been gone.
- **Foreign keys exist and bite** — `DEFERRABLE INITIALLY DEFERRED`, checked at
  COMMIT. They MUST be deferred: `writeData` replaces a whole table
  (DELETE-all + INSERT-all), so any write to a parent momentarily removes every
  row its children point at. **Never make one `ON DELETE CASCADE`** — it would
  fire on that routine DELETE-all and take every child row with it.
- **Two delete paths were leaving orphans, which the FKs surfaced.**
  `DELETE /mainline/bookings/:id` cleaned 4 tables and stranded the commercial
  invoice, the packing cartons and the generated documents — **8 of 9 live
  bookings carry all three**, and CI lines and the packing summary are DERIVED
  from `mainline_packing_cartons`, so the orphans kept contributing to totals for
  a deleted booking. `DELETE /mainline/shipments/:id` cleaned only the junction,
  stranding ASNs, receipt matches and rejections. Both now use
  `modules/mainline/shipments/shipmentCleanup.js`, which encodes the one
  distinction that matters: the ASN and the rejections are artifacts OF the
  shipment and are DELETED, but `mainline_item_receipts` are NetSuite's record of
  goods that physically arrived — they are only UNLINKED
  (`matched_shipment_id`/`confirmed_*` cleared). `smsShipmentController.remove`
  gained the same cleanup for `sms_receipt_match_rejections`.
- **Maintenance scripts go through the models** (`prune-stale-receipts`,
  `prune-rejected-pos`, `backfill-po-approval-status`). They read `data/` with
  `fs` before, which after the cutover would have pruned the frozen snapshot and
  reported a cleanup the live portal never received. Their multi-table writes are
  wrapped in `atomically()`. Re-verified live against NetSuite after the move:
  approval 65 Approved / 16 Pending (0 changes), receipts 94 mainline / 173 SMS
  (0 stale), 0 rejected POs.

### Resolved earlier (kept for the reasoning)

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

### Still open

- **ID generation races:** `Math.max(id)+1` patterns collide under concurrency.
  → SERIAL/IDENTITY. Not addressed: the ids are the app's own strings
  (`mll_15_SKU`, `SHP-6`) and changing them is a data migration, not a schema
  switch.
- **`mainline/statuses.js` in-memory cache** never invalidated after a
  statuses.json edit (restart required). → drop cache.
- **Constraints the live data could NOT satisfy** (created as far as the data
  allows; the survivors are recorded in `db/schema.json` `notes[]`).
  ⚠️ **Every table now HAS a primary key** as of 2026-09-21 — the 7 that had none
  are keyed on `_seq` (see the `_seq` note above). That closes the "no PK" half
  of the entries below; the GRAIN problems they describe are unchanged, because a
  key on `_seq` says nothing about `id` or `(leg_id, sku_code)` being unique:
  - `mainline_po_leg_lines` — **no `(leg_id, sku_code)` unique**: 22 rows
    duplicate both, on legs 15/45/85 (e.g. `mll_15_TCM6948-6346-L` at 28 and 5).
    Same class as the `sms_po_lines` grain bug above. **Currently harmless to
    every total** — all five consumers (`legCapacities`, `fulfillmentService` ×2,
    `legReconciliationService`, both report controllers, `wipImportController`)
    sum with `+=`, which is also what makes merging them a numerically neutral
    fix.
  - `sms_po_lines` — **`id` is not unique**: `netsuite_line_id` holds the PO's line
    SEQUENCE ("1".."245", 245 distinct over 4,961 rows), not NetSuite's global
    `transactionline.id`, so `id = spol_ns_<line_id>` collapses 4,961 rows onto
    245 ids. **The 2026-08-14 note above describes the intended fix, but the
    value being stored is the wrong one** — the grain bug moved rather than went
    away. `(po_number, netsuite_line_id)` IS unique (0 repeats within any of the
    120 POs) and is created instead. Fix = regenerate ids as
    `spol_ns_<po_number>_<line_id>` and store the real `tl.id`.
  - `landed_costs` — the dbml's `(module, shipment_id)` unique is **wrong, not
    violated**: mainline posts PER PO (all 16 rows carry `po_number`, ids read
    `lc_ml_<shipment>_<po>`) while SMS posts per shipment (38 rows, `po_number`
    null). `(module, shipment_id, po_number) NULLS NOT DISTINCT` has 0 duplicates
    and still blocks the SMS double-post the 409 depends on. **Update the dbml.**
  - `po_order_lines.sku_code → product_skus.sku_code` — **FK not created**: 2,233
    rows (15 of 81 POs, 207,976 units) reference 2,232 SKUs absent from the
    master. Confined to forecast-stage POs — **none of those SKUs appear in any
    leg line or packing carton**, so no CI, packing or landed-cost path touches
    them; they resolve when those POs are WIP-imported. SMS is clean (0/4,961).
    `mainline_item_receipt_lines.sku_code` has the same gap for 3 rows
    (`TRF3399-0558-ONE`, `TRF3398-0558-ONE`) — those ARE goods received against a
    SKU the master does not know.
- **`.catch(() => [])`** read paths treat I/O errors as empty tables. Now a real
  hazard rather than a theoretical one: a DB error becomes "the table is empty"
  instead of propagating. → let DB errors propagate.
- **`force_overbook`/`force_overship`** bypass G2 by design (client shows the
  warning dialog) — intentional, documented so it isn't "found" again.
- Row-level invariants to enforce with triggers: a PO is mainline XOR SMS
  (table membership); `(po_number, lot_number)` unique in `sms_shipment_pos`.

## Project Layout

```
backend/                     Express API on PostgreSQL + Sequelize (MVC)
  models/                    THE SCHEMA AUTHORITY — one Sequelize model per table.
                             camelCase attrs == camelCase columns (no `field:`).
                             .read()/.write(rows) attached by models/index.js
  database/                  the data layer — modelStore (readAll/replaceAll),
                             per-request transactions, verify.js, generateModels.js.
                             See database/README.md.
    init.js                  build the schema FROM THE MODELS + seed. `--all` also
                             loads the snapshot; `--export` REGENERATES seed-data
                             from the live DB — re-run after ANY column rename or
                             the JSON silently stops being loadable.
    seed-data/reference/     20 tables, ~5.1k rows — REAL seed, an empty DB needs it
    seed-data/snapshot/      41 tables, ~79k rows — transactional copy, NOT seed
    seed-data/documents/     whole-file blobs (notification_seen) -> `_documents`
  storage/                   FILES, not records. See storage/README.md.
    uploads/  templates/     ⚠ BOTH SERVED over HTTP (below the auth gate;
                             /templates also refuses Vendors). Do NOT put anything
                             commercially sensitive in templates/.
    reference/               NOT served — signed agreements, NRI source workbooks
    converted-docs/ archive/ source spreadsheets; superseded backups
  modules/                   ONE FOLDER PER FEATURE — see modules/README.md.
                             12 features incl. auth, users, roles, contacts,
                             freights, masterdata (moved out of controllers/
                             2026-09-22, so there is now ONE scheme, not two).
                             Layer is the FILENAME SUFFIX (*Controller/*Service/
                             *Routes/*Validator), not the folder.
  controllers/               EMPTY — holds only a README pointing at modules/,
                             because that is where people look first.
  modules/po/                mainline PO hierarchy (WIP-sourced; NS sync ACTIVE)
  modules/mainline/          bookings, shipments, ci/packing/asn, fulfillment, reports, wip import
  modules/sms/               SMS module (own dataset) + NetSuite sync + FedEx poll
  modules/nriinvoices/       3PL invoice verification — "All Invoices" (own tables
                             under data/nri/). ONE TAB PER INVOICING WAREHOUSE from
                             nri_invoice_sources.json; `parser: null` = shell, uploads
                             refused with a reason (a 3PL's workbook layout must be
                             mapped in code). API stays /nri-invoices, UI is /invoices
                             — see that module's README, which is the source of truth.
  services/                  CROSS-CUTTING only — integrationService (SuiteQL),
                             fedexService, ciParser, wipParser, asnService,
                             ci/plGenerator, cronJobs. A service with exactly ONE
                             consumer belongs in that module instead.
  routes/                    only the 4 that span several modules: reports,
                             forecast, notifications, documents
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
- **⚠️ An expandable row's detail lines must be ROWS OF THE PARENT TABLE**, not a
  nested `<table>` in a `colSpan` cell (mainline Shipments, 2026-09-16). A nested
  table computes its own column widths from its own content, so every expansion
  lined up with itself and with nothing else — not with the other expansions, and
  not with the parent columns the values break down. Emitting a `<TableRow>` per
  detail line and mapping `visibleCols` puts each value in its parent's column for
  free, and follows the Column picker's hide/reorder without extra code. The target
  columns are looked up by key (`pos`, `total_qty`) with a first/last visible
  fallback, so hiding one relocates the value rather than losing it. Live: 17 child
  rows under 9 parents, 0 off-column on either axis, and the legs visibly sum to
  the parent's Total Qty (861 + 694 = 1,555).
  The detail's PO/Mode/Channel header row went at the same time: **Mode was pure
  noise** — shipment grain is `(booking, facility, MODE)`, so every leg in the
  expansion carries the same one and it is already a column on the parent row.
- **Radix Select gotcha:** `<SelectValue>` can't derive a label when options
  load async / value set programmatically — render the label directly in
  `<SelectTrigger>` (fixed in mainline booking dropdowns + SMS receiving).
- **⚠️ NEVER `redirect()` from a page that has a sibling `loading.tsx`** — put
  the redirect in `next.config.ts` `redirects()` instead. `loading.tsx` wraps the
  page in a Suspense boundary, which makes it a STREAMING context, and per the
  Next docs `redirect()` there "will insert a meta tag to emit the redirect on
  the client side" rather than issue an HTTP 307. Re-running the client Router
  against an already-mounted tree changed its internal hook count, so
  `/landed-costs` threw **"Rendered more hooks than during the previous render"**
  on every visit (fixed 2026-09-14; `app/landed-costs/page.tsx` deleted). The
  other index redirects (`/reports`, `/settings`, `/mainline`, `/invoices`, `/`)
  have no `loading.tsx`, get a real 307, and are fine — which is why this was the
  only affected route. A `next.config` redirect runs at step 2 of the routing
  order and `src/proxy.ts` at step 3, so the DESTINATION is still permission-
  gated; nothing is exposed by moving it there.
- **Destructive/consequential actions** get a ConfirmDialog (delete booking/
  shipment, approve booking).
- **Settings page width lives ONCE, in `app/settings/layout.tsx`** (2026-09-16):
  `w-full md:w-[80%] max-w-[1400px] mx-auto`. It was a `max-w-*` class repeated in
  all ten page files, which is exactly how they drifted — Suppliers was sized at
  `max-w-4xl` for four columns and stayed there after growing to seven (two of them
  address textareas), so it scrolled sideways while Warehouses next door had room
  spare. Percentage rather than a fixed cap so the wide tables use the screen, but
  **with a ceiling**: percentage tracks the WINDOW while readability tracks the
  CONTENT, and at 80% of a 2560px monitor the two-column tables (Couriers,
  Incoterms, Modes) would render a ~1900px text input. Full width below `md`.
  A table needing a different width should size its CARD, not re-add a page cap.
- **Master data endpoints:** `/master-data/{suppliers,couriers,incoterms,statuses,
  warehouses,modes}` (RW), `/master-data/{warehouse-facilities,allocation-channels,
  ports,container-types}` (RO), `/master-data/production-schedules` (RW) +
  `POST /master-data/seasons`. Settings pages under `/settings/*`. Always guard
  fetches: `Array.isArray(data) ? data : []`.

## Auth / Users / Roles

- `backend/utils/passwordUtils.js` — **bcrypt since 2026-09-21** (cost 12,
  `BCRYPT_ROUNDS` env-overridable). New hashes are `$2b$…`; anything that is
  neither bcrypt nor scrypt fails closed, so a plaintext value written back into
  the store can never become a working credential.
  **⚠️ THE scrypt BRANCH IS STILL LIVE AND MUST NOT BE DELETED YET.** Every
  account was `scrypt:<salt>:<hash>` at the switch, and bcrypt CANNOT be computed
  from a scrypt hash — it needs the plaintext, which is only ever in hand during
  a successful login. So `authController` re-hashes transparently at that moment
  (guarded by the verify, non-fatal if the write fails), and an account otherwise
  moves only when an admin sets a new password. Deleting the branch early is a
  SILENT lockout: login does not error, it answers 401 for a correct password.
  Run `node scripts/password-status.js` — it is safe to delete only when
  `legacy scrypt` reads 0. That script replaced `scripts/migrate-passwords.js`,
  which hashed into `data/users.json` with `fs` and would now be writing to the
  frozen seed snapshot. There is deliberately no "migrate" mode, because for
  scrypt→bcrypt there cannot be one.
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
  `/freights/*`, `/contacts`, `GET /roles`) take a nav key — verified
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
  throw — a throw would 500 /login too, leaving no way back in). For the DATA the
  API is still the real control, so a forged cookie already 401s every fetch.
- **NAV keys are now ENFORCED on the page itself** (2026-09-08), in that same gate.
  They were documented as "page visibility" but only `Sidebar.can()` read them, so
  unchecking `purchase_orders` for a role hid the link while
  `/mainline/purchase-orders` typed into the address bar still served the full page.
  It has to be enforced HERE: `/po` and `/mainline/*` are deliberately auth-only
  (the Bookings page fetches `/po` + `/po/legs`, so gating those on
  `purchase_orders` breaks Production and Freight Forwarder — see the TIERED note
  above), and this gate is the one choke point every deep link, refresh and client
  navigation passes through. Three parts: **(1)** `lib/pageAccess.ts` holds the
  route→key table AND the sidebar's rows, so nav and gate cannot disagree (they
  did: that divergence *was* the bug) — a page added there is gated and navigable
  in one edit. **(2)** `GET /me` (`controllers/meController`, auth-only, below the
  gate) returns the caller's permissions re-resolved from roles.json per call, via
  the same `utils/rolePermissions.permissionsForRole` that `requirePermission` and
  login use; the gate and the root layout read it through `lib/serverIdentity`
  (3s cache, keyed per token, shared by both). The session cookie's
  `permissions[]` is a login-time SNAPSHOT and is never an access decision — a
  revoked key now applies without logging out, and the nav follows the same
  answer. **(3)** denied → `/no-access` (which itself needs no permission, so it
  cannot loop); `/` and post-login go to `firstAllowedPath()` instead of a
  hardcoded page, or a role without `purchase_orders` would land on the gate.
  `Sidebar.can()` now fails CLOSED with no session (it returned `true`, drawing the
  whole menu — Roles and Users included — for any request whose session cookie was
  missing). Verified: 21 path variants (`//`, `/./`, `/..`, `%70`, case, trailing
  dot, `?_rsc=`) either hit the gate or 404 with no data; permission grant/revoke
  moves nav + page together mid-session; Admin unaffected. **Known limits:** the
  answer can be up to 3s stale, and it is scoped to PAGES — a role without
  `purchase_orders` can still read `/po` with its token, unchanged and by design.
  If `/me` is unreachable the gate logs and lets the request through (fail OPEN)
  rather than locking everyone out of every page during a backend restart.
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

### Starting the backend so it STAYS up

`node server.js &` from an agent shell dies with that shell, which reads later as
"the server is down" with a healthy log and no crash in it. Start it detached:

```powershell
Start-Process node -ArgumentList server.js -WorkingDirectory <repo>\backend `
  -WindowStyle Hidden -RedirectStandardOutput backend\server.out.log `
  -RedirectStandardError backend\server.err.log
```

⚠️ **Then check nothing else is already running it.** Every `server.js` process
starts its OWN cron scheduler (`services/cronJobs.js`), so two of them means two
SMS tracking polls, two SMS NetSuite syncs and two mainline PO syncs — concurrent
writers against one database, each rebuilding tables the other is reading. Four
stale copies were found this way on 2026-09-15. To check and clean:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*server.js*' -and $_.CommandLine -notlike '*next*' } |
  Select-Object ProcessId, CommandLine
```

`backend/server.{out,err}.log` are gitignored.

## Agent File Ownership

| Agent    | Owns                                          | Never touches |
|----------|-----------------------------------------------|---------------|
| frontend | `frontend/tentree-scportal/src/`              | `backend/`    |
| backend  | `backend/server.js`, `backend/modules/`, `backend/models/`, `backend/database/`, `backend/services/` | `frontend/` |
| qa       | Read-only — no writes                         | —             |
