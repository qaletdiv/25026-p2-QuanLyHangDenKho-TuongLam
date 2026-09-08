# SMS Bookings + Booked-Shipment Financials — Build Plan (draft 2026-08-07)

Adds an **optional booking step** to the SMS module and makes a *booked* SMS
shipment behave like a mainline shipment for money: actual freight/duty from the
broker/courier bill, a customs clearance number, and the same landed-cost
relationship — **inside the SMS module**, with no shared transactional tables.

> **STATUS: BUILT 2026-08-07** — all 7 phases landed. Verified: 36/36 backend
> guard checks, 24/24 landed-cost basis checks, 27/27 GUI checks (zero console
> errors). See "Verification" at the end.
>
> ⚠️ This REVERSED a documented invariant. CLAUDE.md and SMS_MODULE_PLAN.md both
> stated the SMS workflow has **no booking step** by design (the vendor enters the
> shipment after handing boxes to the courier). That was correct for the
> courier-only flow; it is now "no booking step **required**". Docs updated in
> phase 7.

## Confirmed decisions (from Lam, 2026-08-07)

1. **Bookings are OPTIONAL.** Existing vendor-entered shipments stay bookingless
   and keep working unchanged (`booking_id IS NULL`). Nothing is backfilled.
2. **Approve creates draft shipment(s)** — one per destination facility, with a
   NULL tracking number; whoever ships fills in courier + tracking later.
3. **Freight & duty on a BOOKED shipment are ACTUALS from the bill** — typed once
   per consignment exactly like mainline. **No rate, no estimate.** Unbooked SMS
   shipments keep today's derived CI × rate estimate.
4. **Vendor submits, Logistics approves** — same shape as mainline bookings.

## Schema (3NF additions to database.dbml)

### New — SMS-owned (no shared transactional tables)

```dbml
Table sms_bookings {                    // courier consignment authorization
  id                varchar [pk]
  booking_number    varchar [unique, not null]   // own sequence (SMS-B-N)
  supplier_id       varchar [ref: > suppliers.id]
  incoterm_id       varchar [ref: > incoterms.id]   // nullable — courier terms often DAP/DDP
  cargo_ready_date  date                            // the SMS CRD (HOD-aligned)
  booking_status_id varchar [ref: > statuses.id]    // statuses WHERE module='sms'
  submitted_at      timestamp
  approved_at       timestamp
}

// Junction (M:N booking ↔ PO-lot). Mirrors mainline_booking_po_legs, but keys on
// (po_number, lot_number): SMS has NO air/sea legs — sms_pos IS the bookable
// grain, so there is no leg surrogate to point at.
Table sms_booking_pos {
  id          varchar [pk]
  booking_id  varchar [ref: > sms_bookings.id]
  po_number   varchar [ref: > sms_pos.po_number]
  lot_number  integer
  units       integer          // BOOKED qty (vs sms_shipment_pos.units = SHIPPED)
  cartons     integer
  weight_kg   decimal
  cbm         decimal

  indexes {
    (booking_id, po_number, lot_number) [unique]
  }
}
```

### Changed — `sms_shipments` gains THREE nullable columns

```dbml
  booking_id           varchar [ref: > sms_bookings.id]  // NULL = vendor-entered (today's flow)
  customs_entry_number varchar                           // clearance number
  duty                 decimal                           // ACTUAL from the bill
  freight              decimal                           // ACTUAL from the bill
```

**Deliberately NOT added: `invoice_value`.** Mainline stores it because a human
types it; SMS already DERIVES CI value as Σ(pcs × unit_price) over
`sms_packing_cartons`. Storing it would duplicate a derivable fact.

### Stays derived — never stored

| Value | Derivation |
|---|---|
| has-a-booking / source | `booking_id IS NULL` — no flag column |
| consignment units/cartons | Σ `sms_shipment_pos` (already true today) |
| booked vs shipped variance | `sms_booking_pos.units` vs `sms_shipment_pos.units` |
| CI value | Σ(pcs × unit_price) over `sms_packing_cartons` |
| freight/duty estimate (unbooked only) | CI value × `landed_cost_rates` |
| per-PO split | CI-value share, largest remainder (`splitByValue`) |
| booking totals | Σ `sms_booking_pos` |

### Why this stays 3NF

- `customs_entry_number`, `duty`, `freight` are single-valued and functionally
  dependent on the shipment key — **one customs entry per physical consignment**,
  the same argument `mainline_shipments` already makes.
- A nullable `booking_id` is an **optional relationship**, not a partial dependency.
- Booked units (booking junction) and shipped units (shipment junction) are two
  **different facts**, not duplication.
- `landed_costs` remains a point-in-time posted snapshot — already documented as
  intentional, with mainline as precedent.
- No booking-derived labels are copied onto the shipment (supplier, CRD, PO
  numbers all stay joins), matching `mainline_bookings`' "no copied labels" rule.

### Uniqueness nuances (guards, not indexes)

- **"A lot is on at most one ACTIVE booking"** must be a controller guard, NOT a
  unique index on `(po_number, lot_number)`: a Cancelled/Rejected booking has to
  leave the lot re-bookable.
- **`tracking_number` unique must tolerate NULL/''.** Draft shipments have no
  tracking number yet, and today's duplicate-tracking rejection in
  `smsShipmentController` would collide on the second draft. Explicitly exempt
  null/empty from the duplicate check.

## Landed-cost relationship

**No schema change to `landed_costs` or the commission tables.** The existing
`(module, shipment_id)` unique index already fits; SMS shipment ids don't change;
already-posted SMS rows are untouched.

**Grain: landed cost keys on the SHIPMENT, never the booking** — one physical
consignment is one customs entry. A booking spanning three tracking numbers is
three customs entries and three `landed_costs` rows. Same as mainline, which also
keys on shipment rather than booking.

**Only the basis changes**, and it's a derivation rule rather than new state:

| Shipment | Basis | Snapshot rate fields |
|---|---|---|
| Booked | ACTUAL freight/duty typed on the shipment | `freight_pct`/`duty_pct` **null** |
| Unbooked | CI value × `landed_cost_rates` | rate snapshot set |

So "actual or estimate?" stays derivable from the posted row — no `basis` column.
`invoice_value` is still snapshotted at posting (the split basis).

Unchanged downstream: per-PO split via `splitByValue` (largest-remainder to cents,
parts sum exactly to the whole), commission from
`landed_cost_commissions_sms`, posting requires uploaded shipping data (needs CI
value), re-post 409s until unposted, estimate-is-final for unbooked SMS.

### Two behaviour changes this forces

1. **Bulk "Post all pending" must skip booked-without-actuals**, or it posts $0.
   A booked shipment with no bill yet surfaces as **Awaiting actual** and is
   excluded from the month-end bulk post. Posting one individually is blocked
   (422) until freight/duty are entered.
2. **NetSuite customs-entry field changes for SMS.** `netsuiteLandedCost.js`
   currently hardcodes `custbody_tt_customs_entry_number` = `"FedEx <tracking>"`.
   It must prefer a real `customs_entry_number` when present, falling back to
   courier+tracking. `custbody16` (shipping method) stays the courier name.

## Backend

Routes under the existing `/sms` mount (`modules/sms/*`), new files
`smsBookingController.js` / `smsBookingService.js` / `smsBookingValidators.js`:

| Method | Route | Notes |
|---|---|---|
| GET | `/sms/bookings` | list + derived season/status/totals; vendor-scoped |
| GET | `/sms/bookings/:id` | header + PO-lot junction + linked shipments |
| POST | `/sms/bookings` | vendor or logistics; guards G1/G2 below |
| PATCH | `/sms/bookings/:id` | edit while Pending only |
| POST | `/sms/bookings/:id/approve` | Logistics/Admin → creates draft shipment(s) |
| POST | `/sms/bookings/:id/reject` | frees the lots for re-booking |
| DELETE | `/sms/bookings/:id` | Pending only; junction cascade |
| PATCH | `/sms/shipments/:id` | **extend**: `customs_entry_number`, `freight`, `duty` |

Guards (mirroring mainline, SMS-flavoured):

- **G1 same-supplier** — a booking's POs must share one supplier.
- **G2 overbooking** — Σ booked for a `(po, lot)` may not exceed ordered minus
  already-booked; 409 + `force_overbook` (same escape hatch as `force_overship`).
- **G3 same-consignment (SMS)** — one destination facility per draft shipment;
  approve splits by facility. Mode isn't a grouping key (courier is always air).
- **Lot-not-double-booked** — the active-booking guard above.
- Existing overship guard on shipments unchanged.

Also: a **new notification type `sms_booking_pending`** (not a reuse of mainline's
`booking_pending` — keeps the modules separate per the standing rule), wired into
`ROLE_RULES`: Admin/Logistics all; Vendor scoped to their supplier.

## Frontend

- **New** `/sms/bookings` list + `[id]` detail + create form
  (`src/modules/sms/components/SmsBookings*.tsx`), reusing the generic
  `DataTable`, `ColumnPicker`, `ConfirmDialog`, `SeasonScopeFilter`. Done-set for
  the Active/All toggle = Approved/Cancelled/Rejected (mirrors mainline bookings).
- **Sidebar**: "SMS Bookings" between SMS Purchase Orders and SMS Shipments; new
  permission key in `PERMISSION_MANIFEST` + role grants.
- **`SmsShipmentDetail`** gains, in this order:
  1. `Booking` cell in Overview → links `/sms/bookings/:id`, `—` when unbooked.
  2. **`Landed Cost — Freight & Duty`** section — Total Freight, Total Duty, Entry
     Number, inline Edit/Save. Identical layout to `ShipmentDetail.tsx:227`.
     Unbooked shipments show the derived estimate read-only, hinted as derived.
  3. `Booked` vs `Shipped` columns in the Contents table (both joined at read).
  - **No Route & Schedule clone** — POL/POD/BL/ETD/ETA/container are ocean facts a
    courier consignment lacks; cloning renders a card of dashes. The thin Schedule
    strip carries CRD/HOD, ship date, delivered-from-tracking.
- **Landed Costs page**: SMS rows gain an *Awaiting actual* state; bulk post skips
  them; the per-PO split table and Preview-NetSuite dialog are unchanged.

## Build phases — ALL ✅ 2026-08-07

1. ~~**Schema + seed**~~ ✅ — dbml tables/columns, `sms_bookings.json` +
   `sms_booking_pos.json` (empty), `module='sms'` booking statuses
   (Pending/Approved/Rejected/Cancelled) as DATA. No migration script: additive,
   nothing to backfill. Verify mainline files md5-unchanged.
2. **Backend bookings CRUD + guards** — routes above, Joi schemas, vendor scope.
   curl-verify each guard branch incl. force_overbook and lot-re-booking after
   reject.
3. **Approve → draft shipment(s)** — facility split, NULL tracking, the
   duplicate-tracking null exemption. Verify a 2-facility booking yields 2 drafts
   and that the existing vendor create/update/delete paths still pass.
4. **Shipment financials** — extend PATCH + validator with
   `customs_entry_number`/`freight`/`duty`; confirm unbooked shipments reject them
   (they have no clearance) or accept-and-ignore — decide at build time.
5. **Landed cost basis** — actual-vs-estimate precedence, null rate snapshot,
   Awaiting-actual state, bulk-post exclusion, individual-post 422. Re-verify the
   split still sums exactly to the whole on a 3-PO booked consignment.
6. **Frontend** — bookings list/detail/form, sidebar + permission, the three
   `SmsShipmentDetail` additions, Landed Costs page state. Playwright-verify via
   `localhost:3000`.
7. **NetSuite + docs** — customs-entry preference in `netsuiteLandedCost.js`
   (preview-only on prod; the live push stays behind `LANDED_COST_NS_PUSH`), then
   update **CLAUDE.md** (SMS section: booking is optional, not absent),
   **SMS_MODULE_PLAN.md** (workflow + phases), and **database.dbml**.

## Doc drift to fix in the same pass

`mainline_shipments.customs_entry_number` exists in the validator, controller, and
`mainline_shipments.json` data but is **missing from database.dbml** — which the
conventions call authoritative. Add it while editing the file.

## Postgres-migration notes (JSON-stack limits — fix AT migration)

- **Approve → N draft shipments is a multi-file write** (`sms_bookings` +
  `sms_shipments` + `sms_shipment_pos`) with no transaction; a crash mid-way
  leaves partial state. Same class as the existing booking-approve and
  shipment-data paths. → DB transaction.
- `booking_number` sequence via `Math.max(n)+1` races under concurrency. → SERIAL.
- The lot-not-double-booked and G2 guards are read-then-write; concurrent submits
  can both pass. → unique partial index (`WHERE status IN ('Pending','Approved')`)
  plus the row-level check.

## Decisions taken during the build (the plan's open items)

- **Approving over already-shipped lots is BLOCKED (409).** Bookings are forward
  authorizations, so they cannot be retro-fitted onto the 35 existing SMS
  shipments. Re-booking a shipped lot is refused for the same reason.
- **Actual freight/duty are Logistics-only** — a Vendor PATCHing them gets 403.
  Broker bills are not vendor-facing.
- **CI/PL generation stays on the shipment** (unchanged). A booking authorizes; the
  documents describe what physically shipped.
- **`cancel` was added mid-build.** The delete guard's own error text said "reject or
  cancel it" and no cancel existed — an approved booking had no way out. It deletes
  the untracked drafts and 409s once anything shipped.

## Two pre-existing bugs found and fixed on the Landed Costs page

Both were latent before this work but became reachable with drafts:

1. **"All months" was a no-op.** `effMonth` coerced `'all'` back to `months[0]`, so
   picking it silently kept the newest month. Now `'all'` genuinely means all, and
   the newest month is the *default* instead.
2. **Shipments with no packing file vanished entirely.** The table flat-maps
   `row.split`, which is empty until CI value exists, so those rows produced zero
   lines — making the existing "No shipping data" badge unreachable. Now a
   zero-amount placeholder line per PO keeps the row visible with the explanatory
   status. NetSuite payloads still come from the real server-side split, so nothing
   zero-valued can be pushed.

Plus a new **"Unscheduled"** month bucket: a draft has no ship date, so it belongs
to no month-end batch and would otherwise be unreachable from the month dropdown.

## Verification

- **Backend guards — 36/36** (`test-sms-bookings.js`): G1/G2 (+force)/G3, hard lot
  conflict, reject-frees-the-lot, approve→one draft with `booked_units` carried,
  re-approve/late-edit/delete-approved blocked, financials accepted on booked and
  refused (400) on unbooked, draft accepts a tracking number, re-booking a shipped
  lot 409s, cancel blocked while shipped then deletes the draft, state restored.
- **Landed-cost basis — 24/24** (`test-lc-basis.js`): unbooked = estimate basis and
  its split sums to the estimate; booked = actual basis, ignores the rate, 422 while
  awaiting the bill, then apportions $900.00/$450.25 EXACTLY across POs; preview
  uses the real entry number while unbooked keeps the courier+tracking fallback.
  Ran end-to-end against the real `PO04799-shipment-data-lot2.xlsx` (CI $221.12).
- **GUI — 27/27, zero console errors** (`verify-sms-booking-ui.js`): tab strip,
  create dialog → destination → PO units → submit, Pending → Approve → draft
  consignment, shipment detail (Draft badge, Booking link, Landed Cost block,
  Booked-vs-Shipped), inline actuals save and display, Landed Costs visibility +
  Unscheduled bucket, cleanup.
