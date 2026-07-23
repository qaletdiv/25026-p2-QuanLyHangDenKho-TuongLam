# SMS / Mainline Backend Coupling Audit

**Scope:** `backend/` controllers, services, models, validators, routes, server.js.
**Read-only analysis — no files modified.**
**Date:** 2026-06-24

> **Alignment update (2026-06-24) — direction agreed after this audit:**
> - **Build mainline first; SMS is a later pass.** SMS is treated as a *totally
>   separate module* and is NOT built alongside mainline. The `sms/` tree below is
>   retained as the eventual target, but is deferred — do not create `sms_*` tables
>   or controllers yet.
> - **PO ingestion now has a defined ownership split** (not covered in the original
>   audit — it predates the TRN hierarchy decision). The new schema
>   (`backend/database.dbml`, `backend/SCHEMA_REDESIGN.md`) keys POs as
>   `po_masters (TRN) → po_orders (po_number) → mainline_po_legs (NK po_number,mode,crd)`:
>     - `integrationController` (NetSuite sync) owns `po_masters`, `po_orders`, `po_order_lines`.
>     - `wipImportController` (WIP upload) owns `mainline_po_legs`, `mainline_po_leg_lines`.
>     - They write **different tables**, so the legacy "preserve portal fields / splice
>       Mixed rows" logic in `wipImportController` is removed. Ingestion rules R1–R3
>       (protect-if-booked / flag-on-conflict / WIP-overwrites) live in those controllers.
> - The `type` discriminator disappears; `purchaseOrderController.enrichPo`'s
>   `s.type==='sms'` branch (#10) goes away once shipments are split by table.
>
> Everything below documents the **current (as-is) coupling** and remains accurate.

## Executive Summary

SMS and mainline are **not separate modules today**. They are the *same* code paths,
data files, models, routes, and validators, discriminated at runtime by a single
`type: "sms" | "mainline"` string field stored on booking and shipment rows.

- **Shared data files:** both write to the SAME `bookings.json` and `shipments.json`. There is no `sms_bookings.json` / `mainline_shipments.json`.
- **Shared routes:** ONE endpoint set (`/bookings`, `/shipments`) serves both. No `/sms/*` namespace exists on the backend (the namespacing is frontend-only, via Next.js routes).
- **Shared validators:** one Joi schema validates both; `type` is just an enum field.
- **The ONLY real fork in backend logic** is a single `if` branch in `bookingController.create()` (the SMS auto-approve-to-shipment fast path vs. the mainline pending-booking path). Everything else (`update`, `remove`, fulfillment, status sync, reports, ASN, enrichment) is type-agnostic and operates on the merged dataset.

**Total shared touchpoints: 14** (across 9 files). Of these, **2 contain genuine type-specific branches** (`bookingController.create`, `purchaseOrderController.enrichPo`); the rest are type-blind code that simply happens to process both kinds of rows from the same store.

---

## (a) Shared Touchpoints Table

| # | File | Function / location | Line(s) | What is shared / branches |
|---|------|---------------------|---------|---------------------------|
| 1 | `controllers/bookingController.js` | `create()` | 199–302 (SMS) vs 304–382 (mainline) | **THE core fork.** `typeLower === 'sms' \|\| (mode === 'Courier' && type !== 'mainline')` → SMS path: writes booking with `booking_status: 'Booking Approved'`, immediately creates shipment rows (`type:'sms'`, `status:'Ready to Ship'`), stamps POs. Else → mainline path: writes booking `Booking Pending`, NO shipment rows yet (created later on approval). Both share `_resolvePoIds`, G1 vendor-match, G2 overbooking, lot calc. |
| 2 | `controllers/bookingController.js` | `update()` approval block | 416–457 | Type-agnostic. On `Booking Approved`, creates shipment rows for any booking. Copies `type: booking.type \|\| 'mainline'` onto each shipment (line 448) — same code for both. This is where **mainline** bookings get their shipment rows (SMS already got them at create). |
| 3 | `controllers/bookingController.js` | `remove()` | 472–520 | Type-agnostic. Deletes linked shipment rows by `booking_number` and resets PO status for both kinds. |
| 4 | `controllers/bookingController.js` | `create()` G2 overbooking | 206–240 (SMS) & 309–339 (mainline) | Two near-duplicate overbooking guards. SMS variant additionally sums `mainlineBooked` from the bookings table + `alreadyShipped` from shipments; mainline variant sums only booked units. Logic forked but conceptually parallel. |
| 5 | `services/bookingService.js` | `syncPoStatus()` | 10–61 | Type-agnostic. Resolves PO refs via shipment rows OR (for mainline pre-approval) booking `po_details`. Comment at line 20 ("mainline bookings before approval, no shipment rows yet") is the only acknowledgement of the difference. Operates on merged data. |
| 6 | `services/bookingService.js` | `recalcBookingStatus()` | 68–107 | Type-agnostic. Aggregates booking status from linked shipment rows regardless of type. |
| 7 | `services/bookingService.js` | `enrichBookings()` | 113–153 | Type-agnostic. Passes `type` through from booking or PO (line 145) but does not branch. |
| 8 | `services/shipmentService.js` | `enrichShipments()` | 7–25 | Type-agnostic. Joins shipment→PO on `po_id`/`po_number`. Carries `courier` (line 22) for both types; no branch. |
| 9 | `controllers/shipmentController.js` | entire file (`getAll/getOne/create/update/remove/bulkStatus`) | 12–90 | **Fully type-blind.** Reads/writes the single `shipments.json`. SMS and mainline shipment rows are indistinguishable to this controller except by their stored `type` field. `bulkStatus` updates all rows for a `booking_number` irrespective of type. |
| 10 | `controllers/purchaseOrderController.js` | `enrichPo()` booked_qty | 44–47 | **Branch:** `if (s.type === 'sms') totalBooked += expected_quantity` — SMS bookings "bypass the bookings table" so their booked units are summed from shipment rows instead of `po_details`. Mainline booked units come from the bookings table (lines 34–43). |
| 11 | `controllers/purchaseOrderController.js` | fulfillment endpoint | 275–292+ | Type-agnostic. Sums `shipped_qty` from ALL confirmed booking CIs matching the PO, regardless of booking type. |
| 12 | `controllers/reportController.js` | `getReports()` | 12–41 | Type-agnostic. Merges active+history shipments; emits `type` (line 23) and `courier` (line 25) as plain fields. No branch — both kinds appear in one report list. |
| 13 | `controllers/asnController.js` | `generateAsn()` delivery-date gate | 43–60 | Type-agnostic with a comment noting the semantic difference: gate requires `s.e_del \|\| s.eta` ("E-DEL for mainline, ETA for SMS/courier"). One predicate covers both. |
| 14 | `validators/booking.js` + `validators/shipment.js` | `create` / `update` schemas | booking 27,36; shipment 8–9,22 | **One schema validates both.** `type: Joi.valid('mainline','sms')`. Shipment validator merges `MAINLINE_STATUSES` + `SMS_STATUSES` into one `ALL_STATUSES` enum (lines 3–9) so any status from either domain passes for either type. |

**Routes (server.js 22–23):** `/shipments` and `/bookings` are each mounted ONCE. `routes/bookings.js` and `routes/shipments.js` define no type-specific endpoints — discrimination is entirely via the `type` field in the request body. There is **no** `/bookings/sms` or `/shipments/mainline` on the backend.

**Data layer:** `models/ShipmentModel.js` → `shipments.json`; `models/BookingModel.js` → `bookings.json`; `HistoryModel` → `history.json` + `history-bookings.json`. All four files hold BOTH types intermixed.

---

## (b) Recommended Target Module Structure (PostgreSQL)

Split into two parallel, independent module trees plus a shared kernel. Each module owns its own table, controller, model, routes, validator, and service. **Sequencing per the alignment update: build the `mainline/` tree + shared kernel now; the `sms/` tree is deferred to a later pass** (shown here as the eventual target only).

```
backend/
  modules/
    mainline/
      mainlineBookingController.js     # create (always → Pending), approve → mainline shipments
      mainlineShipmentController.js    # getAll/getOne/update/remove/bulkStatus on mainline_shipments
      MainlineBookingModel.js          # table: mainline_bookings
      MainlineShipmentModel.js         # table: mainline_shipments
      routes/mainlineBookings.js       # POST /mainline/bookings ...
      routes/mainlineShipments.js      # /mainline/shipments ...
      validators/mainlineBooking.js    # MAINLINE_STATUSES only
      validators/mainlineShipment.js   # MAINLINE_STATUSES only (no courier/tracking fields)
      mainlineBookingService.js        # syncPoStatus / recalc / enrich scoped to mainline tables

    sms/
      smsBookingController.js          # create → auto-approve + immediate shipment rows
      smsShipmentController.js         # getAll/getOne/update/remove on sms_shipments
      SmsBookingModel.js               # table: sms_bookings
      SmsShipmentModel.js              # table: sms_shipments (carries courier, tracking_number)
      routes/smsBookings.js            # POST /sms/bookings ...
      routes/smsShipments.js           # /sms/shipments ...
      validators/smsBooking.js         # SMS_STATUSES only
      validators/smsShipment.js        # SMS_STATUSES + courier/tracking required-ish

  shared/   (genuinely cross-cutting — see (c))
    services/lotService.js
    services/ciParser.js, ciGenerator.js, plGenerator.js, asnService.js
    services/poFulfillmentService.js   # reads from BOTH sms + mainline CIs to compute shipped_qty
    middleware/, utils/, driveStorage.js
    models/PurchaseOrderModel.js, MasterDataModel.js
```

### Target tables

| Table | Replaces today's | Notes |
|-------|------------------|-------|
| `mainline_bookings` | `bookings.json` rows where `type='mainline'` | no `courier` column |
| `sms_bookings` | `bookings.json` rows where `type='sms'` | always created Approved |
| `mainline_shipments` | `shipments.json` rows where `type='mainline'` | FK `mainline_booking_id`, `po_id` |
| `sms_shipments` | `shipments.json` rows where `type='sms'` | FK `sms_booking_id`, `po_id`, plus `courier`, `tracking_number` |

The `type` discriminator **column disappears** — table membership replaces it.

### How the split removes each branch

- **#1 / #4 (create fork):** the `if (type==='sms')` vanishes — `smsBookingController.create` IS the SMS path, `mainlineBookingController.create` IS the mainline path. No runtime test.
- **#10 (booked_qty fork):** `poFulfillmentService` computes `booked_qty` as `SUM(mainline po_details units) + SUM(sms_shipments expected_quantity)` by querying the two tables explicitly — no `s.type==='sms'` test, the source table is the discriminator.
- **#14 (validators):** `MAINLINE_STATUSES` and `SMS_STATUSES` stop being unioned; each module validates only its own status set, so an SMS-only status can no longer pass for a mainline shipment.
- **Routes:** `/mainline/bookings`, `/mainline/shipments`, `/sms/bookings`, `/sms/shipments` — frontend's existing `/{mainline,sms}/*` namespacing now maps 1:1 to backend endpoints.

---

## (c) Shared vs. Must-Split

### MUST split (currently coupled, become per-module)
- `bookingController` → `mainlineBookingController` + `smsBookingController` (the create fork)
- `shipmentController` → `mainlineShipmentController` + `smsShipmentController`
- `BookingModel` / `ShipmentModel` → 4 type-specific models/tables
- `bookingService` (`syncPoStatus`, `recalcBookingStatus`, `enrichBookings`) → per-module, since they read/write the type-specific tables
- `validators/booking.js`, `validators/shipment.js` → per-module schemas (split the status enums)
- routes `bookings.js`, `shipments.js` → 4 route files under the two module trees
- `enrichShipments` (shipmentService) → per-module enrich (mainline drops courier)

### SHOULD stay shared (genuinely cross-cutting — do NOT duplicate)
- **Auth & RBAC:** `middleware/auth.js`, `requireAdmin.js`, `authController`, `roleController`, `userController` — identity is module-agnostic.
- **Master data:** `masterDataController`, `MasterDataModel`, `routes/masterData.js` — warehouses, suppliers, couriers, incoterms, statuses serve both.
- **Purchase Orders:** `PurchaseOrderModel`, `purchaseOrderController` (PO CRUD + NetSuite sync) — POs are upstream of both modules. **Exception:** the fulfillment/booked_qty computation must become a shared service that explicitly reads both module tables (it is the one place that legitimately aggregates across both).
- **Document generation:** `ciParser`, `ciGenerator`, `plGenerator`, `asnService`/`asnController`, `lotService` — pure transforms over CI/shipment data; parameterize by the calling module rather than fork. (ASN's delivery-date gate stays one predicate: `e_del || eta`.)
- **Infrastructure:** `driveStorage.js`, `passwordUtils.js`, `errorHandler`, `validate.js` middleware, `cronJobs`, `integrationService`/`integrationController` (NetSuite), WIP/freight import services.
- **Reports/forecast:** keep as a shared reporting layer that UNIONs both module tables (it is inherently a cross-module read; reports want SMS + mainline in one view).

### The one nuance
`purchaseOrderController.enrichPo` and the fulfillment endpoint are the **only** places that legitimately need to see both SMS and mainline at once (PO-level rollup). In the split, these belong to the shared PO module and must query both `sms_*` and `mainline_*` tables — that is correct cross-module aggregation, not coupling to remove.
